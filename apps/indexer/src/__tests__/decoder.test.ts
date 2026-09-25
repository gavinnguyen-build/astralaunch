import { describe, it, expect } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Hex } from 'viem';
import {
  decodeStaticLog,
  decodeRouterLog,
  decodeTransferLog,
} from '../decoder.js';
import {
  registeredEvent,
  distributedEvent,
  escrowFeeCollectedEvent,
  revenueRecordedEvent,
  claimedEvent,
  claimedWmonEvent,
  forfeitedEvent,
  vaultFeeCollectedEvent,
  buybackExecutedEvent,
  tokensBurnedEvent,
  pfrCollectedEvent,
  transferEvent,
} from '../abis.js';
import type { Log } from 'viem';

const CHAIN_ID = 143;
const ESCROW = '0x22523feea974939fd6c94daf7f9d112d667dec3b';
const VAULT  = '0xcbe741362a59943174f028a44a1b82722c24e7e7';
const BLOCK_TS = 1727000000n;

function makeLog(overrides: Partial<Log>): Log {
  return {
    address: '0x0000000000000000000000000000000000000000',
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    blockNumber: 100n,
    data: '0x',
    logIndex: 0,
    transactionHash: '0xabc0000000000000000000000000000000000000000000000000000000000001',
    transactionIndex: 0,
    removed: false,
    topics: [],
    ...overrides,
  } as Log;
}

describe('decodeStaticLog', () => {
  it('decodes Registered event (v2: 7 fields)', () => {
    const asset       = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const creator     = '0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6';
    const router      = '0x95D381aa54A2DA62C835Dd081D1D5a0f8700C722';
    const poolId      = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const numeraire   = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
    const initializer = '0xce30042838e42790dbec27ef08f79191583a4d3b';

    const topics = encodeEventTopics({
      abi: [registeredEvent],
      eventName: 'Registered',
      args: { asset: asset as `0x${string}`, creator: creator as `0x${string}`, router: router as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [poolId as Hex, numeraire as `0x${string}`, initializer as `0x${string}`, 1727000000n],
    );

    const log = makeLog({
      address: '0x25845Cee2b0E6dF0DA40bb9B60A84D162eabd00B',
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('registration');
    if (row!.type === 'registration') {
      expect(row!.asset).toBe(asset.toLowerCase());
      expect(row!.creator).toBe(creator.toLowerCase());
      expect(row!.router).toBe(router.toLowerCase());
      expect(row!.poolId).toBe(poolId);
      expect(row!.numeraire).toBe(numeraire.toLowerCase());
      expect(row!.initializer).toBe(initializer.toLowerCase());
    }
  });

  it('decodes FeeCollected from escrow (v2: 4 fields with wmonDelta)', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [escrowFeeCollectedEvent],
      eventName: 'FeeCollected',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [500000n, 1000n, 250000n],
    );

    const log = makeLog({
      address: ESCROW as `0x${string}`,
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('fee_collection');
    if (row!.type === 'fee_collection') {
      expect(row!.contract).toBe('escrow');
      expect(row!.usdcDelta).toBe('500000');
      expect(row!.tokenDelta).toBe('1000');
      expect(row!.wmonDelta).toBe('250000');
      expect(row!.numeraireDelta).toBe('0');
    }
  });

  it('decodes FeeCollected from vault (v2: numeraireDelta)', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [vaultFeeCollectedEvent],
      eventName: 'FeeCollected',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [250000n, 500n],
    );

    const log = makeLog({
      address: VAULT as `0x${string}`,
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('fee_collection');
    if (row!.type === 'fee_collection') {
      expect(row!.contract).toBe('vault');
      expect(row!.usdcDelta).toBe('0');
      expect(row!.tokenDelta).toBe('500');
      expect(row!.wmonDelta).toBe('0');
      expect(row!.numeraireDelta).toBe('250000');
    }
  });

  it('decodes RevenueRecorded', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [revenueRecordedEvent],
      eventName: 'RevenueRecorded',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [500000n, 1000000n],
    );

    const log = makeLog({ topics: topics as [Hex, ...Hex[]], data });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('revenue_recorded');
    if (row!.type === 'revenue_recorded') {
      expect(row!.amount).toBe('500000');
      expect(row!.newTotal).toBe('1000000');
    }
  });

  it('decodes Claimed (USDC)', () => {
    const asset   = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const creator = '0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6';
    const topics = encodeEventTopics({
      abi: [claimedEvent],
      eventName: 'Claimed',
      args: { asset: asset as `0x${string}`, creator: creator as `0x${string}` },
    });
    const data = encodeAbiParameters([{ type: 'uint256' }], [100000n]);

    const log = makeLog({ topics: topics as [Hex, ...Hex[]], data });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('escrow_claim');
    if (row!.type === 'escrow_claim') {
      expect(row!.amount).toBe('100000');
      expect(row!.creator).toBe(creator.toLowerCase());
      expect(row!.wmonAmount).toBe('0');
      expect(row!.usdValue).toBe('0');
    }
  });

  it('decodes ClaimedWmon', () => {
    const asset   = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const creator = '0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6';
    const topics = encodeEventTopics({
      abi: [claimedWmonEvent],
      eventName: 'ClaimedWmon',
      args: { asset: asset as `0x${string}`, creator: creator as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [5000000000000000000n, 13500000n], // 5 WMON, $13.50
    );

    const log = makeLog({
      address: ESCROW as `0x${string}`,
      topics: topics as [Hex, ...Hex[]],
      data,
    });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('escrow_claim');
    if (row!.type === 'escrow_claim') {
      expect(row!.amount).toBe('0');
      expect(row!.wmonAmount).toBe('5000000000000000000');
      expect(row!.usdValue).toBe('13500000');
      expect(row!.creator).toBe(creator.toLowerCase());
    }
  });

  it('decodes Forfeited (v2: 4 fields with wmonMoved)', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [forfeitedEvent],
      eventName: 'Forfeited',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [50000n, 999n, 3000000000000000000n],
    );

    const log = makeLog({ topics: topics as [Hex, ...Hex[]], data });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('escrow_forfeit');
    if (row!.type === 'escrow_forfeit') {
      expect(row!.usdcMoved).toBe('50000');
      expect(row!.tokenMoved).toBe('999');
      expect(row!.wmonMoved).toBe('3000000000000000000');
    }
  });

  it('decodes BuybackExecuted', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [buybackExecutedEvent],
      eventName: 'BuybackExecuted',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }],
      [150000n, 14608597150361577200772n, 1],
    );

    const log = makeLog({ topics: topics as [Hex, ...Hex[]], data });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('buyback');
    if (row!.type === 'buyback') {
      expect(row!.usdcIn).toBe('150000');
      expect(row!.tokensBurned).toBe('14608597150361577200772');
      expect(row!.sourceTag).toBe(1);
    }
  });

  it('decodes TokensBurned', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [tokensBurnedEvent],
      eventName: 'TokensBurned',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters([{ type: 'uint256' }], [14608597150361577200772n]);

    const log = makeLog({ topics: topics as [Hex, ...Hex[]], data });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('burn');
    if (row!.type === 'burn') {
      expect(row!.amount).toBe('14608597150361577200772');
    }
  });

  it('decodes PFR Collected (v2: 4 fields with numeraireForwarded)', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [pfrCollectedEvent],
      eventName: 'Collected',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [50000n, 0n, 1500000000000000000n],
    );

    const log = makeLog({ topics: topics as [Hex, ...Hex[]], data });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('pfr_collection');
    if (row!.type === 'pfr_collection') {
      expect(row!.usdcForwarded).toBe('50000');
      expect(row!.tokenForwarded).toBe('0');
      expect(row!.numeraireForwarded).toBe('1500000000000000000');
    }
  });

  it('returns null for unknown event topic', () => {
    const log = makeLog({
      topics: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'] as [Hex],
      data: '0x',
    });
    const row = decodeStaticLog(log, CHAIN_ID, BLOCK_TS, ESCROW, VAULT);
    expect(row).toBeNull();
  });
});

describe('decodeRouterLog', () => {
  it('decodes Distributed event', () => {
    const asset = '0x13DB78bd3F92382306a17d50dAC93Af1904e171d';
    const topics = encodeEventTopics({
      abi: [distributedEvent],
      eventName: 'Distributed',
      args: { asset: asset as `0x${string}` },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [500000n, 300000n, 0n, 150000n, 50000n],
    );

    const log = makeLog({
      address: '0x95D381aa54A2DA62C835Dd081D1D5a0f8700C722',
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    const row = decodeRouterLog(log, CHAIN_ID, BLOCK_TS);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('distribution');
    expect(row!.total).toBe('500000');
    expect(row!.providerAmt).toBe('300000');
    expect(row!.costAmt).toBe('0');
    expect(row!.buybackAmt).toBe('150000');
    expect(row!.treasuryAmt).toBe('50000');
  });

  it('returns null for unknown event', () => {
    const log = makeLog({
      topics: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'] as [Hex],
      data: '0x',
    });
    const row = decodeRouterLog(log, CHAIN_ID, BLOCK_TS);
    expect(row).toBeNull();
  });
});

describe('decodeTransferLog', () => {
  it('decodes USDC Transfer event with default txFrom', () => {
    const from = '0x7f6a2850669202519f0FE8aa912451238820Db86';
    const to   = '0x95D381aa54A2DA62C835Dd081D1D5a0f8700C722';
    const topics = encodeEventTopics({
      abi: [transferEvent],
      eventName: 'Transfer',
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    });
    const data = encodeAbiParameters([{ type: 'uint256' }], [500000n]);

    const log = makeLog({
      address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    const row = decodeTransferLog(log, CHAIN_ID, BLOCK_TS);
    expect(row).not.toBeNull();
    expect(row!.type).toBe('usdc_transfer');
    expect(row!.fromAddr).toBe(from.toLowerCase());
    expect(row!.toAddr).toBe(to.toLowerCase());
    expect(row!.value).toBe('500000');
    expect(row!.txFrom).toBe('');
    expect(row!.isFacilitatorSettled).toBe(false);
  });

  it('passes txFrom and isFacilitatorSettled when provided', () => {
    const from = '0x7f6a2850669202519f0FE8aa912451238820Db86';
    const to   = '0x95D381aa54A2DA62C835Dd081D1D5a0f8700C722';
    const topics = encodeEventTopics({
      abi: [transferEvent],
      eventName: 'Transfer',
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    });
    const data = encodeAbiParameters([{ type: 'uint256' }], [1000000n]);

    const log = makeLog({
      address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      topics: topics as [Hex, ...Hex[]],
      data,
    });

    const facilitator = '0x7f6a2850669202519f0fe8aa912451238820db86';
    const row = decodeTransferLog(log, CHAIN_ID, BLOCK_TS, facilitator, true);
    expect(row).not.toBeNull();
    expect(row!.txFrom).toBe(facilitator);
    expect(row!.isFacilitatorSettled).toBe(true);
    expect(row!.value).toBe('1000000');
  });
});
