/**
 * Telegram alerting for treasury, admin change, and initializer proposals.
 *
 * Sends alerts when:
 *   - A new treasury proposal is detected / resolved (PlatformFeeReceiver)
 *   - A pending admin transfer is detected / resolved (AstralaunchRegistry or PlatformFeeReceiver)
 *   - A new initializer proposal is detected / accepted / cancelled (AstralaunchRegistry)
 *
 * No-ops gracefully if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */
import type { Address, PublicClient } from 'viem';
import { pfrAbi, registryAdminAbi } from './jobs.js';
import { getPendingInitializerProposal, REGISTRY } from './chain.js';

// Dedupe: track the last alerted key for each monitor
let lastTreasuryKey = '';
let lastPfrAdminKey = '';
let lastRegistryAdminKey = '';
let lastInitializerKey = '';

// ── Formatting ──────────────────────────────────────────────────────────────
// Messages use Telegram HTML parse mode. Only &, < and > need escaping there, so every
// dynamic value is escaped by the `html` tag; formatting lives only in the literal parts.
// (Markdown mode broke on values containing _ * ` [ such as MAX_MON_PER_DAY.)

/** An HTML-formatted Telegram message whose dynamic parts are already escaped. */
export class TelegramHtml {
  constructor(readonly text: string) {}
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tagged template: literal parts are trusted HTML, every `${value}` is escaped. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): TelegramHtml {
  return new TelegramHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? escapeHtml(values[i]) : ''), ''));
}

/** Plain-text rendering of an HTML message (fallback if Telegram rejects the entities). */
export function htmlToPlain(msg: TelegramHtml): string {
  return msg.text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const SEND_TIMEOUT_MS = 5_000;

/**
 * Send a Telegram alert. Never throws and never blocks longer than the timeout
 * (per attempt): alert failures must not affect keeper jobs. A plain string is sent
 * as plain text (no parse mode). A TelegramHtml message is sent in HTML mode, and
 * resent once as plain text if Telegram rejects it (e.g. "can't parse entities").
 * No-op with a console log if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */
export async function sendTelegramAlert(message: string | TelegramHtml, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
  try {
    const plain = typeof message === 'string' ? message : htmlToPlain(message);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
      console.log(`[telegram] (no credentials) ${plain}`);
      return;
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const post = (body: Record<string, unknown>) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, disable_web_page_preview: true, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    let res = typeof message === 'string'
      ? await post({ text: message })
      : await post({ text: message.text, parse_mode: 'HTML' });
    if (!res.ok && res.status === 400 && typeof message !== 'string') {
      console.error(`[telegram] HTML rejected (${(await res.text()).slice(0, 200)}); resending as plain text`);
      res = await post({ text: plain });
    }
    if (!res.ok) console.error(`[telegram] API error: ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    // Never propagate: network errors, timeouts, bad JSON, anything.
    console.error(`[telegram] send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Check PlatformFeeReceiver for treasury change proposals and alert. */
export async function monitorTreasuryProposal(
  pfrAddress: Address,
  publicClient: PublicClient,
): Promise<void> {
  try {
    const [proposed, executableAt] = await publicClient.readContract({
      address: pfrAddress,
      abi: pfrAbi,
      functionName: 'pendingTreasury',
    });

    const key = `${proposed}-${executableAt}`;

    if (proposed !== '0x0000000000000000000000000000000000000000') {
      // Active proposal
      if (key !== lastTreasuryKey) {
        const execDate = new Date(Number(executableAt) * 1000).toISOString();
        await sendTelegramAlert(html`🔔 <b>Treasury Proposal Detected</b>
Proposed: <code>${proposed}</code>
Executable at: ${execDate}
PFR: <code>${pfrAddress}</code>`);
        lastTreasuryKey = key;
      }
    } else {
      // No active proposal
      if (lastTreasuryKey && lastTreasuryKey !== key) {
        await sendTelegramAlert(html`✅ <b>Treasury Proposal Resolved</b>
PFR: <code>${pfrAddress}</code>`);
        lastTreasuryKey = key;
      }
    }
  } catch (e) {
    console.error(`[telegram] monitorTreasuryProposal error: ${e}`);
  }
}

/** Check a contract for pending admin transfer and alert. */
async function monitorAdminOnContract(
  label: string,
  contractAddress: Address,
  abi: typeof pfrAbi | typeof registryAdminAbi,
  lastKey: string,
  publicClient: PublicClient,
): Promise<string> {
  try {
    const pending = await publicClient.readContract({
      address: contractAddress,
      abi,
      functionName: 'pendingAdmin',
    }) as string;

    const ZERO = '0x0000000000000000000000000000000000000000';

    if (pending !== ZERO) {
      if (pending !== lastKey) {
        await sendTelegramAlert(html`🔔 <b>Admin Transfer Started — ${label}</b>
Pending admin: <code>${pending}</code>
Contract: <code>${contractAddress}</code>`);
        return pending;
      }
    } else {
      if (lastKey && lastKey !== ZERO) {
        await sendTelegramAlert(html`✅ <b>Admin Transfer Resolved — ${label}</b>
Contract: <code>${contractAddress}</code>`);
        return ZERO;
      }
    }
  } catch (e) {
    console.error(`[telegram] monitorAdmin(${label}) error: ${e}`);
  }
  return lastKey;
}

/** Monitor admin transfers on both PlatformFeeReceiver and AstralaunchRegistry. */
export async function monitorAdminTransfers(
  pfrAddress: Address,
  registryAddress: Address,
  publicClient: PublicClient,
): Promise<void> {
  lastPfrAdminKey = await monitorAdminOnContract(
    'PlatformFeeReceiver', pfrAddress, pfrAbi, lastPfrAdminKey, publicClient,
  );
  lastRegistryAdminKey = await monitorAdminOnContract(
    'AstralaunchRegistry', registryAddress, registryAdminAbi, lastRegistryAdminKey, publicClient,
  );
}

/**
 * Monitor AstralaunchRegistry for initializer proposals.
 * Alerts when a new proposal is created, and when it is resolved (accepted or cancelled).
 */
export async function monitorInitializerProposal(): Promise<void> {
  try {
    const proposal = await getPendingInitializerProposal();

    if (proposal) {
      const key = `${proposal.initializer}-${proposal.adapter}-${proposal.executableAt}`;
      if (key !== lastInitializerKey) {
        const execDate = new Date(Number(proposal.executableAt) * 1000).toISOString();
        await sendTelegramAlert(html`🔔 <b>Initializer Proposal Detected</b>
Initializer: <code>${proposal.initializer}</code>
Adapter: <code>${proposal.adapter}</code>
Executable at: ${execDate}
Registry: <code>${REGISTRY}</code>`);
        lastInitializerKey = key;
      }
    } else {
      // No active proposal
      if (lastInitializerKey) {
        await sendTelegramAlert(html`✅ <b>Initializer Proposal Resolved</b>
Previous proposal accepted or cancelled.
Registry: <code>${REGISTRY}</code>`);
        lastInitializerKey = '';
      }
    }
  } catch (e) {
    console.error(`[telegram] monitorInitializerProposal error: ${e}`);
  }
}

/** Send a test alert to verify Telegram credentials. */
export async function dryRunTelegramAlert(): Promise<void> {
  await sendTelegramAlert('🧪 Astralaunch keeper Telegram alert — dry run OK');
}
