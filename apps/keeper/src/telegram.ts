/**
 * Telegram alerting for treasury and admin change proposals.
 *
 * Sends alerts when:
 *   - A new treasury proposal is detected / resolved (PlatformFeeReceiver)
 *   - A pending admin transfer is detected / resolved (RevpadRegistry or PlatformFeeReceiver)
 *
 * No-ops gracefully if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */
import type { Address, PublicClient } from 'viem';
import { pfrAbi, registryAdminAbi } from './jobs.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Dedupe: track the last alerted key for each monitor
let lastTreasuryKey = '';
let lastPfrAdminKey = '';
let lastRegistryAdminKey = '';

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
      if (key !== lastTreasuryKey) {
        const execDate = new Date(Number(executableAt) * 1000).toISOString();
        await sendTelegramAlert(
          `🔔 *Treasury Proposal Detected*\n` +
          `Proposed: \`${proposed}\`\n` +
          `Executable at: ${execDate}\n` +
          `PFR: \`${pfrAddress}\``
        );
        lastTreasuryKey = key;
      }
    } else {
      // No active proposal
      if (lastTreasuryKey && lastTreasuryKey !== key) {
        await sendTelegramAlert(
          `✅ *Treasury Proposal Resolved*\n` +
          `PFR: \`${pfrAddress}\``
        );
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
        await sendTelegramAlert(
          `🔔 *Admin Transfer Started — ${label}*\n` +
          `Pending admin: \`${pending}\`\n` +
          `Contract: \`${contractAddress}\``
        );
        return pending;
      }
    } else {
      if (lastKey && lastKey !== ZERO) {
        await sendTelegramAlert(
          `✅ *Admin Transfer Resolved — ${label}*\n` +
          `Contract: \`${contractAddress}\``
        );
        return ZERO;
      }
    }
  } catch (e) {
    console.error(`[telegram] monitorAdmin(${label}) error: ${e}`);
  }
  return lastKey;
}

/** Monitor admin transfers on both PlatformFeeReceiver and RevpadRegistry. */
export async function monitorAdminTransfers(
  pfrAddress: Address,
  registryAddress: Address,
  publicClient: PublicClient,
): Promise<void> {
  lastPfrAdminKey = await monitorAdminOnContract(
    'PlatformFeeReceiver', pfrAddress, pfrAbi, lastPfrAdminKey, publicClient,
  );
  lastRegistryAdminKey = await monitorAdminOnContract(
    'RevpadRegistry', registryAddress, registryAdminAbi, lastRegistryAdminKey, publicClient,
  );
}

/** Send a test alert to verify Telegram credentials. */
export async function dryRunTelegramAlert(): Promise<void> {
  await sendTelegramAlert('🧪 Revpad keeper Telegram alert — dry run OK');
}
