/**
 * Token rows come from chain, never from a client call (docs/decisions.md D-TK1).
 *
 * The indexer (on each Registered event) and the one-off backfill script both
 * call upsertTokenFromRegistration. It is idempotent: re-indexing refreshes the
 * on-chain fields and never touches creator-signed metadata.
 *
 * Pure DB + chain-reader logic: no env imports, so the indexer can share it.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { idxRegistrations, tokens } from '../db/schema.js';
import type { Db } from './launchFee.js';

export interface Erc20Meta {
  name:     string;
  symbol:   string;
  decimals: number;
}

export interface RegistrationForToken {
  asset:       string;  // lowercase
  creator:     string;  // Registered.creator (fee recipient / vesting beneficiary)
  launcher:    string;  // register() tx sender ('' if unknown)
  router:      string;
  poolId:      string;
  numeraire:   string;
  initializer: string;
  txHash:      string;
  blockNumber: bigint;
  timestamp:   bigint;  // register block timestamp (s)
}

const erc20MetaAbi = [
  { type: 'function', name: 'name',     stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** Structural subset of viem's PublicClient. */
export interface ContractReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract(args: any): Promise<unknown>;
}

/** True only for an on-chain revert (not for transport/RPC errors, which must be retried). */
function isRevert(e: unknown): boolean {
  for (let cur = e as { name?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.name === 'ContractFunctionRevertedError' || cur.name === 'ContractFunctionZeroDataError') return true;
  }
  return false;
}

/**
 * Read name/symbol/decimals from the ERC-20. A revert falls back to ''/''/18
 * (the row still gets created); RPC errors are thrown so the caller retries.
 */
export async function readErc20Meta(client: ContractReader, asset: string): Promise<Erc20Meta> {
  const read = async <T>(functionName: 'name' | 'symbol' | 'decimals', fallback: T): Promise<T> => {
    try {
      return await client.readContract({ address: asset, abi: erc20MetaAbi, functionName }) as T;
    } catch (e) {
      if (isRevert(e)) return fallback;
      throw e;
    }
  };
  const [name, symbol, decimals] = await Promise.all([
    read('name', ''), read('symbol', ''), read<number | bigint>('decimals', 18),
  ]);
  return { name, symbol, decimals: Number(decimals) };
}

/** Insert or refresh the tokens row for a registration. Metadata columns are never touched. */
export async function upsertTokenFromRegistration(db: Db, reg: RegistrationForToken, meta: Erc20Meta): Promise<void> {
  const onchain = {
    name:            meta.name,
    symbol:          meta.symbol,
    decimals:        meta.decimals,
    creator:         reg.creator.toLowerCase(),
    launcher:        reg.launcher.toLowerCase(),
    router:          reg.router.toLowerCase(),
    poolId:          reg.poolId,
    numeraire:       reg.numeraire.toLowerCase(),
    initializer:     reg.initializer.toLowerCase(),
    registeredTx:    reg.txHash,
    registeredBlock: reg.blockNumber,
    registeredAt:    reg.timestamp,
    launchedAt:      new Date(Number(reg.timestamp) * 1000),
  };
  // Never overwrite a known value with an unknown one ('' launcher / reverted name read).
  const keep = (col: string) => sql.raw(`COALESCE(NULLIF(excluded.${col}, ''), tokens.${col})`);
  await db.insert(tokens).values({ asset: reg.asset.toLowerCase(), ...onchain })
    .onConflictDoUpdate({
      target: tokens.asset,
      set: {
        ...onchain,
        name:     keep('name'),
        symbol:   keep('symbol'),
        launcher: keep('launcher'),
      },
    });
}

/**
 * Backfill (one-off script): create/refresh a tokens row for every idx_registrations
 * row, filling idx_registrations.launcher from the register() tx where still ''.
 * Dry run unless `apply`. Returns one line per registration.
 */
export async function backfillTokensFromRegistrations(
  db: Db,
  client: ContractReader & { getTransaction(a: { hash: `0x${string}` }): Promise<{ from: string }> },
  apply: boolean,
): Promise<string[]> {
  const regs = await db.select().from(idxRegistrations)
    .orderBy(asc(idxRegistrations.blockNumber), asc(idxRegistrations.logIndex));
  const out: string[] = [];
  for (const reg of regs) {
    const launcher = reg.launcher || (await client.getTransaction({ hash: reg.txHash as `0x${string}` })).from.toLowerCase();
    const meta = await readErc20Meta(client, reg.asset);
    const [existing] = await db.select({ asset: tokens.asset }).from(tokens).where(eq(tokens.asset, reg.asset));
    const label = `${reg.asset} ${meta.symbol || '?'} (${meta.name || '?'}) creator=${reg.creator} launcher=${launcher}`;
    if (!apply) {
      out.push(`${label}: would ${existing ? 'refresh' : 'create'} tokens row [dry run, pass --yes to apply]`);
      continue;
    }
    await db.transaction(async (tx) => {
      if (!reg.launcher) {
        await tx.update(idxRegistrations).set({ launcher })
          .where(and(eq(idxRegistrations.id, reg.id), eq(idxRegistrations.launcher, '')));
      }
      await upsertTokenFromRegistration(tx, { ...reg, launcher }, meta);
    });
    out.push(`${label}: ${existing ? 'refreshed' : 'created'}`);
  }
  return out;
}
