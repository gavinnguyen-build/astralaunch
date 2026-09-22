// Test 05 — creator allocation: 30-day cliff, linear to 365 days (SPEC §4.5).
// Uses Anvil time travel inside an evm snapshot, then reverts so the fork state is unchanged.
import { dopplerERC20V1Abi } from '@whetstone-research/doppler-sdk/evm';
import { formatUnits, type Abi, type Address } from 'viem';
import { DAY, VESTED_TOKENS, account, assertFork, loadState, pass, publicClient, testClient } from './env.js';

const abi = dopplerERC20V1Abi as unknown as Abi;

async function available(token: Address, who: Address): Promise<bigint> {
  return (await publicClient.readContract({ address: token, abi, functionName: 'computeAvailableVestedAmount', args: [who] })) as bigint;
}

async function warp(days: number) {
  await testClient.increaseTime({ seconds: Math.round(days * DAY) });
  await testClient.mine({ blocks: 1 });
}

async function main() {
  await assertFork();
  const st = loadState();
  if (!st.token) throw new Error('Run npm run launch first');
  const token = st.token as Address;
  const creator = account('creator').address;

  const fns = (abi as readonly { type: string; name?: string }[])
    .filter((x) => x.type === 'function' && /vest|release/i.test(x.name ?? ''))
    .map((x) => x.name);
  console.log(`Token vesting functions: ${[...new Set(fns)].join(', ')}\n`);

  const snap = await testClient.snapshot();
  try {
    const checkpoints = [0, 29, 31, 182, 366];
    let elapsed = 0;
    const seen: Record<number, bigint> = {};
    for (const d of checkpoints) {
      if (d > elapsed) {
        await warp(d - elapsed);
        elapsed = d;
      }
      seen[d] = await available(token, creator);
      console.log(`day ${String(d).padStart(3)}: available ${formatUnits(seen[d], 18)} tokens`);
    }
    pass(seen[29] === 0n, 'nothing claimable before the 30-day cliff');
    pass(seen[31] > 0n, 'claimable right after the cliff');
    const mid = Number((seen[182] * 1000n) / VESTED_TOKENS) / 10;
    pass(mid > 45 && mid < 55, 'about half vested at ~6 months', `${mid}%`);
    pass(seen[366] === VESTED_TOKENS, 'fully vested after one year', formatUnits(seen[366], 18));
  } finally {
    await testClient.revert({ id: snap });
    console.log('\nReverted time travel (fork state unchanged).');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
