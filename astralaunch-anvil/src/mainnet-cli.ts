// Shared helpers for the mainnet CLI scripts (mainnet-register-service.ts, mainnet-pay.ts).
// Private keys are only ever turned into viem accounts here; they are never printed.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { decryptKeystore, keystorePath, readKeystore } from './keystore.js';
import { getAddress, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

export const YES = process.argv.includes('--yes');

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const ANVIL_ADDRESSES = new Set(
  Array.from({ length: 10 }, (_, i) => getAddress(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address)),
);

/** Read a line from the TTY without echoing it. */
async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('No TTY for the keystore password; set *_KEYSTORE_PASSWORD_FILE instead.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (!muted) process.stdout.write(s);
  };
  const answer = new Promise<string>((r) => rl.question(question, r));
  muted = true;
  const pw = await answer;
  rl.close();
  process.stdout.write('\n');
  return pw;
}

/**
 * Account for a role. Either a Foundry keystore (`<ROLE>_KEYSTORE` = account name in
 * ~/.foundry/keystores or a path; password from `<ROLE>_KEYSTORE_PASSWORD_FILE` or a hidden prompt)
 * or a raw key in `<ROLE>_PRIVATE_KEY`. Anvil dev keys are refused unless ALLOW_ANVIL_KEYS=1
 * (only for the local fork; CLAUDE.md rule 15). Keys are never printed.
 */
export async function accountFromEnv(key: `${string}_PRIVATE_KEY`): Promise<PrivateKeyAccount> {
  const role = key.replace(/_PRIVATE_KEY$/, '');
  const ks = process.env[`${role}_KEYSTORE`];
  let raw: string;
  if (ks) {
    if (process.env[key]) throw new Error(`Set only one of ${role}_KEYSTORE and ${key}.`);
    const pwFile = process.env[`${role}_KEYSTORE_PASSWORD_FILE`];
    const password = pwFile
      ? readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '')
      : await promptHidden(`Password for keystore ${keystorePath(ks)}: `);
    raw = decryptKeystore(readKeystore(ks), password);
  } else {
    raw = need(key).trim();
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${key} must be a 0x-prefixed 32-byte hex private key`);
  const account = privateKeyToAccount(raw as Hex);
  if (ANVIL_ADDRESSES.has(getAddress(account.address)) && process.env.ALLOW_ANVIL_KEYS !== '1') {
    throw new Error(`${key} is an Anvil dev key (${account.address}). Refusing; set ALLOW_ANVIL_KEYS=1 only on a local fork.`);
  }
  return account;
}

/** Print a JSON block, with bigint support. */
export function show(label: string, data: unknown) {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

/** Require the operator to type "yes" (skipped with --yes). */
export async function confirm(question: string): Promise<void> {
  if (YES) {
    console.log(`\n${question} --yes given, proceeding.`);
    return;
  }
  if (!process.stdin.isTTY) throw new Error('No TTY for confirmation; re-run with --yes to proceed non-interactively.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(`\n${question} Type "yes" to continue: `, r));
  rl.close();
  if (answer.trim() !== 'yes') throw new Error('Aborted by operator.');
}

/** Read a response as JSON if possible, else text. */
export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export function run(main: () => Promise<void>) {
  main().catch((e) => {
    console.error(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
