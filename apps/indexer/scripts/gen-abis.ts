#!/usr/bin/env npx tsx
/**
 * Generates apps/indexer/src/abis.ts from Foundry forge artifacts.
 *
 * Usage:  npx tsx apps/indexer/scripts/gen-abis.ts
 *   (or)  pnpm -F @astralaunch/indexer gen-abis
 *
 * Reads packages/contracts/out/{Contract}.sol/{Contract}.json for each
 * contract, extracts the named events, and writes a typed TypeScript file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname!, '../../..');
const OUT = path.join(ROOT, 'packages/contracts/out');
const DEST = path.join(ROOT, 'apps/indexer/src/abis.ts');

// ── Which events to extract from which contract ─────────────────────────────
// Only events we actually index. Admin events (PauseSet, AdminTransferred, etc.)
// are intentionally excluded.

const CONTRACTS: Record<string, { events: string[]; exportPrefix: string }> = {
  AstralaunchRegistry: {
    events: ['Registered'],
    exportPrefix: '',
  },
  RevenueRouter: {
    events: ['Distributed'],
    exportPrefix: '',
  },
  FeeEscrow: {
    events: ['FeeCollected', 'RevenueRecorded', 'Claimed', 'ClaimedWmon', 'Forfeited'],
    exportPrefix: 'escrow',
  },
  BuybackVault: {
    events: ['FeeCollected', 'BuybackExecuted', 'TokensBurned'],
    exportPrefix: 'vault',
  },
  PlatformFeeReceiver: {
    events: ['Collected'],
    exportPrefix: 'pfr',
  },
};

interface AbiInput {
  name: string;
  type: string;
  indexed: boolean;
  internalType?: string;
}

interface AbiEvent {
  type: 'event';
  name: string;
  inputs: AbiInput[];
  anonymous?: boolean;
}

function readArtifact(contract: string): AbiEvent[] {
  const filePath = path.join(OUT, `${contract}.sol`, `${contract}.json`);
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  return raw.abi.filter((x: any) => x.type === 'event');
}

function cleanInput(input: AbiInput): { name: string; type: string; indexed: boolean } {
  return { name: input.name, type: input.type, indexed: input.indexed };
}

// Explicit export name overrides to maintain stable API across regenerations.
// Events shared by multiple contracts (FeeCollected) get a prefix; unique events don't.
const EXPORT_NAMES: Record<string, Record<string, string>> = {
  AstralaunchRegistry: { Registered: 'registeredEvent' },
  RevenueRouter:       { Distributed: 'distributedEvent' },
  FeeEscrow: {
    FeeCollected:    'escrowFeeCollectedEvent',
    RevenueRecorded: 'revenueRecordedEvent',
    Claimed:         'claimedEvent',
    ClaimedWmon:     'claimedWmonEvent',
    Forfeited:       'forfeitedEvent',
  },
  BuybackVault: {
    FeeCollected:    'vaultFeeCollectedEvent',
    BuybackExecuted: 'buybackExecutedEvent',
    TokensBurned:    'tokensBurnedEvent',
  },
  PlatformFeeReceiver: { Collected: 'pfrCollectedEvent' },
};

function makeExportName(contract: string, _prefix: string, eventName: string): string {
  const override = EXPORT_NAMES[contract]?.[eventName];
  if (override) return override;
  const camel = eventName.charAt(0).toLowerCase() + eventName.slice(1);
  return `${camel}Event`;
}

// ── Generate ─────────────────────────────────────────────────────────────────

const lines: string[] = [
  '// AUTO-GENERATED from forge artifacts — do not edit by hand.',
  '// Regenerate: pnpm -F @astralaunch/indexer gen-abis',
  '//',
  `// Generated: ${new Date().toISOString().slice(0, 10)}`,
  '',
];

const staticExports: string[] = [];
const routerExports: string[] = [];

for (const [contract, { events: eventNames, exportPrefix }] of Object.entries(CONTRACTS)) {
  const allEvents = readArtifact(contract);
  lines.push(`// ── ${contract} ${'─'.repeat(Math.max(0, 67 - contract.length))}`);

  for (const name of eventNames) {
    const ev = allEvents.find(e => e.name === name);
    if (!ev) {
      console.error(`FATAL: event ${name} not found in ${contract} artifact`);
      process.exit(1);
    }

    const exportName = makeExportName(contract, exportPrefix, name);
    const inputs = ev.inputs.map(cleanInput);

    lines.push(`export const ${exportName} = {`);
    lines.push(`  type: 'event',`);
    lines.push(`  name: '${ev.name}',`);
    lines.push(`  inputs: [`);
    for (const inp of inputs) {
      lines.push(`    { name: '${inp.name}', type: '${inp.type}', indexed: ${inp.indexed} },`);
    }
    lines.push(`  ],`);
    lines.push(`} as const;`);
    lines.push('');

    // Classify into contract sets
    if (contract === 'RevenueRouter') {
      routerExports.push(exportName);
    } else {
      staticExports.push(exportName);
    }
  }
}

// USDC Transfer (ERC-20 standard, not from forge artifacts)
lines.push('// ── USDC (ERC-20 Transfer) ───────────────────────────────────────────────────');
lines.push(`export const transferEvent = {`);
lines.push(`  type: 'event',`);
lines.push(`  name: 'Transfer',`);
lines.push(`  inputs: [`);
lines.push(`    { name: 'from', type: 'address', indexed: true },`);
lines.push(`    { name: 'to', type: 'address', indexed: true },`);
lines.push(`    { name: 'value', type: 'uint256', indexed: false },`);
lines.push(`  ],`);
lines.push(`} as const;`);
lines.push('');

// Grouped ABI arrays
lines.push('// ── Grouped ABIs per contract set ────────────────────────────────────────────');
lines.push('');
lines.push('/** Static contract set: Registry + Escrow + Vault + PFR */');
lines.push(`export const staticEvents = [`);
for (const name of staticExports) {
  lines.push(`  ${name},`);
}
lines.push(`] as const;`);
lines.push('');
lines.push('/** Router contract set: RevenueRouter instances */');
lines.push(`export const routerEvents = [${routerExports.join(', ')}] as const;`);
lines.push('');
lines.push('/** USDC transfer contract set */');
lines.push(`export const usdcEvents = [transferEvent] as const;`);
lines.push('');

const output = lines.join('\n');
writeFileSync(DEST, output, 'utf8');
console.log(`Generated ${DEST}`);
console.log(`  Static events: ${staticExports.length} (${staticExports.join(', ')})`);
console.log(`  Router events: ${routerExports.length} (${routerExports.join(', ')})`);
console.log(`  USDC events: 1 (transferEvent)`);
