/**
 * /creator — docs/design/Creator.dc.html when the wallet has listed tokens, else CreatorEmpty.dc.html.
 * Wallet = connected wallet, or ?wallet=0x… for a read-only view. Claims and signed settings are Phase D.
 */
import { useEffect, useState } from 'react';
import { formatUnits, type Address, type Hex } from 'viem';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CreatorView } from '../design/CreatorView.js';
import { CreatorEmptyView } from '../design/CreatorEmptyView.js';
import { api, type CreatorDash } from '../lib/api.js';
import { TokenAvatar } from '../components/TokenAvatar.js';
import { avatarFor, compact, fmtDate, fmtTime, fmtUsdc } from '../lib/format.js';
import { ErrorBox, Loading } from '../components/State.js';
import { PRIVY_ENABLED, useConnectedWallet } from '../components/Site.js';
import { Actions, ErrorLine, Modal, Row, btnStyle } from '../components/Modal.js';
import { get } from '../lib/api.js';
import type { ChainConfig } from '../lib/launch.js';
import { loadServiceSettings, prepareCollectFees, prepareEscrowClaim, prepareRelease, saveService, type PreparedTx, type ServiceSettings } from '../lib/claims.js';
import { ServiceLinkForm, emptyServiceLink, serviceLinkErrors, toServiceLink, type ServiceLinkValue } from '../components/ServiceLinkForm.js';
import { ProtectApiCard } from '../components/ProtectApiCard.js';
import { TokenImageSetting } from '../components/TokenImageSetting.js';
import { ResponseSchemaField, SchemaMismatchNotice, compactSchema, prettySchema, responseSchemaError } from '../components/ResponseSchema.js';
import { errMsg, walletClients } from '../lib/wallet.js';
import { API_BASE } from '../env.js';
import { PageShell } from './Token.js';
import { AddrLink, TxLink } from '../components/Explorer.js';

const OK = '#34D399', BAD = '#F87171';
const NOTES: Record<string, string> = {
  upstream_error: 'Upstream error, not charged', verify_failed: 'Payment verification failed, not charged',
  settle_failed: 'Settlement failed, not charged',
};

export default function Creator() {
  const [params] = useSearchParams();
  const walletObj = useConnectedWallet();
  const connected = walletObj?.address ?? null;
  const cfg = useQuery({ queryKey: ['config'], queryFn: () => get<ChainConfig>('/api/config') });
  const [action, setAction] = useState<{ stage: 'preparing' | 'confirm' | 'sending' | 'done' | 'error'; title: string; tx?: PreparedTx; hash?: string; err?: string; sign?: boolean } | null>(null);
  const [svcLink, setSvcLink] = useState<ServiceLinkValue>(emptyServiceLink());
  const [settings, setSettings] = useState<ServiceSettings | null>(null);
  const [schemaText, setSchemaText] = useState('');
  const [revealing, setRevealing] = useState(false);
  const wallet = (params.get('wallet') ?? connected ?? '').toLowerCase();
  const valid = /^0x[0-9a-f]{40}$/.test(wallet);
  const [sel, setSel] = useState(0);
  const dash = useQuery({ queryKey: ['creator', wallet], queryFn: () => api.creator(wallet), enabled: valid });
  const list = useQuery({ queryKey: ['tokens', 30], queryFn: () => api.tokens(30), enabled: valid });
  const tok = dash.data?.tokens[Math.min(sel, (dash.data?.tokens.length ?? 1) - 1)];
  const detail = useQuery({ queryKey: ['token', tok?.asset], queryFn: () => api.token(tok!.asset), enabled: !!tok });

  useEffect(() => {
    // The link is private: fields start empty (price public) until the creator signs to show the settings.
    const s0 = dash.data?.services.find((x) => x.asset === tok?.asset);
    setSvcLink(emptyServiceLink(s0 ? formatUnits(BigInt(s0.priceUsdc), 6) : '0.02'));
    setSettings(null);
    setSchemaText('');
  }, [tok?.asset, dash.data]);

  if (!valid) return <CreatorEmptyView v={{}} />;
  if (dash.isLoading) return <PageShell><Loading rows={5} height={70} /></PageShell>;
  if (dash.error) return <PageShell><ErrorBox error={dash.error} retry={() => dash.refetch()} /></PageShell>;
  const d = dash.data as CreatorDash;
  if (d.tokens.length === 0 || !tok) return <CreatorEmptyView v={{}} />;

  const rev30 = (asset: string) => list.data?.tokens.find((x) => x.asset === asset)?.usage30d?.cleanRevenueUsdc ?? '0';
  const svc = d.services.find((s) => s.asset === tok.asset) ?? null;
  const health = detail.data?.serviceHealth;
  const esc = tok.escrow;
  const unlocked = esc ? Math.min(Number(esc.usdcAccrued), Number(esc.recordedRevenue) * 0.2) : 0;
  const vest = tok.vesting;
  const logs = svc ? d.recentRequests.filter((r) => r.service === svc.slug) : [];

  const isOwner = !!connected && connected.toLowerCase() === wallet && !!walletObj && !!cfg.data;
  const ownerTitle = !PRIVY_ENABLED ? 'Set VITE_PRIVY_APP_ID to connect a wallet' : !connected ? 'Connect the creator wallet' : connected.toLowerCase() !== wallet ? 'Only the creator wallet can do this' : '';
  async function run(title: string, prep: (c: Awaited<ReturnType<typeof walletClients>>) => Promise<PreparedTx>) {
    setAction({ stage: 'preparing', title });
    try {
      const c = await walletClients(walletObj!, cfg.data!);
      setAction({ stage: 'confirm', title, tx: await prep(c) });
    } catch (e) { setAction({ stage: 'error', title, err: errMsg(e) }); }
  }
  async function confirmTx() {
    if (!action?.tx) return;
    const tx = action.tx;
    setAction({ ...action, stage: 'sending' });
    try { const hash = await tx.send(); setAction({ ...action, stage: 'done', hash }); dash.refetch(); }
    catch (e) { setAction({ ...action, stage: 'error', err: errMsg(e) }); }
  }
  const slugFor = (sym: string) => (sym.toLowerCase().length >= 3 ? sym.toLowerCase() : `${sym.toLowerCase()}-api`);
  async function onReveal() {
    if (!svc) return;
    setRevealing(true);
    try {
      const c = await walletClients(walletObj!, cfg.data!);
      const st = await loadServiceSettings(c.walletClient, c.account, API_BASE, svc.id, tok!.asset as Address);
      setSettings(st);
      setSchemaText(prettySchema(st.responseSchema));
      setSvcLink((v) => ({ ...v, apiLink: st.apiLink ?? '', wholeDomain: st.wholeDomain,
        sampleMethod: st.sampleRequest?.method ?? '', sampleBody: st.sampleRequest?.body ?? '' }));
    } catch (e) { setAction({ stage: 'error', title: 'Service settings', err: errMsg(e), sign: true }); }
    finally { setRevealing(false); }
  }
  async function onSave() {
    setAction({ stage: 'sending', title: svc ? 'Save service settings' : 'Attach your API', sign: true });
    try {
      // A new service needs the link; an update may change only the price or the key (empty link = keep it).
      const errs = serviceLinkErrors(svcLink).filter((e) => svc && !svcLink.apiLink.trim() ? !/link|https|Paste/i.test(e) : true);
      if (errs.length) throw new Error(errs[0]);
      const schemaErr = responseSchemaError(schemaText);
      if (schemaErr) throw new Error(`Response schema: ${schemaErr}`);
      // Response schema: known only once the settings are shown; send it when it differs ('' removes it).
      const schemaChanged = !!settings && compactSchema(schemaText) !== compactSchema(settings.responseSchema ?? '');
      const c = await walletClients(walletObj!, cfg.data!);
      const f = toServiceLink(svcLink);
      const linkChanged = !!f.apiLink && (!settings || f.apiLink !== settings.apiLink || !!f.wholeDomain !== settings.wholeDomain);
      // Sample: send when it differs from what is stored ('' removes a stored one); unknown until the settings are shown.
      const stored = settings?.sampleRequest ?? null;
      const formSample = svcLink.sampleMethod ? `${svcLink.sampleMethod} ${svcLink.sampleMethod === 'POST' ? svcLink.sampleBody.trim() : ''}` : '';
      const storedSample = stored ? `${stored.method} ${stored.method === 'POST' ? stored.body ?? '' : ''}` : '';
      const sampleChanged = settings ? formSample !== storedSample : !!svcLink.sampleMethod;
      const priceChanged = !svc || f.priceUsdc !== BigInt(svc.priceUsdc);
      await saveService(c.walletClient, c.account, API_BASE, {
        existingId: svc?.id, asset: tok!.asset as Address, slug: slugFor(tok!.symbol), name: tok!.name,
        ...(priceChanged ? { priceUsdc: f.priceUsdc } : {}),
        ...(linkChanged || !svc ? { apiLink: f.apiLink, wholeDomain: f.wholeDomain } : {}),
        ...(f.apiKey ? { apiKey: f.apiKey } : {}),
        ...(!svc || sampleChanged ? { sampleMethod: svcLink.sampleMethod, sampleBody: svcLink.sampleBody.trim() || undefined } : {}),
        ...(svc && schemaChanged ? { responseSchema: compactSchema(schemaText) } : {}),
      });
      setAction({ stage: 'done', title: svc ? 'Service settings saved' : 'API attached', sign: true });
      setSettings(null); dash.refetch();
    } catch (e) { setAction({ stage: 'error', title: 'Service settings', err: errMsg(e), sign: true }); }
  }
  const esc0 = tok.escrow, fees0 = tok.tradingFees, vest0 = tok.vesting;
  const modal = action && (
    <Modal title={action.title} onClose={() => action.stage !== 'sending' && setAction(null)}>
      {action.stage === 'preparing' && <p style={{ margin: 0 }}>Simulating…</p>}
      {action.stage === 'confirm' && action.tx && (
        <div>
          <Row k="Contract"><AddrLink a={action.tx.contract} /></Row>
          <Row k="Call">{action.tx.fn}({action.tx.args.map((a) => (a.length > 20 ? `${a.slice(0, 10)}…` : a)).join(', ')})</Row>
          <Row k="Simulation">ok</Row>
          <Row k="Gas (×1.1)">{action.tx.gas.toString()} · ≈ {Number(formatUnits(action.tx.gas * action.tx.gasPrice, 18)).toFixed(6)} MON</Row>
          <Actions><button type="button" style={btnStyle(false)} onClick={() => setAction(null)}>Cancel</button><button type="button" style={btnStyle(true)} onClick={confirmTx}>Confirm</button></Actions>
        </div>
      )}
      {action.stage === 'sending' && <p style={{ margin: 0 }}>{action.sign ? 'Sign the message in your wallet…' : 'Confirm in your wallet and wait for the transaction…'}</p>}
      {action.stage === 'done' && (
        <div><p style={{ margin: 0 }}>Done.{action.hash ? <> Transaction <TxLink h={action.hash} />.</> : ''}</p>
          <Actions><button type="button" style={btnStyle(true)} onClick={() => setAction(null)}>Close</button></Actions></div>
      )}
      {action.stage === 'error' && (<div><ErrorLine msg={action.err ?? 'Failed'} /><Actions><button type="button" style={btnStyle(false)} onClick={() => setAction(null)}>Close</button></Actions></div>)}
    </Modal>
  );

  const v = {
    wallet: <AddrLink a={wallet} label={`${wallet.slice(0, 10)}…${wallet.slice(-6)}`} />,
    tokens: d.tokens.map((t, i) => ({
      on: t.asset === tok.asset, pick: (e: React.MouseEvent) => { e.preventDefault(); setSel(i); }, href: `/token/${t.asset}`,
      avatarNode: <TokenAvatar token={t} initial={t.symbol.charAt(0)} background={avatarFor(t.asset)} size={36} radius={10} fontSize={15} />, sym: `$${t.symbol}`, sub: `${t.name} · ${fmtUsdc(rev30(t.asset))} USDC 30d`,
    })),
    claims: [
      { title: 'Trading fees', sub: '', big: tok.tradingFees ? `${compact(tok.tradingFees.numeraire)} ${tok.numeraireSymbol === 'MON' ? 'WMON' : 'USDC'}` : '—', color: '#ECEAF4',
        lines: [{ k: 'Also in tokens', v: tok.tradingFees ? `${compact(tok.tradingFees.asset)} ${tok.symbol}` : '—' }, { k: 'Basis', v: 'estimate' }],
        cta: 'Claim trading fees', border: '1px solid #25213A', bg: '#13111C', btnBg: '#8B5CF6', btnBorder: '0',
        disabled: !isOwner || !fees0 || (Number(fees0.numeraire) === 0 && Number(fees0.asset) === 0), btnTitle: ownerTitle || 'Collect your share of the pool fees',
        onClick: () => run('Claim trading fees', (c) => prepareCollectFees(c.publicClient, c.walletClient, c.account, tok.poolId as Hex)) },
      { title: 'Escrow', sub: '', big: esc?.claimable != null ? `${compact(esc.claimable)} ${esc.claimableSymbol}` : '—', color: '#34D399',
        lines: esc ? [
          { k: 'Collected from trading', v: `${fmtUsdc(esc.usdcAccrued)} USDC` }, { k: 'Unlocked by usage', v: `${fmtUsdc(unlocked)} USDC` },
          { k: 'Already claimed', v: `${fmtUsdc(esc.usdcClaimed)} USDC` }, { k: 'Unclaimed goes to buyback', v: esc.forfeited ? 'Forfeited' : fmtDate(esc.forfeitAt) },
        ] : [{ k: 'Escrow', v: 'unavailable' }],
        cta: esc?.claimable != null ? `Claim ${compact(esc.claimable)} ${esc.claimableSymbol}` : 'Claim', border: '1px solid #1F6B52', bg: '#0F221D', btnBg: '#10825F', btnBorder: '0',
        disabled: !isOwner || !esc0 || !(Number(esc0.claimable ?? 0) > 0), btnTitle: ownerTitle || 'Claim the escrow unlocked by usage',
        onClick: () => run('Claim escrow', (c) => prepareEscrowClaim(c.publicClient, c.walletClient, c.account, cfg.data!.contracts.escrow, tok.asset as Address)) },
      { title: 'Allocation', sub: '15% of supply. 30-day cliff, linear to one year.', big: vest ? `${compact(vest.releasable)} ${tok.symbol}` : '—', color: '#C4B5FD',
        lines: vest ? [{ k: 'Total', v: compact(vest.total) }, { k: 'Claimed', v: compact(vest.released) }, { k: 'Locked', v: compact(vest.locked) }] : [{ k: 'Vesting', v: 'unavailable' }],
        cta: vest ? `Release ${compact(vest.releasable)} ${tok.symbol}` : 'Release', border: '1px solid #25213A', bg: '#13111C', btnBg: 'transparent', btnBorder: '1px solid #8B5CF6',
        disabled: !isOwner || !vest0 || !(Number(vest0.releasable) > 0), btnTitle: ownerTitle || (vest0 && Number(vest0.releasable) === 0 ? 'Nothing releasable yet (30-day cliff)' : 'Release vested tokens'),
        onClick: () => run('Release vested tokens', (c) => prepareRelease(c.publicClient, c.walletClient, c.account, tok.asset as Address)) },
    ],
    svcStatus: !svc ? 'Not attached yet' : !svc.active ? 'Paused'
      : health?.uptime7d != null ? `Live · ${(health.uptime7d * 100).toFixed(1)}% uptime, 7d` : 'Live',
    svcColor: !svc || !svc.active ? '#8C87A3' : '#34D399',
    serviceForm: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {svc && !settings ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px', color: '#A7A2BD' }}>
            Your current link is private.
            <button type="button" onClick={onReveal} disabled={!isOwner || revealing} title={ownerTitle || 'Sign (free) to show your link and settings'}
              style={{ height: '32px', padding: '0 14px', borderRadius: '999px', border: '1px solid #3A3456', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer' }}>
              {revealing ? 'Waiting for your signature…' : 'Show my settings'}
            </button>
            <span style={{ color: '#8C87A3' }}>or paste a new link below to replace it. Signing also shows responses that failed your schema.</span>
          </div>
        ) : null}
        <SchemaMismatchNotice settings={settings} />
        <ServiceLinkForm value={svcLink} onChange={setSvcLink} slug={svc?.slug ?? slugFor(tok.symbol)} agentBase={API_BASE || window.location.origin}
          keySet={settings?.apiKey ?? null} disabled={!isOwner}
          advancedExtra={svc ? <ResponseSchemaField value={schemaText} onChange={setSchemaText} settings={settings} disabled={!isOwner} /> : null} />
      </div>
    ),
    imageCard: tok ? (
      <TokenImageSetting token={tok} avatar={avatarFor(tok.asset)} wallet={walletObj} config={cfg.data}
        canEdit={isOwner} editTitle={ownerTitle || undefined} onSaved={() => { void dash.refetch(); }} />
    ) : null,
    protectCard: svc ? (
      <ProtectApiCard settings={settings} onReveal={onReveal} canReveal={isOwner} revealTitle={ownerTitle || undefined} busy={revealing} />
    ) : null,
    onSave, saveDisabled: !isOwner, saveTitle: ownerTitle || 'Sign and save (no gas)',
    modal,
    logs: logs.map((r) => ({
      t: r.settleTxHash ? <TxLink h={r.settleTxHash} label={fmtTime(r.createdAt)} /> : fmtTime(r.createdAt), s: String(r.statusCode ?? '—'), color: r.charged ? OK : BAD,
      lat: r.latencyMs == null ? '—' : `${r.latencyMs.toLocaleString('en-US')} ms`,
      ch: r.charged ? `${fmtUsdc(r.amountUsdc)} USDC` : 'No',
      note: r.charged ? 'Settled by facilitator' : NOTES[r.errorCode ?? ''] ?? 'Not charged',
    })),
    logsState: !svc ? <div style={{ padding: '14px 0', fontSize: '13px', color: '#8C87A3' }}>No calls yet. Paste your API link above and sign to attach it.</div>
      : logs.length === 0 ? <div style={{ padding: '14px 0', fontSize: '13px', color: '#8C87A3' }}>No calls yet.</div> : null,
  };
  return <CreatorView v={v} />;
}
