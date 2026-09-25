/**
 * Buy / Sell (chart page). Review (quote, min received, 2% pool fee, slippage) → [approve Permit2:
 * simulate + confirm + send] → sign Permit2 if needed → simulate the swap → confirm with gas → send.
 */
import { useEffect, useState } from 'react';
import { formatUnits, parseUnits, type Address } from 'viem';
import { PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER, withBuffer } from '@astralaunch/shared';
import { approvePermit2, buildTradeTx, planTrade, sendTrade, simulateTrade, type TradeAddrs, type TradePlan } from '../lib/trade.js';
import { errMsg, walletClients, type Clients, type PrivyWallet } from '../lib/wallet.js';
import type { ChainConfig } from '../lib/launch.js';
import { Actions, ErrorLine, Modal, Row, btnStyle, inputStyle } from './Modal.js';
import { TxLink } from './Explorer.js';

type Stage = 'form' | 'review' | 'approve' | 'confirm' | 'sending' | 'done';

export function TradeModal({ asset, symbol, numSym, wallet, config, initialSide, onClose }: {
  asset: Address; symbol: string; numSym: 'USDC' | 'MON'; wallet: PrivyWallet; config: ChainConfig; initialSide: 'buy' | 'sell'; onClose: () => void;
}) {
  const [side, setSide] = useState(initialSide);
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState('1');
  const [stage, setStage] = useState<Stage>('form');
  const [plan, setPlan] = useState<TradePlan | null>(null);
  const [tx, setTx] = useState<{ to: Address; data: `0x${string}`; value: bigint } | null>(null);
  const [gas, setGas] = useState<bigint>(0n);
  const [gasPrice, setGasPrice] = useState<bigint>(0n);
  const [approvalGas, setApprovalGas] = useState<bigint>(0n);
  const [hash, setHash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clients, setClients] = useState<Clients | null>(null);
  const A: TradeAddrs = { universalRouter: UNIVERSAL_ROUTER, permit2: PERMIT2, quoter: V4_QUOTER, vault: config.contracts.vault, wmon: config.tokens.wmon, usdc: config.tokens.usdc };
  const inSym = side === 'buy' ? numSym : symbol, outSym = side === 'buy' ? symbol : numSym;
  const inDec = side === 'buy' && numSym === 'USDC' ? 6 : 18, outDec = side === 'buy' ? 18 : numSym === 'USDC' ? 6 : 18;
  useEffect(() => { setStage('form'); setPlan(null); setErr(null); }, [side]);

  async function review() {
    setErr(null);
    try {
      const bps = Math.round(Number(slip) * 100);
      if (!(bps >= 10 && bps <= 500)) throw new Error('Slippage must be between 0.1% and 5%.');
      const amountIn = parseUnits(amount, inDec);
      if (amountIn <= 0n) throw new Error('Enter an amount.');
      const c = clients ?? await walletClients(wallet, config);
      setClients(c);
      const p = await planTrade(c.publicClient, A, c.account, { side, asset, amountIn, slippageBps: bps });
      if (p.balanceIn < amountIn) throw new Error(`Not enough ${inSym}: balance ${formatUnits(p.balanceIn, inDec)}.`);
      setPlan(p); setGasPrice(await c.publicClient.getGasPrice()); setStage('review');
    } catch (e) { setErr(errMsg(e)); }
  }

  async function next() {
    if (!plan || !clients) return;
    setErr(null);
    try {
      if (plan.needsApproval && stage === 'review') {
        const g = await clients.publicClient.estimateGas({ account: clients.account, to: plan.inputToken as Address,
          data: '0x095ea7b3' + PERMIT2.slice(2).padStart(64, '0') + plan.amountIn.toString(16).padStart(64, '0') as `0x${string}` });
        setApprovalGas(withBuffer(g)); setStage('approve'); return;
      }
      const t = await buildTradeTx(clients.walletClient, clients.account, A, config.chainId, plan);   // may ask for a Permit2 signature
      setGas(await simulateTrade(clients.publicClient, clients.account, t));
      setTx(t); setStage('confirm');
    } catch (e) { setErr(errMsg(e)); }
  }

  async function approve() {
    if (!plan || !clients) return;
    setErr(null); setStage('sending');
    try {
      await approvePermit2(clients.publicClient, clients.walletClient, clients.account, A, plan.inputToken as Address, plan.amountIn);
      setPlan({ ...plan, needsApproval: false }); setStage('review');
    } catch (e) { setErr(errMsg(e)); setStage('approve'); }
  }

  async function send() {
    if (!tx || !clients) return;
    setErr(null); setStage('sending');
    try { const r = await sendTrade(clients.publicClient, clients.walletClient, clients.account, tx, gas); setHash(r.hash); setStage('done'); }
    catch (e) { setErr(errMsg(e)); setStage('confirm'); }
  }

  const f = (v: bigint, d: number) => Number(formatUnits(v, d)).toLocaleString('en-US', { maximumFractionDigits: d === 6 ? 4 : 6 });
  return (
    <Modal title={`${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`} onClose={onClose}>
      {stage === 'form' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            {(['buy', 'sell'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSide(s)} style={{ ...btnStyle(side === s), flex: 1, background: side === s ? (s === 'buy' ? '#10825F' : '#B42335') : 'transparent' }}>{s === 'buy' ? 'Buy' : 'Sell'}</button>
            ))}
          </div>
          <label style={{ fontSize: '13px', color: '#A7A2BD' }}>Amount ({inSym}{side === 'buy' && numSym === 'MON' ? ', paid in MON and wrapped in the same transaction' : ''})
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" style={{ ...inputStyle, marginTop: 6 }} /></label>
          <label style={{ fontSize: '13px', color: '#A7A2BD' }}>Max slippage (%)
            <input inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} style={{ ...inputStyle, marginTop: 6 }} /></label>
          <p style={{ margin: 0, fontSize: '12px', color: '#8C87A3' }}>Every trade pays the pool's 2% fee. The swap reverts if you would receive less than the minimum.</p>
          <ErrorLine msg={err} />
          <Actions><button type="button" style={btnStyle(false)} onClick={onClose}>Cancel</button><button type="button" style={btnStyle(true)} onClick={review}>Review</button></Actions>
        </div>
      )}
      {plan && (stage === 'review' || stage === 'approve' || stage === 'confirm' || stage === 'sending') && (
        <div>
          <Row k="You pay">{f(plan.amountIn, inDec)} {inSym}</Row>
          <Row k="You receive (quote)">{f(plan.quoteOut, outDec)} {outSym}</Row>
          <Row k="Minimum received">{f(plan.minOut, outDec)} {outSym}</Row>
          <Row k="Max slippage">{plan.slippageBps / 100}%</Row>
          <Row k="Pool fee">2% (included in the quote)</Row>
          <Row k="Route">Uniswap v4 · Universal Router{plan.inputToken === 'MON' ? ' · wraps MON' : plan.outputToken === 'MON' ? ' · unwraps to MON' : ' · Permit2'}</Row>
          {stage === 'approve' && <Row k="Step 1: approval">approve exactly {f(plan.amountIn, inDec)} {inSym} for Permit2 · gas {approvalGas.toString()}</Row>}
          {stage === 'confirm' && <Row k="Gas (simulated, ×1.1)">{gas.toString()} · ≈ {Number(formatUnits(gas * gasPrice, 18)).toFixed(6)} MON</Row>}
          <ErrorLine msg={err} />
          <Actions>
            <button type="button" style={btnStyle(false)} onClick={() => setStage('form')} disabled={stage === 'sending'}>Back</button>
            {stage === 'review' && <button type="button" style={btnStyle(true)} onClick={next}>{plan.needsApproval ? 'Continue: approval' : plan.needsPermit ? 'Sign permit and simulate' : 'Simulate'}</button>}
            {stage === 'approve' && <button type="button" style={btnStyle(true)} onClick={approve}>Approve {inSym}</button>}
            {stage === 'confirm' && <button type="button" style={btnStyle(true)} onClick={send}>Confirm {side}</button>}
            {stage === 'sending' && <button type="button" style={btnStyle(true)} disabled>Waiting for the wallet…</button>}
          </Actions>
        </div>
      )}
      {stage === 'done' && hash && (
        <div>
          <p style={{ margin: '0 0 10px' }}>Done. Transaction <TxLink h={hash} />.</p>
          <Actions><button type="button" style={btnStyle(true)} onClick={onClose}>Close</button></Actions>
        </div>
      )}
    </Modal>
  );
}
