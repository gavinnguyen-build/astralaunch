// Shared helpers for the mainnet CLI scripts (mainnet-register-service.ts, mainnet-pay.ts).
// Private keys are only ever turned into viem accounts here; they are never printed.

import { createInterface } from 'node:readline';
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

/**
 * Account from a private-key env var. Anvil dev keys are refused unless
 * ALLOW_ANVIL_KEYS=1 (only for the local fork; CLAUDE.md rule 15).
 */
export function accountFromEnv(key: string): PrivateKeyAccount {
  const raw = need(key).trim();
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
