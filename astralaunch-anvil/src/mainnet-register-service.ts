// Register (or update) an x402 service for a token on the Astralaunch server.
// Signed by the token's ON-CHAIN creator with the shared messages (D-SV1).
//
//   read -s CREATOR_PRIVATE_KEY && export CREATOR_PRIVATE_KEY
//   ASSET=0x... SLUG=nullsight UPSTREAM_URL=https://api.example.com PRICE_USDC=0.01 \
//   SERVER_URL=http://localhost:3001 \
//     npx tsx src/mainnet-register-service.ts [--yes]
//
// Env:
//   ASSET, SLUG, UPSTREAM_URL      required
//   PRICE_USDC                     human USDC (e.g. 0.01), not raw units. Required to create; on an update,
//                                  omit it to keep the current price
//   UPSTREAM_URL                   may carry a path prefix (e.g. http://127.0.0.1:4001/sight): the gateway maps
//                                  /s/{slug}/<path> to <UPSTREAM_URL>/<path> and never leaves the prefix
//   CREATOR_KEYSTORE               Foundry keystore name/path of the token's on-chain creator (hidden password
//                                  prompt, or CREATOR_KEYSTORE_PASSWORD_FILE); or CREATOR_PRIVATE_KEY
//   SCHEMA                         optional request JSON schema: inline JSON or a path to a .json file
//   RESPONSE_SCHEMA                optional response JSON schema: inline JSON or a path to a .json file
//   NAME, DESCRIPTION, TIMEOUT_SECONDS   optional (NAME defaults to SLUG)
//   SERVER_URL                     default http://localhost:3001
//   ALLOW_HIGH_PRICE=1             allow PRICE_USDC > 100
//   ALLOW_ANVIL_KEYS=1             local fork only
//
// If SLUG already exists for ASSET, a signed PATCH updates price / upstream / description / timeout
// (name and schema cannot be changed by PATCH).

import { existsSync, readFileSync } from 'node:fs';
import { formatUnits, getAddress, isAddress, parseUnits } from 'viem';
import {
  createServiceSchema,
  serviceCreateMessage,
  serviceUpdateMessage,
  updateServiceSchema,
} from '../../packages/shared/src/index.js';
import { accountFromEnv, confirm, need, readBody, run, show } from './mainnet-cli.js';

const MAX_PRICE_USDC = 100n * 10n ** 6n;

function loadSchema(env: 'SCHEMA' | 'RESPONSE_SCHEMA'): string | undefined {
  const raw = process.env[env];
  if (!raw) return undefined;
  const text = existsSync(raw) ? readFileSync(raw, 'utf8') : raw;
  try { return JSON.stringify(JSON.parse(text)); } catch { throw new Error(`${env} must be valid JSON (inline or a path to a .json file)`); }
}

run(async () => {
  const server = (process.env.SERVER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const assetRaw = need('ASSET');
  if (!isAddress(assetRaw)) throw new Error(`ASSET is not an address: ${assetRaw}`);
  const asset = assetRaw.toLowerCase() as `0x${string}`;
  const slug = need('SLUG');
  const upstreamUrl = need('UPSTREAM_URL');
  const priceHuman = process.env.PRICE_USDC || undefined;
  if (priceHuman !== undefined && !/^\d+(\.\d{1,6})?$/.test(priceHuman)) throw new Error('PRICE_USDC must be a decimal USDC amount like 0.01');
  const priceRaw = priceHuman !== undefined ? parseUnits(priceHuman, 6) : undefined;
  if (priceRaw === 0n) throw new Error('PRICE_USDC must be > 0');
  if (priceRaw !== undefined && priceRaw > MAX_PRICE_USDC && process.env.ALLOW_HIGH_PRICE !== '1') {
    throw new Error(`PRICE_USDC ${priceHuman} is above ${formatUnits(MAX_PRICE_USDC, 6)} USDC per call. Set ALLOW_HIGH_PRICE=1 if intended.`);
  }
  const requestSchema = loadSchema('SCHEMA');
  const responseSchema = loadSchema('RESPONSE_SCHEMA');
  const timeoutSeconds = process.env.TIMEOUT_SECONDS ? Number(process.env.TIMEOUT_SECONDS) : undefined;
  const description = process.env.DESCRIPTION || undefined;
  const account = await accountFromEnv('CREATOR_PRIVATE_KEY');

  console.log(`Server:  ${server}`);
  console.log(`Signer:  ${account.address}`);

  // ── Token must be registered + listed, and the signer must be its on-chain creator ──
  const tokenRes = await fetch(`${server}/api/tokens/${asset}`);
  if (tokenRes.status === 404) {
    throw new Error(`Token ${asset} is not visible on ${server}: not registered/indexed yet, or not listed (launch fee not paid and consumed).`);
  }
  if (!tokenRes.ok) throw new Error(`GET /api/tokens/${asset} → ${tokenRes.status}: ${JSON.stringify(await readBody(tokenRes))}`);
  const token = await tokenRes.json() as { symbol: string; name: string; creator: string; router: string };
  console.log(`Token:   ${token.symbol} (${token.name}) ${asset}`);
  console.log(`Creator: ${token.creator} (on-chain)   Router: ${token.router}`);
  if (getAddress(token.creator) !== getAddress(account.address)) {
    throw new Error(`CREATOR_PRIVATE_KEY is ${account.address}, but the token's on-chain creator is ${token.creator}. The server would reject with 403.`);
  }

  // ── Create or update? ──
  const manRes = await fetch(`${server}/api/services/${encodeURIComponent(slug)}/manifest`);
  type Manifest = { id: string; asset: string; payment: { amount: string } };
  let existing: Manifest | null = null;
  if (manRes.ok) existing = await manRes.json() as Manifest;
  else if (manRes.status !== 404) throw new Error(`GET manifest → ${manRes.status}: ${JSON.stringify(await readBody(manRes))}`);
  if (existing && !existing.id) throw new Error('Server manifest has no service id; update the server first.');
  if (existing && existing.asset.toLowerCase() !== asset) {
    throw new Error(`Slug "${slug}" is already used by another token (${existing.asset}). Pick another SLUG.`);
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  let method: 'POST' | 'PATCH';
  let url: string;
  let message: string;
  let body: Record<string, unknown>;

  if (!existing) {
    if (priceRaw === undefined) throw new Error('PRICE_USDC is required to create a service');
    const fields = {
      asset, slug, name: process.env.NAME || slug, upstreamUrl, priceUsdc: priceRaw.toString(),
      ...(requestSchema !== undefined && { requestSchema }),
      ...(responseSchema !== undefined && { responseSchema }),
      ...(timeoutSeconds !== undefined && { timeoutSeconds }),
      ...(description !== undefined && { description }),
      issuedAt,
    };
    message = serviceCreateMessage(fields);
    body = { ...fields, signature: await account.signMessage({ message }) };
    createServiceSchema.parse(body);
    method = 'POST';
    url = `${server}/api/services`;
    console.log(`\nAction:  CREATE service "${slug}"`);
  } else {
    if (process.env.NAME || requestSchema || responseSchema) console.log('\nNOTE: NAME, SCHEMA and RESPONSE_SCHEMA cannot be changed on an existing service; they are ignored.');
    const fields = {
      ...(priceRaw !== undefined && { priceUsdc: priceRaw.toString() }), upstreamUrl,
      ...(timeoutSeconds !== undefined && { timeoutSeconds }),
      ...(description !== undefined && { description }),
      issuedAt,
    };
    message = serviceUpdateMessage(existing.id, asset, fields);
    body = { ...fields, signature: await account.signMessage({ message }) };
    updateServiceSchema.parse(body);
    method = 'PATCH';
    url = `${server}/api/services/${existing.id}`;
    const cur = formatUnits(BigInt(existing.payment.amount), 6);
    console.log(`\nAction:  UPDATE service "${slug}" (id ${existing.id}); price ${priceHuman !== undefined ? `${cur} → ${priceHuman}` : `${cur} (unchanged)`} USDC`);
    console.log(`Upstream: ${upstreamUrl}`);
  }

  if (priceRaw !== undefined) console.log(`Price:   ${priceHuman} USDC per call (${priceRaw} raw, 6 decimals)`);
  console.log(`\nSigned message (personal_sign):\n${message}`);
  show(`${method} ${url}`, body);
  await confirm(`Send this ${method} to ${server}?`);

  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const resBody = await readBody(res);
  show(`Response ${res.status}`, resBody);
  if (!res.ok) throw new Error(`${method} failed with ${res.status}`);
  console.log(`\nOK. Gateway endpoint: ${server}/s/${slug}/`);
});
