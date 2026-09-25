/**
 * /token/:asset/chart — docs/design/TokenChart.dc.html. The plot is drawn with lightweight-charts
 * (TradingView attribution kept) in the design colours; everything else is real data.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, PriceScaleMode, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { TokenChartView } from '../design/TokenChartView.js';
import { api, type Candle, type Trade } from '../lib/api.js';
import { ago, compact, fmtUsd, serviceLabel, shortAddr, sig } from '../lib/format.js';
import { Empty, ErrorBox, Loading } from '../components/State.js';
import { PageShell } from './Token.js';

const UP = '#22C55E', DOWN = '#F04438';
const TF = [['1s', null], ['1m', null], ['5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['D', '1d'], ['W', null]] as const;
type TfLabel = typeof TF[number][0];
const WINDOWS = [['5M', 300], ['1H', 3600], ['6H', 21_600], ['24H', 86_400]] as const;
const TOOLS: [string, string][] = [
  ['Cursor', 'M12 3v6M12 15v6M3 12h6M15 12h6'], ['Trend line', 'M4 20 20 4M4 20h.01M20 4h.01'], ['Levels', 'M3 6h18M3 12h18M3 18h18'],
  ['Brush', 'M3 21c3 0 7-1 9-3l8-8-4-4-8 8c-2 2-3 6-3 9'], ['Text', 'M5 5h14M12 5v14'], ['Measure', 'M4 16 16 4l4 4L8 20zM8 12l2 2M11 9l2 2M14 6l2 2'],
  ['Zoom', 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M11 8v6M8 11h6'], ['Magnet', 'M6 15a6 6 0 0 0 12 0V4h-4v11a2 2 0 0 1-4 0V4H6z'],
  ['Lock', 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4'],
];

const seg = <T extends string>(list: readonly T[], cur: T, set: (v: T) => void, on = '#8B5CF6', onFg = '#FFFFFF') =>
  list.map((v) => ({ label: v, select: () => set(v), bg: v === cur ? on : 'transparent', fg: v === cur ? onFg : '#ECEAF4' }));

/** Price of the last trade at or before `t`, else the launch price. */
function priceAtTime(trades: Trade[], t: number, launch: number | null, usd: boolean): number | null {
  const tr = trades.find((x) => x.timestamp <= t);
  const p = tr ? (usd ? tr.priceUsd : tr.price) : null;
  return p != null ? Number(p) : launch;
}

export default function TokenChart() {
  const { asset = '' } = useParams();
  const [tf, setTf] = useState<TfLabel>('1h');
  const [style, setStyle] = useState<'Candles' | 'Line'>('Candles');
  const [unit, setUnit] = useState<'Price' | 'Mcap'>('Price');
  const [tab, setTab] = useState('Transactions');
  const [win, setWin] = useState<typeof WINDOWS[number][0]>('24H');
  const [scale, setScale] = useState<'pct' | 'log' | 'auto'>('auto');
  const [hover, setHover] = useState<Candle | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const apiTf = TF.find((x) => x[0] === tf)![1]!;

  const token = useQuery({ queryKey: ['token', asset], queryFn: () => api.token(asset) });
  const candles = useQuery({ queryKey: ['candles', asset, apiTf], queryFn: () => api.candles(asset, apiTf), enabled: !!token.data });
  const trades = useQuery({ queryKey: ['trades', asset], queryFn: () => api.trades(asset), enabled: !!token.data, refetchInterval: 15_000 });
  const holders = useQuery({ queryKey: ['holders', asset], queryFn: () => api.holders(asset), enabled: !!token.data });
  const list = useQuery({ queryKey: ['tokens', 30], queryFn: () => api.tokens(30) });

  useEffect(() => { const id = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(id); }, []);

  const numSym = token.data?.market?.numeraireSymbol ?? 'USDC';
  const usdOk = candles.data?.usdPerNumeraire != null;
  const supply = Number(candles.data?.supply ?? token.data?.market?.supply ?? 1e9);
  const mult = unit === 'Mcap' ? supply : 1;
  const px = (c: Candle, k: 'open' | 'high' | 'low' | 'close') => Number(usdOk ? c[`${k}Usd` as const] : c[k]) * mult;
  const fmtPx = (n: number) => (unit === 'Mcap' ? (usdOk ? `$${compact(n)}` : `${compact(n)} ${numSym}`) : usdOk ? fmtUsd(n) : `${sig(n, 4)}`);

  // ── chart ──
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chart = useRef<{ api: IChartApi; main?: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>; vol?: ISeriesApi<'Histogram'> } | null>(null);
  const data = candles.data?.candles ?? [];

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const api = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8C87A3', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: '#1E1B2E' }, horzLines: { color: '#1E1B2E' } },
      rightPriceScale: { borderColor: '#25213A' },
      timeScale: { borderColor: '#25213A', timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chart.current = { api };
    return () => { api.remove(); chart.current = null; };
  }, [token.data != null]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (c.main) c.api.removeSeries(c.main);
    if (c.vol) c.api.removeSeries(c.vol);
    c.api.applyOptions({ localization: { priceFormatter: fmtPx } });
    const ref = data.length ? px(data[data.length - 1]!, 'close') : 1;
    const precision = Math.min(15, Math.max(2, Math.ceil(-Math.log10(Math.max(ref, 1e-15))) + 3));
    const priceFormat = { type: 'price' as const, precision, minMove: 10 ** -precision };
    const main = style === 'Candles'
      ? c.api.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat })
      : c.api.addSeries(LineSeries, { color: '#34D399', lineWidth: 2, priceFormat });
    const vol = c.api.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.api.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const t = (x: Candle) => x.time as UTCTimestamp;
    if (style === 'Candles') {
      (main as ISeriesApi<'Candlestick'>).setData(data.map((x) => ({ time: t(x), open: px(x, 'open'), high: px(x, 'high'), low: px(x, 'low'), close: px(x, 'close') })));
    } else {
      (main as ISeriesApi<'Line'>).setData(data.map((x) => ({ time: t(x), value: px(x, 'close') })));
    }
    vol.setData(data.map((x) => ({
      time: t(x), value: Number(usdOk ? x.volumeUsd : x.volume),
      color: Number(x.close) >= Number(x.open) ? 'rgba(34,197,94,0.28)' : 'rgba(240,68,56,0.30)',
    })));
    c.api.priceScale('right').applyOptions({
      mode: scale === 'pct' ? PriceScaleMode.Percentage : scale === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, autoScale: true,
    });
    c.api.timeScale().fitContent();
    const byTime = new Map(data.map((x) => [x.time, x]));
    const onMove = (p: { time?: unknown }) => setHover(p.time != null ? byTime.get(p.time as number) ?? null : null);
    c.api.subscribeCrosshairMove(onMove);
    chart.current = { api: c.api, main, vol };
    return () => c.api.unsubscribeCrosshairMove(onMove);
  }, [data, style, unit, scale, usdOk]);

  // ── derived data ──
  const tradeList = trades.data?.trades ?? [];
  const launch = candles.data?.launchPrice != null ? Number(candles.data.launchPrice) * (usdOk ? Number(candles.data.usdPerNumeraire) : 1) : null;
  const nowS = Math.floor(clock.getTime() / 1000);
  const windows = WINDOWS.map(([k, secs]) => {
    const cur = priceAtTime(tradeList, nowS, launch, usdOk);
    const base = priceAtTime(tradeList, nowS - secs, launch, usdOk);
    const ch = cur != null && base ? ((cur - base) / base) * 100 : null;
    return { label: k, change: ch == null ? '—' : `${ch > 0 ? '+' : ''}${ch.toFixed(2)}%`, select: () => setWin(k),
      bg: win === k ? '#2A2640' : 'transparent', fg: (ch ?? 0) >= 0 ? '#34D399' : '#F87171' };
  });
  const winSecs = WINDOWS.find((w) => w[0] === win)![1];
  const inWin = tradeList.filter((x) => x.timestamp > nowS - winSecs);
  const buys = inWin.filter((x) => x.side !== 'sell'), sells = inWin.filter((x) => x.side === 'sell');
  const vol = (xs: Trade[]) => xs.reduce((a, x) => a + Number((usdOk ? x.valueUsd : x.numeraireAmount) ?? 0), 0);
  const fv = (n: number) => (usdOk ? fmtUsd(n) : `${compact(n)} ${numSym}`);
  const flows = [
    { label: 'Txns', a: buys.length, b: sells.length, aLabel: 'Buys', bLabel: 'Sells', aVal: String(buys.length), bVal: String(sells.length), total: String(inWin.length) },
    { label: 'Volume', a: vol(buys), b: vol(sells), aLabel: 'Buy vol', bLabel: 'Sell vol', aVal: fv(vol(buys)), bVal: fv(vol(sells)), total: fv(vol(buys) + vol(sells)) },
    { label: 'Traders', a: new Set(buys.map((x) => x.trader)).size, b: new Set(sells.map((x) => x.trader)).size, aLabel: 'Buyers', bLabel: 'Sellers',
      aVal: String(new Set(buys.map((x) => x.trader)).size), bVal: String(new Set(sells.map((x) => x.trader)).size), total: String(new Set(inWin.map((x) => x.trader)).size) },
  ].map((f) => ({ ...f, a: f.a || (f.b ? 0 : 1), b: f.b || (f.a ? 0 : 1) }));

  const holderCount = holders.data?.holderCount ?? token.data?.holders ?? 0;
  const tabs = ['Transactions', 'Top Traders', `Holders (${holderCount.toLocaleString('en-US')})`];
  const C = (text: string, align = 'right', extra: Record<string, unknown> = {}) => ({ text, align, fg: '#ECEAF4', weight: 400, plain: true, pill: false, ...extra });
  const sym = token.data?.symbol ?? '';
  let cols: [string, string][] = [];
  let rows: { cells: ReturnType<typeof C>[] }[] = [];
  let tableState: React.ReactNode = null;
  if (tab === 'Transactions') {
    cols = [['Date', 'left'], ['Type', 'left'], ['USD', 'right'], [sym, 'right'], [numSym, 'right'], ['Price', 'right'], ['Trader', 'right']];
    rows = tradeList.map((x) => {
      const fg = x.side === 'sell' ? '#FCA5A5' : x.isBuyback ? '#C4B5FD' : '#6EE7B7';
      const pillBg = x.side === 'sell' ? '#3A1623' : x.isBuyback ? '#2E2152' : '#0F2A22';
      return { cells: [
        C(`${ago(x.timestamp)} ago`, 'left', { fg: '#8C87A3' }),
        C(x.isBuyback ? 'Buyback' : x.side === 'buy' ? 'Buy' : 'Sell', 'left', { pill: true, plain: false, pillBg, pillFg: fg }),
        C(x.valueUsd != null ? Number(x.valueUsd).toFixed(2) : '—', 'right', { fg, weight: 600 }),
        C(compact(x.assetAmount), 'right', { fg }), C(compact(x.numeraireAmount), 'right', { fg }),
        C(x.priceUsd != null ? fmtUsd(x.priceUsd) : `${sig(Number(x.price), 3)} ${numSym}`, 'right', { fg, weight: 600 }),
        C(x.isBuyback ? 'Buyback vault' : shortAddr(x.trader), 'right', { fg: '#8C87A3' }),
      ] };
    });
    tableState = trades.isLoading ? <div style={{ padding: 12 }}><Loading rows={3} height={28} /></div>
      : trades.error ? <div style={{ padding: 12 }}><ErrorBox error={trades.error} /></div>
      : rows.length === 0 ? <div style={{ padding: 16, fontSize: 13, color: '#8C87A3' }}>No trades yet.</div> : null;
  } else if (tab === 'Top Traders') {
    cols = [['Rank', 'left'], ['Trader', 'left'], ['Bought', 'right'], ['Sold', 'right'], ['PnL', 'right'], ['Trades', 'right']];
    tableState = <div style={{ padding: 16, fontSize: 13, color: '#8C87A3' }}>Top traders are coming soon.</div>;
  } else {
    cols = [['Rank', 'left'], ['Address', 'left'], ['Share', 'right'], [sym, 'right'], ['Value', 'right']];
    const priceUsd = token.data?.market?.priceUsd != null ? Number(token.data.market.priceUsd) : null;
    rows = (holders.data?.holders ?? []).map((h, i) => ({ cells: [
      C(`#${i + 1}`, 'left', { fg: '#8C87A3' }),
      C(h.label ?? shortAddr(h.address), 'left', h.label ? { pill: true, plain: false, pillBg: '#1C1A29', pillFg: '#C9C5DA' } : { weight: 600 }),
      C(`${(h.pctBps / 100).toFixed(1)}%`), C(compact(h.balance)), C(priceUsd != null ? fmtUsd(Number(h.balance) * priceUsd) : '—'),
    ] }));
    tableState = holders.isLoading ? <div style={{ padding: 12 }}><Loading rows={3} height={28} /></div>
      : holders.error ? <div style={{ padding: 12 }}><ErrorBox error={holders.error} /></div> : null;
  }

  const shown = hover ?? data[data.length - 1] ?? null;
  const first = data[0];
  const last = data[data.length - 1];
  const chg = first && last ? ((px(last, 'close') - px(first, 'open')) / px(first, 'open')) * 100 : null;
  const rank = useMemo(() => {
    const sorted = [...(list.data?.tokens ?? [])].sort((a, b) => Number(b.market?.mcapUsd ?? 0) - Number(a.market?.mcapUsd ?? 0));
    const i = sorted.findIndex((x) => x.asset === asset.toLowerCase());
    return i >= 0 ? i + 1 : '—';
  }, [list.data, asset]);

  if (token.isLoading) return <PageShell><Loading rows={6} height={60} /></PageShell>;
  if (token.error) return <PageShell>{/Token not found/.test(String(token.error)) ? <Empty>This token is not listed on Astralaunch.</Empty> : <ErrorBox error={token.error} retry={() => token.refetch()} />}</PageShell>;
  const t = token.data!;
  const m = t.market;

  const v = {
    infoHref: `/token/${t.asset}`, chartHref: `/token/${t.asset}/chart`, sym: `$${t.symbol}`, symPlain: t.symbol, numSym, rank,
    timeframes: TF.map(([label, api]) => ({ label, select: () => api && setTf(label), bg: label === tf ? '#8B5CF6' : 'transparent', fg: label === tf ? '#FFFFFF' : '#ECEAF4',
      disabled: !api, title: api ? label : `${label} candles are not indexed` })),
    styles: seg(['Candles', 'Line'] as const, style, setStyle, '#2A2640', '#ECEAF4'),
    units: seg(['Price', 'Mcap'] as const, unit, setUnit, '#2A2640', '#ECEAF4'),
    tools: TOOLS.map(([name, d], i) => ({ name, d, select: () => {}, bg: i === 0 ? '#2E2152' : 'transparent', fg: i === 0 ? '#C4B5FD' : '#5F5A78',
      disabled: i !== 0, title: i === 0 ? name : `${name} (drawing tools are not available yet)` })),
    fullscreen: () => chartRef.current?.parentElement?.requestFullscreen?.(),
    pairLabel: `${t.symbol}/${usdOk ? 'USD' : numSym}`, unitName: unit === 'Mcap' ? 'Market Cap' : 'Price', tfLabel: tf,
    ohlc: shown ? { o: fmtPx(px(shown, 'open')), h: fmtPx(px(shown, 'high')), l: fmtPx(px(shown, 'low')), c: fmtPx(px(shown, 'close')) } : { o: '—', h: '—', l: '—', c: '—' },
    chgLabel: chg == null ? '' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, chgColor: (chg ?? 0) >= 0 ? '#6EE7B7' : '#FCA5A5',
    volLabel: shown ? (usdOk ? fmtUsd(shown.volumeUsd) : `${compact(shown.volume)} ${numSym}`) : '—',
    usdHint: usdOk ? null : <span style={{ fontSize: 11, color: '#8C87A3' }}>USD price unavailable · shown in {numSym}</span>,
    chartRef,
    chartState: candles.isLoading ? <div style={{ position: 'absolute', inset: 16 }}><Loading rows={4} height={80} /></div>
      : candles.error ? <div style={{ position: 'absolute', inset: 16 }}><ErrorBox error={candles.error} retry={() => candles.refetch()} /></div>
      : data.length === 0 ? <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8C87A3', fontSize: 13 }}>No trades yet, so no candles to draw.</div> : null,
    clock: `${clock.toISOString().slice(11, 19)} (UTC)`,
    scale: Object.fromEntries((['pct', 'log', 'auto'] as const).map((k) => [k, { pick: () => setScale(k), bg: scale === k ? '#1C1A29' : 'transparent', fg: scale === k ? '#ECEAF4' : '#C9C5DA' }])),
    tabs: tabs.map((l) => ({ label: l, select: () => setTab(l.startsWith('Holders') ? 'Holders' : l), bg: (tab === l || (tab === 'Holders' && l.startsWith('Holders'))) ? '#8B5CF6' : 'transparent',
      fg: (tab === l || (tab === 'Holders' && l.startsWith('Holders'))) ? '#FFFFFF' : '#ECEAF4' })),
    cols: cols.map(([label, align]) => ({ label, align })), rows, tableState,
    tagline: serviceLabel(t.name, t.service),
    priceUsd: m?.priceUsd != null ? fmtUsd(m.priceUsd) : <span>—<span style={{ display: 'block', fontSize: 10, color: '#8C87A3', fontWeight: 400 }}>USD price unavailable</span></span>,
    priceNum: m?.price ? `${sig(Number(m.price), 3)} ${numSym}` : '—',
    keyStats: [
      { label: 'Mkt cap', value: m?.mcapUsd != null ? fmtUsd(m.mcapUsd) : m?.price ? `${compact(Number(m.price) * Number(m.supply))} ${numSym}` : '—' },
      { label: 'FDV', value: m?.priceUsd != null ? fmtUsd(Number(m.priceUsd) * 1e9) : m?.price ? `${compact(Number(m.price) * 1e9)} ${numSym}` : '—' },
      { label: 'Holders', value: holderCount.toLocaleString('en-US') },
    ],
    windows, flows,
  };
  return <TokenChartView v={v} />;
}
