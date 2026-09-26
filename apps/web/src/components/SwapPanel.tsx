/**
 * Inline swap panel for the chart page (exact-in, Universal Router + Permit2, lib/trade.ts).
 *
 * Quotes live as you type (no wallet needed) and refresh every 12 s. One primary button whose label
 * follows the state. Approvals (D-PD3): by default an unlimited ERC-20 approval to Permit2 once and a
 * 30-day max-amount permit for the Universal Router, so repeat trades need one confirmation; the
 * "Exact approvals only" setting keeps per-trade exact amounts. The review says plainly when a
 * long-lived permission is being granted.
 * Review dialog → one wallet action per click (approve → sign permit → swap); every
 * transaction is simulated and its gas (estimate × 1.1) is shown before the click that sends it. The
 * minimum received the user reviewed is the floor sent on-chain.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatUnits, parseUnits, toFunctionSelector, type Address, type Hex } from 'viem';
import { PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER, withBuffer } from '@astralaunch/shared';
import {
  accountState, buildTradeTx, getPoolKey, quoteTrade, sendTrade, simulateTrade, approvePermit2, approvalAmount, LONG_PERMIT_S,
  type ApprovalMode, type TradeAddrs, type TradePlan, type TradeQuote,
} from '../lib/trade.js';
import { readClient, walletClients, type Clients, type PrivyWallet } from '../lib/wallet.js';
import type { ChainConfig } from '../lib/launch.js';
import { sig } from '../lib/format.js';
import { Modal } from './Modal.js';
import { BURST_MS, burstInterval, tradeFromReceipt, type ShownTrade } from '../lib/optimisticTrade.js';
import { TxLink } from './Explorer.js';

const C = { card: '#14121E', well: '#1C1A29', line: '#2E2A45', text: '#ECEAF4', dim: '#8C87A3', soft: '#C9C5DA', accent: '#8B5CF6',
  buy: '#34D399', sell: '#F87171', warn: '#FBBF24', bad: '#F87171' };
const AUTO_SLIPPAGE_BPS = 100;
const QUOTE_REFRESH_MS = 12_000;
const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const approveAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const SLIPPAGE_ERRORS = ['V4TooLittleReceived(uint256,uint256)', 'InsufficientETH()', 'InsufficientToken()'].map((e) => toFunctionSelector(`function ${e}`));

const EXACT_KEY = 'astralaunch.swap.exactApprovals';
const readExact = () => { try { return localStorage.getItem(EXACT_KEY) === '1'; } catch { return false; } };
const writeExact = (v: boolean) => { try { localStorage.setItem(EXACT_KEY, v ? '1' : '0'); } catch { /* per-browser convenience only */ } };

/** Amount for display: grouped when large, 4 significant digits when small. */
export function fmtTok(v: bigint, dec: number): string {
  const n = Number(formatUnits(v, dec));
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return sig(n, 4);
}
/** Exact-ish decimal string for putting an amount back into the input. */
const toInput = (v: bigint, dec: number) => {
  const s = formatUnits(v, dec);
  const [i, f = ''] = s.split('.');
  return f ? `${i}.${f.slice(0, dec === 6 ? 6 : 8)}`.replace(/\.?0+$/, '') : i!;
};
function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => { const id = setTimeout(() => setD(v), ms); return () => clearTimeout(id); }, [v, ms]);
  return d;
}

/** Wallet errors → one calm sentence. */
export function swapError(e: unknown): { msg: string; cancelled: boolean } {
  const raw = `${(e as { shortMessage?: string })?.shortMessage ?? ''} ${(e as Error)?.message ?? String(e)}`;
  if (/user rejected|user denied|rejected the request|cancell?ed/i.test(raw)) return { msg: 'Cancelled in your wallet.', cancelled: true };
  if (SLIPPAGE_ERRORS.some((s) => raw.includes(s)) || /TooLittleReceived|InsufficientETH/.test(raw)) {
    return { msg: 'The price moved past your max slippage. Refresh the quote or raise the slippage.', cancelled: false };
  }
  if (/insufficient funds/i.test(raw)) return { msg: 'Not enough MON to pay for gas.', cancelled: false };
  if (/Transaction deadline|DeadlinePassed|0x5bf6f916/i.test(raw)) return { msg: 'The transaction expired. Try again.', cancelled: false };
  const short = (e as { shortMessage?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e));
  return { msg: short.split('\n')[0]!.slice(0, 220), cancelled: false };
}

export interface SwapPanelProps {
  asset: Address; symbol: string; numSym: 'USDC' | 'MON'; config: ChainConfig | undefined;
  wallet: PrivyWallet | null; login: (() => void) | null;
  /** USD per 1 numeraire and per 1 token (null when the oracle is stale). */
  usdPerNum: number | null; tokenUsd: number | null;
  /** Called as soon as the swap receipt arrives, with the trade decoded from it (null if not decodable). */
  onSwapped?: (trade: ShownTrade | null) => void;
}

export function SwapPanel(p: SwapPanelProps) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [slipAuto, setSlipAuto] = useState(true);
  const [slipText, setSlipText] = useState('1');
  const [exactApprovals, setExactApprovals] = useState(readExact);
  const [showSettings, setShowSettings] = useState(false);
  const [invertRate, setInvertRate] = useState(false);
  const [reviewing, setReviewing] = useState<TradeQuote | null>(null);
  const [burstUntil, setBurstUntil] = useState(0);

  const cfg = p.config;
  const pc = useMemo(() => (cfg ? readClient(cfg) : null), [cfg]);
  const A: TradeAddrs | null = useMemo(() => (cfg ? { universalRouter: UNIVERSAL_ROUTER, permit2: PERMIT2, quoter: V4_QUOTER, vault: cfg.contracts.vault, wmon: cfg.tokens.wmon, usdc: cfg.tokens.usdc } : null), [cfg]);
  const account = p.wallet ? (p.wallet.address as Address) : null;

  const inSym = side === 'buy' ? p.numSym : p.symbol, outSym = side === 'buy' ? p.symbol : p.numSym;
  const numDec = p.numSym === 'USDC' ? 6 : 18;
  const inDec = side === 'buy' ? numDec : 18, outDec = side === 'buy' ? 18 : numDec;
  const slipNum = Number(slipText);
  const slipValid = slipAuto || (slipNum >= 0.1 && slipNum <= 5);
  const slippageBps = slipAuto ? AUTO_SLIPPAGE_BPS : Math.round(slipNum * 100);

  const amountIn = useMemo(() => { try { return amount ? parseUnits(amount, inDec) : 0n; } catch { return 0n; } }, [amount, inDec]);
  const debouncedIn = useDebounced(amountIn, 300);

  const poolKey = useQuery({ queryKey: ['poolKey', p.asset, cfg?.contracts.vault], enabled: !!pc && !!A,
    queryFn: () => getPoolKey(pc!, A!, p.asset), staleTime: Infinity });
  const quote = useQuery({
    queryKey: ['swapQuote', p.asset, side, debouncedIn.toString(), slippageBps], enabled: !!poolKey.data && debouncedIn > 0n && slipValid,
    queryFn: () => quoteTrade(pc!, A!, { side, asset: p.asset, amountIn: debouncedIn, slippageBps, key: poolKey.data! }),
    refetchInterval: QUOTE_REFRESH_MS, placeholderData: (prev) => prev, retry: 1,
  });
  const balances = useQuery({
    queryKey: ['swapBalances', p.asset, account, p.numSym], enabled: !!pc && !!account && !!cfg, refetchInterval: () => burstInterval(burstUntil, 15_000),
    queryFn: async () => {
      const [num, tok, gasPrice] = await Promise.all([
        p.numSym === 'MON' ? pc!.getBalance({ address: account! }) : pc!.readContract({ address: cfg!.tokens.usdc, abi: erc20, functionName: 'balanceOf', args: [account!] }),
        pc!.readContract({ address: p.asset, abi: erc20, functionName: 'balanceOf', args: [account!] }),
        pc!.getGasPrice(),
      ]);
      return { num, tok, gasPrice };
    },
  });

  const q = quote.data && quote.data.side === side && quote.data.amountIn === amountIn ? quote.data : null;
  const shown = q ?? (quote.data?.side === side ? quote.data : null);   // previous quote, dimmed while the new one loads
  const quoting = amountIn > 0n && !q;
  const balIn = balances.data ? (side === 'buy' ? balances.data.num : balances.data.tok) : null;
  const balOut = balances.data ? (side === 'buy' ? balances.data.tok : balances.data.num) : null;
  // Paying in native MON: keep enough for gas (Monad bills the gas limit; ~1M gas covers approve-free swaps with margin).
  const gasReserve = side === 'buy' && p.numSym === 'MON' && balances.data ? balances.data.gasPrice * 1_000_000n : 0n;
  const maxIn = balIn != null ? (balIn > gasReserve ? balIn - gasReserve : 0n) : null;
  const insufficient = balIn != null && amountIn > 0n && amountIn > (side === 'buy' && p.numSym === 'MON' ? maxIn! : balIn);

  const usdIn = side === 'buy' ? p.usdPerNum : p.tokenUsd, usdOut = side === 'buy' ? p.tokenUsd : p.usdPerNum;
  const usd = (v: bigint, dec: number, rate: number | null) => (rate == null || v === 0n ? null : `≈ $${(Number(formatUnits(v, dec)) * rate).toLocaleString('en-US', { maximumFractionDigits: Number(formatUnits(v, dec)) * rate >= 1 ? 2 : 4 })}`);

  function onAmount(v: string) {
    const s = v.replace(',', '.');
    if (!/^\d*\.?\d*$/.test(s)) return;
    const f = s.split('.')[1];
    if (f && f.length > inDec) return;
    setAmount(s);
  }
  function pct(n: bigint) {
    if (maxIn == null) return;
    const v = n === 100n ? maxIn : ((side === 'buy' && p.numSym === 'MON' ? maxIn : balIn!) * n) / 100n;
    setAmount(v > 0n ? toInput(v, inDec) : '');
  }
  function flip() {
    const next = side === 'buy' ? 'sell' : 'buy';
    setAmount(q ? toInput(q.quoteOut, outDec) : '');
    setSide(next);
  }
  function pickSide(s: 'buy' | 'sell') { if (s !== side) { setSide(s); setAmount(''); } }

  // ── primary button ──
  let label: string; let action: (() => void) | null = null; let tone = C.accent;
  if (!cfg || poolKey.isLoading) label = 'Loading pool…';
  else if (poolKey.error) label = 'Pool not found';
  else if (!account) { label = p.login ? 'Connect wallet' : 'Wallet login is not configured'; action = p.login; }
  else if (amountIn === 0n) label = 'Enter an amount';
  else if (!slipValid) label = 'Slippage must be 0.1–5%';
  else if (insufficient) { label = side === 'buy' && p.numSym === 'MON' && balIn! >= amountIn ? 'Leave some MON for gas' : `Not enough ${inSym}`; tone = '#3A3456'; }
  else if (quote.error && !q) label = 'No quote for this amount';
  else if (quoting || !q) label = 'Getting the price…';
  else { label = q.priceImpactBps >= 1500 ? 'Review (high price impact)' : 'Review swap'; action = () => setReviewing(q); if (q.priceImpactBps >= 1500) tone = '#B42335'; }

  const impactColor = (bps: number) => (bps >= 1000 ? C.bad : bps >= 300 ? C.warn : C.soft);
  const rate = q && q.amountIn > 0n && q.quoteOut > 0n ? (() => {
    const pin = Number(formatUnits(q.amountIn, inDec)), pout = Number(formatUnits(q.quoteOut, outDec));
    return invertRate ? `1 ${outSym} = ${sig(pin / pout, 4)} ${inSym}` : `1 ${inSym} = ${sig(pout / pin, 4)} ${outSym}`;
  })() : null;

  return (
    <section aria-label={`Swap ${p.symbol}`} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: '28px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '4px', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px 8px' }}>
        <div role="tablist" style={{ display: 'flex', gap: '2px', background: C.well, borderRadius: '999px', padding: '3px' }}>
          {(['buy', 'sell'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} type="button" onClick={() => pickSide(s)}
              style={{ border: 0, cursor: 'pointer', height: '30px', padding: '0 16px', borderRadius: '999px', fontFamily: 'inherit', fontWeight: 700, fontSize: '13px',
                background: side === s ? '#2A2640' : 'transparent', color: side === s ? (s === 'buy' ? C.buy : C.sell) : C.dim }}>
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: C.dim }}>{slipAuto ? 'Slippage auto 1%' : `Slippage ${slipText}%`}</span>
        <button type="button" aria-label="Swap settings" aria-expanded={showSettings} onClick={() => setShowSettings((x) => !x)}
          style={{ width: '32px', height: '32px', borderRadius: '50%', border: 0, background: showSettings ? '#2A2640' : 'transparent', color: C.soft, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
        </button>
      </div>

      {showSettings && (
        <div style={{ background: C.well, borderRadius: '18px', padding: '12px 14px', marginBottom: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>Max slippage</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button type="button" onClick={() => { setSlipAuto(true); setSlipText('1'); }}
                style={{ border: 0, height: '30px', padding: '0 12px', borderRadius: '999px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: '12px', background: slipAuto ? C.accent : '#2A2640', color: '#fff' }}>Auto</button>
              <div style={{ display: 'flex', alignItems: 'center', height: '30px', borderRadius: '999px', background: C.card, border: `1px solid ${slipValid ? C.line : C.bad}`, padding: '0 10px' }}>
                <input aria-label="Custom slippage percent" inputMode="decimal" value={slipAuto ? '' : slipText} placeholder="1.0"
                  onChange={(e) => { const s = e.target.value.replace(',', '.'); if (/^\d*\.?\d{0,2}$/.test(s)) { setSlipAuto(false); setSlipText(s); } }}
                  style={{ width: '44px', border: 0, background: 'transparent', color: C.text, fontFamily: 'inherit', fontSize: '13px', textAlign: 'right', outline: 'none' }} />
                <span style={{ fontSize: '13px', color: C.dim }}>%</span>
              </div>
            </div>
          </div>
          <span style={{ fontSize: '12px', color: slipValid ? C.dim : C.bad }}>
            {slipValid ? 'The swap reverts if the price moves against you by more than this. Auto uses 1%.' : 'Enter a value from 0.1% to 5%.'}
          </span>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.line}`, cursor: 'pointer' }}>
            <input type="checkbox" checked={exactApprovals} onChange={(e) => { setExactApprovals(e.target.checked); writeExact(e.target.checked); }} style={{ marginTop: '3px' }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600 }}>Exact approvals only</span>
              <span style={{ fontSize: '12px', color: C.dim }}>
                {exactApprovals
                  ? 'Each trade approves and permits only its own amount, for 30 minutes. Every token trade asks for extra confirmations.'
                  : 'Off: the first trade of a token grants Permit2 an unlimited approval and the router a 30-day permit, so later trades need one confirmation.'}
              </span>
            </span>
          </label>
        </div>
      )}

      <AmountBox label="You pay" sym={inSym} tone={side === 'buy' ? C.soft : C.accent}
        input={<input aria-label={`Amount of ${inSym} to pay`} inputMode="decimal" autoComplete="off" placeholder="0" value={amount}
          onChange={(e) => onAmount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && action) action(); }}
          style={{ ...bigInput, fontSize: fitSize(amount), color: insufficient ? C.bad : C.text }} />}
        usd={usd(amountIn, inDec, usdIn)}
        balance={balIn != null ? <span>Balance {fmtTok(balIn, inDec)}</span> : null}
        topRight={balIn != null && balIn > 0n ? (
          <span style={{ display: 'flex', gap: '4px' }}>
            {([25n, 50n, 100n] as const).map((n) => (
              <button key={String(n)} type="button" onClick={() => pct(n)} style={chip}>{n === 100n ? 'Max' : `${n}%`}</button>
            ))}
          </span>
        ) : null} />

      <div style={{ height: 0, position: 'relative', zIndex: 1 }}>
        <button type="button" aria-label={`Switch to ${side === 'buy' ? 'selling' : 'buying'} ${p.symbol}`} onClick={flip}
          style={{ position: 'absolute', left: '50%', top: '-18px', transform: 'translateX(-50%)', width: '36px', height: '36px', borderRadius: '12px', border: `4px solid ${C.card}`, background: '#2A2640', color: C.text, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
        </button>
      </div>

      <AmountBox label="You receive" sym={outSym} tone={side === 'buy' ? C.accent : C.soft}
        input={<div aria-live="polite" style={{ ...bigInput, fontSize: fitSize(shown && amountIn > 0n ? fmtTok(shown.quoteOut, outDec) : '0'), color: quoting ? C.dim : C.text, opacity: quoting ? 0.55 : 1, transition: 'opacity .2s' }}>
          {amountIn === 0n ? <span style={{ color: '#4A4563' }}>0</span> : shown ? fmtTok(shown.quoteOut, outDec) : '…'}</div>}
        usd={q ? usd(q.quoteOut, outDec, usdOut) : null}
        balance={balOut != null ? <span>Balance {fmtTok(balOut, outDec)}</span> : null} />

      {amountIn > 0n && (
        <div style={{ padding: '8px 6px 2px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {rate ? <button type="button" onClick={() => setInvertRate((x) => !x)} title="Invert the rate" style={{ border: 0, background: 'transparent', color: C.soft, padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px' }}>{rate}</button>
              : <span style={{ color: C.dim }}>{quote.error && !q ? swapError(quote.error).msg : 'Getting the price…'}</span>}
            {quote.isFetching && <Spinner />}
          </div>
          {q && (<>
            <Line k="Price impact"><span style={{ color: impactColor(q.priceImpactBps) }}>{q.priceImpactBps < 1 ? '< 0.01%' : `${(q.priceImpactBps / 100).toFixed(2)}%`}</span></Line>
            <Line k="Minimum received">{fmtTok(q.minOut, outDec)} {outSym}</Line>
            <Line k="Pool fee">2% (included in the price)</Line>
          </>)}
        </div>
      )}

      <button type="button" onClick={action ?? undefined} disabled={!action}
        style={{ marginTop: '8px', height: '54px', borderRadius: '18px', border: 0, background: action ? tone : '#221F33', color: action ? '#fff' : C.dim,
          fontFamily: 'inherit', fontWeight: 700, fontSize: '16px', cursor: action ? 'pointer' : 'default', transition: 'background .15s' }}>
        {label}
      </button>

      {reviewing && account && cfg && A && pc && p.wallet && (
        <ReviewSwap initial={reviewing} mode={exactApprovals ? 'exact' : 'standard'} A={A} config={cfg} wallet={p.wallet} symbol={p.symbol} numSym={p.numSym} inDec={inDec} outDec={outDec}
          usdIn={usdIn} usdOut={usdOut}
          onReceipt={(receipt, key) => {
            setBurstUntil(Date.now() + BURST_MS);
            void balances.refetch();
            p.onSwapped?.(tradeFromReceipt({ receipt, key, asset: p.asset, numeraireDecimals: numDec, trader: account, usdPerNumeraire: p.usdPerNum }));
          }}
          onClose={(swapped) => { setReviewing(null); if (swapped) setAmount(''); }} />
      )}
    </section>
  );
}

const bigInput: CSSProperties = { width: '100%', minWidth: 0, border: 0, background: 'transparent', outline: 'none', fontFamily: 'inherit', fontSize: '30px', fontWeight: 600, letterSpacing: '-0.02em', padding: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' };
/** Shrink long amounts so they fit the ~320px sidebar next to the token chip. */
const fitSize = (s: string) => (s.length > 13 ? '17px' : s.length > 10 ? '20px' : s.length > 7 ? '24px' : '30px');
const chip: CSSProperties = { border: 0, background: '#2A2640', color: '#C4B5FD', borderRadius: '999px', height: '22px', padding: '0 8px', fontFamily: 'inherit', fontSize: '11px', fontWeight: 700, cursor: 'pointer' };

function AmountBox({ label, sym, tone, input, usd, balance, topRight }: { label: string; sym: string; tone: string; input: ReactNode; usd: string | null; balance: ReactNode; topRight?: ReactNode }) {
  return (
    <div style={{ background: C.well, borderRadius: '20px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '22px' }}>
        <span style={{ fontSize: '13px', color: C.dim }}>{label}</span>{topRight}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>{input}</div>
        <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '7px', height: '36px', padding: '0 12px 0 8px', borderRadius: '999px', background: C.card, border: `1px solid ${C.line}`, fontWeight: 700, fontSize: '15px' }}>
          <span aria-hidden style={{ width: '20px', height: '20px', borderRadius: '50%', background: tone, opacity: 0.85 }} />{sym}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', minHeight: '18px', alignItems: 'center', fontSize: '12px', color: C.dim, whiteSpace: 'nowrap' }}>
        <span>{usd ?? ''}</span>{balance}
      </div>
    </div>
  );
}

function Line({ k, children }: { k: string; children: ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}><span style={{ color: C.dim }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>;
}

function Spinner() {
  return <span aria-label="Refreshing" style={{ width: '12px', height: '12px', borderRadius: '50%', border: '2px solid #3A3456', borderTopColor: C.accent, display: 'inline-block', animation: 'astra-spin .8s linear infinite' }}>
    <style>{'@keyframes astra-spin{to{transform:rotate(360deg)}}'}</style></span>;
}

type StepKey = 'approve' | 'permit' | 'swap';
type StepState = 'todo' | 'active' | 'done';

/** Review → approve (if needed) → sign permit (if needed) → swap. One wallet action per click. */
function ReviewSwap({ initial, mode, A, config, wallet, symbol, numSym, inDec, outDec, usdIn, usdOut, onReceipt, onClose }: {
  initial: TradeQuote; mode: ApprovalMode; A: TradeAddrs; config: ChainConfig; wallet: PrivyWallet; symbol: string; numSym: 'USDC' | 'MON';
  inDec: number; outDec: number; usdIn: number | null; usdOut: number | null;
  onReceipt: (receipt: Awaited<ReturnType<typeof sendTrade>>['receipt'], key: TradeQuote['key']) => void; onClose: (swapped: boolean) => void;
}) {
  const [accepted, setAccepted] = useState<TradeQuote>(initial);
  const [latest, setLatest] = useState<TradeQuote>(initial);
  const [clients, setClients] = useState<Clients | null>(null);
  const [plan, setPlan] = useState<TradePlan | null>(null);
  const [approvalGas, setApprovalGas] = useState<bigint | null>(null);
  const [swapTx, setSwapTx] = useState<{ to: Address; data: Hex; value: bigint; gas: bigint } | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [ackImpact, setAckImpact] = useState(false);
  const [approvedOnce, setApprovedOnce] = useState(false);
  const [signedOnce, setSignedOnce] = useState(false);
  const [done, setDone] = useState<{ hash: Hex; received: bigint | null } | null>(null);

  const inSym = initial.side === 'buy' ? numSym : symbol, outSym = initial.side === 'buy' ? symbol : numSym;
  const highImpact = accepted.priceImpactBps >= 1500;
  const priceMoved = latest !== accepted && latest.quoteOut !== accepted.quoteOut
    && (latest.quoteOut * 10_000n) / (accepted.quoteOut || 1n) < 9_990n;   // worse by > 0.1%

  // Connect, read allowances, and simulate whatever needs no signature yet.
  async function prepare(q: TradeQuote, c0?: Clients) {
    setErr(null); setBusy('Checking your wallet…');
    try {
      const c = c0 ?? clients ?? await walletClients(wallet, config);
      setClients(c);
      const st = await accountState(c.publicClient, A, c.account, q);
      const pl: TradePlan = { ...q, ...st, approvalMode: mode };
      if (st.balanceIn < q.amountIn) throw new Error(`Not enough ${inSym}: balance ${fmtTok(st.balanceIn, inDec)}.`);
      setPlan(pl); setGasPrice(await c.publicClient.getGasPrice()); setSwapTx(null); setApprovalGas(null);
      if (pl.needsApproval) {
        const g = await c.publicClient.estimateContractGas({ account: c.account, address: pl.inputToken as Address, abi: approveAbi, functionName: 'approve', args: [A.permit2, approvalAmount(mode, pl.amountIn)] });
        setApprovalGas(withBuffer(g));
      } else if (!pl.needsPermit) {
        const tx = await buildTradeTx(c.walletClient, c.account, A, config.chainId, pl);   // no signature needed
        setSwapTx({ ...tx, gas: await simulateTrade(c.publicClient, c.account, tx) });
      }
    } catch (e) { setErr(swapError(e).msg); }
    setBusy(null);
  }
  useEffect(() => { void prepare(initial); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Keep the price fresh while the dialog is open (until the swap is sent).
  useEffect(() => {
    if (done) return;
    const id = setInterval(async () => {
      if (!clients) return;
      try { setLatest(await quoteTrade(clients.publicClient, A, { side: initial.side, asset: initial.asset, amountIn: initial.amountIn, slippageBps: initial.slippageBps, key: initial.key })); } catch { /* keep last */ }
    }, QUOTE_REFRESH_MS);
    return () => clearInterval(id);
  }, [clients, done, A, initial]);

  function acceptPrice() { setAccepted(latest); setAckImpact(false); void prepare(latest); }

  const step: StepKey = plan?.needsApproval ? 'approve' : plan?.needsPermit && !swapTx ? 'permit' : 'swap';
  const steps: { key: StepKey; label: string; show: boolean }[] = [
    { key: 'approve', label: mode === 'exact' ? `Allow Permit2 to use exactly ${fmtTok(initial.amountIn, inDec)} ${inSym}` : `Allow Permit2 to use your ${inSym} (unlimited, one time)`, show: !!plan && (plan.needsApproval || approvedOnce) },
    { key: 'permit', label: mode === 'exact' ? 'Sign a permit for this amount, valid 30 minutes (no gas)' : `Sign a 30-day permit for the Universal Router (no gas)`, show: !!plan && (plan.needsPermit || signedOnce) },
    { key: 'swap', label: 'Confirm the swap', show: true },
  ];
  const order: StepKey[] = ['approve', 'permit', 'swap'];
  const permitUntil = new Date(Date.now() + LONG_PERMIT_S * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const stateOf = (k: StepKey): StepState => (done ? 'done' : order.indexOf(k) < order.indexOf(step) ? 'done' : k === step ? 'active' : 'todo');

  async function go() {
    if (!clients || !plan) return;
    setErr(null); setNote(null);
    const c = clients;
    try {
      if (step === 'approve') {
        setBusy('Approve in your wallet…');
        await approvePermit2(c.publicClient, c.walletClient, c.account, A, plan.inputToken as Address, approvalAmount(mode, plan.amountIn));
        setApprovedOnce(true);
        await prepare(accepted, c);
        return;
      }
      if (step === 'permit') {
        setBusy('Sign in your wallet…');
        // Floor = the minimum the user reviewed; a fresh quote only refreshes allowances and the nonce.
        const tx = await buildTradeTx(c.walletClient, c.account, A, config.chainId, { ...plan, minOut: accepted.minOut, approvalMode: mode });
        setSignedOnce(true);
        setBusy('Simulating the swap…');
        setSwapTx({ ...tx, gas: await simulateTrade(c.publicClient, c.account, tx) });
        setBusy(null);
        return;
      }
      if (!swapTx) return;
      setBusy('Confirm in your wallet…');
      const outToken = accepted.outputToken;
      const readOut = () => outToken === 'MON' ? c.publicClient.getBalance({ address: c.account })
        : c.publicClient.readContract({ address: outToken, abi: erc20, functionName: 'balanceOf', args: [c.account] });
      const before = await readOut();
      const r = await sendTrade(c.publicClient, c.walletClient, c.account, swapTx, swapTx.gas);
      onReceipt(r.receipt, accepted.key);
      const after = await readOut();
      const gasPaid = outToken === 'MON' ? r.receipt.gasUsed * r.receipt.effectiveGasPrice : 0n;
      setDone({ hash: r.hash, received: after - before + gasPaid });
    } catch (e) {
      const m = swapError(e);
      if (m.cancelled) setNote(m.msg); else setErr(m.msg);
      if (step === 'swap' && !m.cancelled) {
        // Stale permit or a moved price: refresh the quote (the banner asks before a worse price is used) and rebuild.
        try { setLatest(await quoteTrade(c.publicClient, A, { side: initial.side, asset: initial.asset, amountIn: initial.amountIn, slippageBps: initial.slippageBps, key: initial.key })); } catch { /* keep last */ }
        await prepare(accepted, c);
        setErr(m.msg);
      }
    }
    setBusy(null);
  }

  const mon = (g: bigint) => `${sig(Number(formatUnits(g * gasPrice, 18)), 3)} MON`;
  const usdTxt = (v: bigint, dec: number, r: number | null) => (r == null ? '' : `≈ $${(Number(formatUnits(v, dec)) * r).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  const canGo = !busy && !!plan && !err?.startsWith('Not enough') && !priceMoved && (!highImpact || ackImpact) && (step !== 'swap' || !!swapTx);
  const btn = step === 'approve' ? `Approve ${inSym}` : step === 'permit' ? 'Sign permit' : initial.side === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`;

  if (done) {
    return (
      <Modal title="Swap complete" onClose={() => onClose(true)}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '8px 0 4px', textAlign: 'center' }}>
          <span aria-hidden style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#0F2A22', color: C.buy, display: 'grid', placeItems: 'center' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
          </span>
          <div style={{ fontSize: '18px', fontWeight: 700 }}>
            {`Swapped ${fmtTok(accepted.amountIn, inDec)} ${inSym} for ${done.received != null && done.received > 0n ? fmtTok(done.received, outDec) : `≈ ${fmtTok(accepted.quoteOut, outDec)}`} ${outSym}`}
          </div>
          <div style={{ fontSize: '13px', color: C.dim }}>Transaction <TxLink h={done.hash} /></div>
          <button type="button" onClick={() => onClose(true)} style={{ ...primaryBtn, width: '100%', marginTop: '8px' }}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Review swap" onClose={() => { if (!busy) onClose(false); }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ background: C.well, borderRadius: '18px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <Big label="You pay" amount={`${fmtTok(accepted.amountIn, inDec)} ${inSym}`} sub={usdTxt(accepted.amountIn, inDec, usdIn)} />
          <Big label="You receive" amount={`${fmtTok(accepted.quoteOut, outDec)} ${outSym}`} sub={usdTxt(accepted.quoteOut, outDec, usdOut)} />
        </div>

        {priceMoved && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#2B2410', border: '1px solid #4A3B12', borderRadius: '14px', padding: '10px 12px', fontSize: '13px' }}>
            <span style={{ flex: 1 }}>Price updated: you would now receive {fmtTok(latest.quoteOut, outDec)} {outSym}.</span>
            <button type="button" onClick={acceptPrice} style={{ ...primaryBtn, height: '32px', padding: '0 14px', fontSize: '13px' }}>Accept</button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', padding: '0 4px' }}>
          <Line k="Minimum received">{fmtTok(accepted.minOut, outDec)} {outSym}</Line>
          <Line k="Max slippage">{accepted.slippageBps / 100}%{accepted.slippageBps === AUTO_SLIPPAGE_BPS ? ' (auto)' : ''}</Line>
          <Line k="Price impact"><span style={{ color: accepted.priceImpactBps >= 1000 ? C.bad : accepted.priceImpactBps >= 300 ? C.warn : C.text }}>{accepted.priceImpactBps < 1 ? '< 0.01%' : `${(accepted.priceImpactBps / 100).toFixed(2)}%`}</span></Line>
          <Line k="Pool fee">2% of the trade, included in the price</Line>
          <Line k="Route">Uniswap v4 pool{accepted.inputToken === 'MON' ? ', MON wrapped in the same transaction' : accepted.outputToken === 'MON' ? ', paid out as MON' : ''}</Line>
          <Line k="Network cost">
            {step === 'approve' && approvalGas != null ? `Approval ${mon(approvalGas)} · swap shown after approval`
              : swapTx ? <span title={`Gas limit ${swapTx.gas} (simulated estimate × 1.1)`}>{mon(swapTx.gas)}</span>
              : step === 'permit' ? 'Shown after you sign the permit' : busy ? 'Simulating…' : '—'}
          </Line>
        </div>

        {steps.filter((s) => s.show).length > 1 && (
          <ol style={{ listStyle: 'none', margin: 0, padding: '10px 12px', background: C.well, borderRadius: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {steps.filter((s) => s.show).map((s, i) => {
              const st = stateOf(s.key);
              return (
                <li key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: st === 'todo' ? C.dim : C.text }}>
                  <span aria-hidden style={{ width: '22px', height: '22px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700,
                    background: st === 'done' ? '#0F2A22' : st === 'active' ? C.accent : '#2A2640', color: st === 'done' ? C.buy : '#fff' }}>{st === 'done' ? '✓' : i + 1}</span>
                  {s.label}
                </li>
              );
            })}
          </ol>
        )}

        {mode === 'standard' && plan && (plan.needsApproval || plan.needsPermit) && !signedOnce && (
          <div role="note" style={{ background: '#2B2410', border: '1px solid #4A3B12', borderRadius: '14px', padding: '10px 12px', fontSize: '13px', lineHeight: 1.45, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <strong style={{ color: C.warn }}>This grants a long-lived permission</strong>
            <span>
              {plan.needsApproval && <>Permit2 gets an <b>unlimited</b> approval for your {inSym}. </>}
              {plan.needsPermit && <>You sign a permit that lets the Uniswap Universal Router spend <b>any amount</b> of your {inSym} through Permit2 until <b>{permitUntil}</b>. </>}
              The router can only use it in swaps you send yourself. Later {inSym} trades will need one confirmation.
            </span>
            <span style={{ color: C.dim }}>To approve only this trade's amount, turn on "Exact approvals only" in the swap settings.</span>
          </div>
        )}

        {highImpact && (
          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '13px', color: C.warn }}>
            <input type="checkbox" checked={ackImpact} onChange={(e) => setAckImpact(e.target.checked)} />
            This trade moves the price by {(accepted.priceImpactBps / 100).toFixed(1)}%. I understand I will get a worse price.
          </label>
        )}
        {note && <p style={{ margin: 0, fontSize: '13px', color: C.soft }}>{note}</p>}
        {err && <p role="alert" style={{ margin: 0, fontSize: '13px', color: '#FCA5A5' }}>{err}</p>}

        <button type="button" disabled={!canGo} onClick={go}
          style={{ ...primaryBtn, height: '54px', fontSize: '16px', background: canGo ? (highImpact ? '#B42335' : C.accent) : '#221F33', color: canGo ? '#fff' : C.dim, cursor: canGo ? 'pointer' : 'default' }}>
          {busy ?? btn}
        </button>
      </div>
    </Modal>
  );
}

const primaryBtn: CSSProperties = { height: '46px', padding: '0 20px', borderRadius: '16px', border: 0, background: C.accent, color: '#fff', fontFamily: 'inherit', fontSize: '15px', fontWeight: 700, cursor: 'pointer' };

function Big({ label, amount, sub }: { label: string; amount: string; sub: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '12px', color: C.dim }}>{label}</span>
      <span style={{ fontSize: '24px', fontWeight: 700, letterSpacing: '-0.02em' }}>{amount}</span>
      {sub && <span style={{ fontSize: '12px', color: C.dim }}>{sub}</span>}
    </div>
  );
}
