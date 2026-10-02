// Set a token's display details on the Astralaunch server (POST /api/tokens), signed by the token's ON-CHAIN creator
// with the shared token metadata message (D-SV1 addendum). Only the fields you set are sent and changed.
//
//   ASSET=0x... DESCRIPTION='What the agent does' SERVER_URL=https://api.astralaunch.xyz \
//   CREATOR_KEYSTORE=<foundry account> npx tsx src/mainnet-token-details.ts [--yes]
//
// Env:
//   ASSET                          required
//   DESCRIPTION                    brief description, plain text, ≤ 200 characters (HTML is stripped); '' clears it
//   X_HANDLE, WEBSITE, IMAGE_URL   optional
//   CREATOR_KEYSTORE               Foundry keystore name/path of the token's on-chain creator (hidden password
//                                  prompt, or CREATOR_KEYSTORE_PASSWORD_FILE); or CREATOR_PRIVATE_KEY
//   SERVER_URL                     default http://localhost:3001
//   ALLOW_ANVIL_KEYS=1             local fork only

import { getAddress, isAddress } from 'viem';
import { cleanTokenDescription, TOKEN_DESCRIPTION_MAX, tokenMetadataMessage, tokenMetadataSchema } from '../../packages/shared/src/index.js';
import { accountFromEnv, confirm, need, readBody, run, show } from './mainnet-cli.js';

run(async () => {
  const server = (process.env.SERVER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const assetRaw = need('ASSET');
  if (!isAddress(assetRaw)) throw new Error(`ASSET is not an address: ${assetRaw}`);
  const asset = assetRaw.toLowerCase() as `0x${string}`;

  // Sign the cleaned text, so that what is signed is exactly what the server stores and shows.
  const description = process.env.DESCRIPTION === undefined ? undefined : cleanTokenDescription(process.env.DESCRIPTION);
  if (description !== undefined && description.length > TOKEN_DESCRIPTION_MAX) {
    throw new Error(`DESCRIPTION is ${description.length} characters; the limit is ${TOKEN_DESCRIPTION_MAX}.`);
  }
  const fields = {
    asset,
    ...(process.env.IMAGE_URL ? { imageUrl: process.env.IMAGE_URL } : {}),
    ...(process.env.X_HANDLE ? { xHandle: process.env.X_HANDLE } : {}),
    ...(process.env.WEBSITE ? { website: process.env.WEBSITE } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  if (Object.keys(fields).length === 1) throw new Error('Set at least one of DESCRIPTION, X_HANDLE, WEBSITE, IMAGE_URL.');

  const account = await accountFromEnv('CREATOR_PRIVATE_KEY');
  console.log(`Server:  ${server}`);
  console.log(`Signer:  ${account.address}`);

  const tokenRes = await fetch(`${server}/api/tokens/${asset}`);
  if (!tokenRes.ok) throw new Error(`GET /api/tokens/${asset} → ${tokenRes.status}: ${JSON.stringify(await readBody(tokenRes))}`);
  const token = await tokenRes.json() as { symbol: string; name: string; creator: string; description: string | null };
  console.log(`Token:   ${token.symbol} (${token.name}) ${asset}`);
  if (getAddress(token.creator) !== getAddress(account.address)) {
    throw new Error(`The signer is ${account.address}, but the token's on-chain creator is ${token.creator}. The server would reject with 403.`);
  }
  if (description !== undefined) console.log(`Description: ${JSON.stringify(token.description)} → ${JSON.stringify(description)} (${description.length}/${TOKEN_DESCRIPTION_MAX})`);

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
