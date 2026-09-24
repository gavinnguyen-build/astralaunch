/**
 * Telegram alerting for treasury change proposals on PlatformFeeReceiver.
 *
 * Sends alerts when:
 *   - A new treasury proposal is detected
 *   - A previously active proposal is resolved (accepted or cancelled)
 *
 * No-ops gracefully if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */
import type { Address, PublicClient } from 'viem';
import { pfrAbi } from './jobs.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Dedupe: track the last alerted proposal key
let lastAlertedKey = '';

/** Send a Telegram message. No-op with console log if no credentials. */
export async function sendTelegramAlert(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(`[telegram] (no credentials) ${message}`);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' }),
    });
    if (!res.ok) {
      console.error(`[telegram] API error: ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error(`[telegram] send failed: ${e}`);
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
      if (key !== lastAlertedKey) {
        const execDate = new Date(Number(executableAt) * 1000).toISOString();
        await sendTelegramAlert(
          `🔔 *Treasury Proposal Detected*\n` +
          `Proposed: \`${proposed}\`\n` +
          `Executable at: ${execDate}\n` +
          `PFR: \`${pfrAddress}\``
        );
        lastAlertedKey = key;
      }
    } else {
      // No active proposal
      if (lastAlertedKey && lastAlertedKey !== key) {
        await sendTelegramAlert(
          `✅ *Treasury Proposal Resolved*\n` +
          `PFR: \`${pfrAddress}\``
        );
        lastAlertedKey = key;
      }
    }
  } catch (e) {
    console.error(`[telegram] monitorTreasuryProposal error: ${e}`);
  }
}

/** Send a test alert to verify Telegram credentials. */
export async function dryRunTelegramAlert(): Promise<void> {
  await sendTelegramAlert('🧪 Revpad keeper Telegram alert — dry run OK');
}
