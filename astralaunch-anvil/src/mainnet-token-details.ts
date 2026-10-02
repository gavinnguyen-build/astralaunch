// Set a token's X account / website on the Astralaunch server (POST /api/tokens), signed by the token's ON-CHAIN
// creator with the shared token metadata message (D-SV1 addendum). Only the fields you set are sent and changed.
// The token image and brief description are set once at launch (launch-details) and cannot be changed here.
//
//   ASSET=0x... WEBSITE=https://example.com SERVER_URL=https://api.astralaunch.xyz \
//   CREATOR_KEYSTORE=<foundry account> npx tsx src/mainnet-token-details.ts [--yes]
//
// Env:
//   ASSET                          required
//   X_HANDLE, WEBSITE              at least one
//   CREATOR_KEYSTORE               Foundry keystore name/path of the token's on-chain creator (hidden password
//                                  prompt, or CREATOR_KEYSTORE_PASSWORD_FILE); or CREATOR_PRIVATE_KEY
//   SERVER_URL                     default http://localhost:3001
//   ALLOW_ANVIL_KEYS=1             local fork only

import { getAddress, isAddress } from 'viem';
import { tokenMetadataMessage, tokenMetadataSchema } from '../../packages/shared/src/index.js';
import { accountFromEnv, confirm, need, readBody, run, show } from './mainnet-cli.js';

run(async () => {
  const server = (process.env.SERVER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const assetRaw = need('ASSET');
  if (!isAddress(assetRaw)) throw new Error(`ASSET is not an address: ${assetRaw}`);
  const asset = assetRaw.toLowerCase() as `0x${string}`;

  if (process.env.DESCRIPTION !== undefined || process.env.IMAGE_URL !== undefined || process.env.IMAGE_HASH !== undefined) {
    throw new Error('The token image and description are set once at launch and cannot be changed afterwards.');
  }
  const fields = {
    asset,
    ...(process.env.X_HANDLE ? { xHandle: process.env.X_HANDLE } : {}),
    ...(process.env.WEBSITE ? { website: process.env.WEBSITE } : {}),
  };
  if (Object.keys(fields).length === 1) throw new Error('Set at least one of X_HANDLE, WEBSITE.');

  const account = await accountFromEnv('CREATOR_PRIVATE_KEY');
  console.log(`Server:  ${server}`);
  console.log(`Signer:  ${account.address}`);

  const tokenRes = await fetch(`${server}/api/tokens/${asset}`);
  if (!tokenRes.ok) throw new Error(`GET /api/tokens/${asset} → ${tokenRes.status}: ${JSON.stringify(await readBody(tokenRes))}`);
  const token = await tokenRes.json() as { symbol: string; name: string; creator: string };
  console.log(`Token:   ${token.symbol} (${token.name}) ${asset}`);
  if (getAddress(token.creator) !== getAddress(account.address)) {
    throw new Error(`The signer is ${account.address}, but the token's on-chain creator is ${token.creator}. The server would reject with 403.`);
  }

  const m = { ...fields, issuedAt: Math.floor(Date.now() / 1000) };
  const message = tokenMetadataMessage(m);
  const body = { ...m, signature: await account.signMessage({ message }) };
  tokenMetadataSchema.parse(body);
  console.log(`\nSigned message (personal_sign):\n${message}`);
  show(`POST ${server}/api/tokens`, body);
  await confirm(`Send this POST to ${server}?`);

  const res = await fetch(`${server}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  show(`Response ${res.status}`, await readBody(res));
  if (!res.ok) throw new Error(`POST failed with ${res.status}`);
});
