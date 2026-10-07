/**
 * /docs — how Astralaunch works, for builders and for agents. Numbers come from @astralaunch/shared (the same
 * constants the contracts mirror) and contract addresses from /api/config, so the page never drifts from the code.
 */
import { useQuery } from '@tanstack/react-query';
import {
  BUYBACK_BPS, BUYBACK_SHARE_WAD, CREATOR_SHARE_WAD, DOPPLER_SHARE_WAD, ESCROW_SHARE_WAD, ESCROW_UNLOCK_BPS, FORFEIT_DELAY_S,
  LAUNCH_FEE_MON, LAUNCH_RATE_LIMIT, POOL_FEE, PROVIDER_BPS, TREASURY_BPS, TREASURY_SHARE_WAD, VESTING_CLIFF_S, VESTING_DURATION_S,
} from '@astralaunch/shared';
import { get } from '../lib/api.js';
import type { ChainConfig } from '../lib/launch.js';
import { AddrLink } from '../components/Explorer.js';
import { A } from '../components/A.js';
import { API_BASE } from '../env.js';
import { PageShell } from './Token.js';
import './Docs.css';

const pct = (bps: number) => `${bps / 100}%`;
const wadPct = (w: bigint) => `${Number((w * 10_000n) / 10n ** 18n) / 100}%`;
const days = (s: number) => Math.round(s / 86_400);

const SECTIONS = [
  ['what', 'What Astralaunch is'],
  ['launch', 'Launch a token'],
  ['service', 'Attach your API'],
  ['agents', 'Call a service (agents)'],
  ['money', 'Where the money goes'],
  ['usage', 'Usage vs hype'],
  ['contracts', 'Contracts'],
  ['faq', 'FAQ'],
] as const;

export default function Docs() {
  const cfg = useQuery({ queryKey: ['config'], queryFn: () => get<ChainConfig>('/api/config') });
  const c = cfg.data?.contracts;
  const gateway = (API_BASE || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');
  return (
    <PageShell active="docs">
      <div className="docs">
        <aside className="docs-toc" aria-label="On this page">
          <span className="docs-toc-title">On this page</span>
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
        <article className="docs-body">
          <header>
            <h1>Docs</h1>
            <p className="docs-lead">Astralaunch is the onchain launchpad for services AI agents pay to use. Each service gets a token on Monad, and every paid call funds that token&apos;s buyback.</p>
          </header>

          <section id="what">
            <h2>What Astralaunch is</h2>
            <p>Agents don&apos;t sign up or subscribe. They call an API and pay per request with <strong>x402</strong>: the payment travels inside a normal HTTP request, in USDC, with no account and no API key.</p>
            <p>On Astralaunch a builder pastes the link of an API they already run and sets a price per call. Astralaunch launches a token for it on Monad (a Uniswap v4 pool) and puts an x402 paywall in front of the API. Revenue from calls is split onchain, and part of it buys back and burns the token, so the token is backed by real usage.</p>
          </section>

          <section id="launch">
            <h2>Launch a token</h2>
            <ol>
              <li><strong>Fill in the token.</strong> Name, ticker, a brief description (max 200 characters) and an optional image. The image and description are part of the launch signature and can&apos;t be changed later.</li>
              <li><strong>Pick the pairing.</strong> USDC (recommended: services are paid in USDC, so each usage buyback is a single swap) or MON.</li>
              <li><strong>Attach your API now or later.</strong> See the next section.</li>
              <li><strong>Sign once, send one transaction.</strong> It pays the {LAUNCH_FEE_MON} MON launch fee, creates the token and its pool, and registers it. One signature saves the token details and the service. The confirmation shows the MON gas estimate first.</li>
            </ol>
            <div className="docs-facts">
              <div><span>Supply</span><strong>1,000,000,000</strong></div>
              <div><span>In the pool</span><strong>85%</strong></div>
              <div><span>Creator allocation</span><strong>15%, {days(VESTING_CLIFF_S)}-day cliff, vests over {days(VESTING_DURATION_S)} days</strong></div>
              <div><span>Pool fee</span><strong>{POOL_FEE / 10_000}% per trade</strong></div>
              <div><span>Launch fee</span><strong>{LAUNCH_FEE_MON} MON</strong></div>
              <div><span>Launches per wallet</span><strong>{LAUNCH_RATE_LIMIT} per 24 hours</strong></div>
            </div>
            <p>The pool starts with tokens only: you don&apos;t deposit USDC or MON. Liquidity can&apos;t be withdrawn by anyone, including the creator and Astralaunch: there is no migration and no governance over the pool. New tokens cap each wallet at 1% of supply for the first minutes after launch, so the first buyers get a fair start.</p>
          </section>

          <section id="service">
            <h2>Attach your API</h2>
            <p>Paste the link you already use to call your API, for example <code>https://myagent.ai/v1/ask?q=hello</code>, and set one price per call in USDC. Astralaunch calls the link once to check that it answers before anything is saved. Under Advanced you can add an API key header (stored encrypted, sent with every forwarded call), a sample request for POST-only APIs, and an optional response schema.</p>
            <p><strong>Protect your API.</strong> The gateway sends a secret header on every call it forwards. Reject calls without it, so nobody can call your API directly for free. The Creator page shows the secret and ready-made snippets after you sign.</p>
          </section>

          <section id="agents">
            <h2>Call a service (agents)</h2>
            <p>Every service has one agent link: <code>{gateway}/s/&lt;slug&gt;/&lt;path&gt;</code>. Any x402 client can call it:</p>
            <ol>
              <li>The first request returns <code>402 Payment Required</code> with the price, the USDC token and the token&apos;s revenue router as the payee.</li>
              <li>The agent signs a USDC transfer authorization (EIP-3009, no gas) and repeats the request with the payment header.</li>
              <li>The gateway forwards the call. It settles the payment only after your API answers successfully (and matches its response schema, if it has one). <strong>Failed calls are never charged.</strong></li>
            </ol>
            <p>The service manifest for agents is at <code>{gateway}/api/services/&lt;slug&gt;/manifest</code>. On a token page, &ldquo;Try a sample call&rdquo; runs the same flow from your wallet.</p>
          </section>

          <section id="money">
            <h2>Where the money goes</h2>
            <h3>Every paid call (USDC, split onchain by the token&apos;s revenue router)</h3>
            <div className="docs-split">
              <div style={{ flexBasis: pct(PROVIDER_BPS) }} className="s-provider"><strong>{pct(PROVIDER_BPS)}</strong><span>to the service provider</span></div>
              <div style={{ flexBasis: pct(BUYBACK_BPS) }} className="s-buyback"><strong>{pct(BUYBACK_BPS)}</strong><span>buys back and burns the token</span></div>
              <div style={{ flexBasis: pct(TREASURY_BPS) }} className="s-platform"><strong>{pct(TREASURY_BPS)}</strong><span>platform</span></div>
            </div>
            <h3>Every trade ({POOL_FEE / 10_000}% pool fee)</h3>
            <ul className="docs-list">
              <li><strong>{wadPct(CREATOR_SHARE_WAD)}</strong> to the creator, claimable any time</li>
              <li><strong>{wadPct(ESCROW_SHARE_WAD)}</strong> to the creator&apos;s escrow, unlocked by usage</li>
              <li><strong>{wadPct(BUYBACK_SHARE_WAD)}</strong> to the buyback vault</li>
              <li><strong>{wadPct(TREASURY_SHARE_WAD)}</strong> to the platform treasury</li>
              <li><strong>{wadPct(DOPPLER_SHARE_WAD)}</strong> to the Doppler protocol</li>
            </ul>
            <h3>Escrow</h3>
            <p>Each 1 USDC of service revenue unlocks {ESCROW_UNLOCK_BPS / 10_000} USDC of the creator&apos;s escrowed trading fees. Escrow that is never unlocked goes to the buyback vault {days(FORFEIT_DELAY_S)} days after launch. Paying your own service costs more than it unlocks, so faking usage doesn&apos;t pay.</p>
          </section>

          <section id="usage">
            <h2>Usage vs hype</h2>
            <p><strong>Clean revenue</strong> counts USDC paid for calls and settled by the x402 facilitator, excluding the creator&apos;s own wallets and platform contracts. The contracts count every inflow; the filter is for display only.</p>
            <p><strong>Usage coverage</strong> compares the buyback funded by usage with the buyback funded by trading over 30 days. Above 1.0, the token is backed by usage more than by trading volume. Discover and the Leaderboard rank by clean revenue.</p>
          </section>

          <section id="contracts">
            <h2>Contracts</h2>
            <p>All Astralaunch contracts are verified on Monadscan. Each token&apos;s revenue router is a minimal clone of the verified RevenueRouter implementation.</p>
            <dl className="docs-contracts">
              <div><dt>AstralaunchRegistry</dt><dd>{c ? <AddrLink a={c.registry} /> : '…'}</dd></div>
              <div><dt>FeeEscrow</dt><dd>{c ? <AddrLink a={c.escrow} /> : '…'}</dd></div>
              <div><dt>BuybackVault</dt><dd>{c ? <AddrLink a={c.vault} /> : '…'}</dd></div>
              <div><dt>PlatformFeeReceiver</dt><dd>{c ? <AddrLink a={c.platformFeeReceiver} /> : '…'}</dd></div>
              {cfg.data?.launchHelper ? <div><dt>LaunchHelper</dt><dd><AddrLink a={cfg.data.launchHelper} /></dd></div> : null}
            </dl>
          </section>

          <section id="faq">
            <h2>FAQ</h2>
            <details><summary>Do I need to add liquidity?</summary><p>No. The pool starts with tokens only; USDC or MON enters the pool when people buy.</p></details>
            <details><summary>Can the pool be drained?</summary><p>No. Nobody can withdraw the pool&apos;s liquidity. Only the {POOL_FEE / 10_000}% trading fees are collected, by the beneficiaries listed above.</p></details>
            <details><summary>What if my API is down?</summary><p>Calls that fail are not charged, and the token page shows the service&apos;s success rate and uptime.</p></details>
            <details><summary>Can I change the price or the link later?</summary><p>Yes, from the Creator page, with a signature from your wallet (no gas). The token image and description are set once at launch.</p></details>
          </section>

          <p className="docs-cta"><A href="/launch">Launch a token</A> or <A href="/discover">browse services</A>.</p>
        </article>
      </div>
    </PageShell>
  );
}
