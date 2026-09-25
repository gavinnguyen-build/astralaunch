// Test 04 — fee split per beneficiary (SPEC §4.1): each beneficiary collects from its own wallet,
// because Doppler releases a beneficiary's share only when that beneficiary calls collectFees().
import { DopplerSDK, getAirlockOwner } from '@whetstone-research/doppler-sdk/evm';
import { formatUnits, type Address } from 'viem';
import { SHARES, USDC, account, assertFork, balanceOf, loadState, pass, publicClient, wallet, type Role } from './env.js';

const roles: { role: Role; share: bigint }[] = [
  { role: 'creator', share: SHARES.creator },
  { role: 'escrowStub', share: SHARES.escrow },
  { role: 'buybackStub', share: SHARES.buyback },
  { role: 'treasury', share: SHARES.treasury },
];

function pct(part: bigint, whole: bigint) {
  if (whole === 0n) return 0;
  return Number((part * 1_000_000n) / whole) / 10_000;
}

async function main() {
  await assertFork();
  const st = loadState();
  if (!st.token) throw new Error('Run npm run launch and npm run trade first');
  const token = st.token as Address;

  const readSdk = new DopplerSDK({ publicClient, chainId: 143 });
  const pool = await readSdk.getMulticurvePool(token);
  const numeraire = (await pool.getNumeraireAddress()) as Address;
  const usdcIs0 = BigInt(USDC) < BigInt(token);
  console.log(`numeraire ${numeraire} (USDC is currency${usdcIs0 ? 0 : 1})\n`);

  const owner = (await getAirlockOwner(publicClient)) as Address;
  const ownerPending = await pool.getPendingFees(owner);
  console.log(`Doppler (airlock owner) pending: fees0 ${ownerPending.fees0}, fees1 ${ownerPending.fees1}`);

  const got: Record<string, { usdc: bigint; tok: bigint }> = {};
  for (const { role } of roles) {
    const who = account(role).address;
    const pending = await pool.getPendingFees(who);
    const u0 = await balanceOf(USDC, who);
    const t0 = await balanceOf(token, who);
    const sdk = new DopplerSDK({ publicClient, walletClient: wallet(role), chainId: 143 });
    const p = await sdk.getMulticurvePool(token);
    const res = await p.collectFees();
    await publicClient.waitForTransactionReceipt({ hash: res.transactionHash });
    const du = (await balanceOf(USDC, who)) - u0;
    const dt = (await balanceOf(token, who)) - t0;
    got[role] = { usdc: du, tok: dt };
    console.log(`${role.padEnd(12)} pending(f0 ${pending.fees0}, f1 ${pending.fees1})  received ${formatUnits(du, 6)} USDC + ${formatUnits(dt, 18)} tokens`);
  }

  const totUsdc = Object.values(got).reduce((s, v) => s + v.usdc, 0n);
  const totTok = Object.values(got).reduce((s, v) => s + v.tok, 0n);
  // These four roles hold 95% of shares; compare each role against its share of that 95%.
  const nonDoppler = SHARES.creator + SHARES.escrow + SHARES.buyback + SHARES.treasury;
  console.log('');
  for (const { role, share } of roles) {
    const expected = pct(share, nonDoppler);
    const actual = pct(got[role].usdc, totUsdc);
    pass(Math.abs(expected - actual) < 0.5, `${role} USDC share ~${expected.toFixed(2)}% of beneficiary payouts`, `${actual.toFixed(2)}%`);
  }

  const buyVol = BigInt(st.buyVolumeUsdc ?? '0');
  const sellVol = BigInt(st.sellVolumeToken ?? '0');
  if (buyVol > 0n) {
    const impliedFee = pct(totUsdc, (buyVol * 95n) / 100n);
    pass(Math.abs(impliedFee - 2) < 0.1, 'USDC-side fees ~= 2% of buy volume (net of Doppler 5%)', `${impliedFee.toFixed(3)}%`);
  }
  if (sellVol > 0n) {
    const impliedFee = pct(totTok, (sellVol * 95n) / 100n);
    pass(Math.abs(impliedFee - 2) < 0.1, 'token-side fees ~= 2% of sell volume (net of Doppler 5%)', `${impliedFee.toFixed(3)}%`);
  }
  console.log('\nIf a contract (FeeEscrow/BuybackVault) is a beneficiary, it must call collectFees() itself to receive its share.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
