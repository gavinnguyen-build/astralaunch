# Off-chain decisions (server, indexer, keeper)

Contract decisions live in `packages/contracts/docs/decisions.md`.

## Launch fee + rate limit (2026-09-25)

Off-chain only: no contract changes. Code: `apps/server/src/services/launchFee.ts`,
`apps/server/src/routes/launchFee.ts`, `apps/indexer/src/writer.ts`, migration `0005_launch_fee.sql`.

**D-LF1: Fee.** 10 MON native (`LAUNCH_FEE_MON`, `LAUNCH_FEE_WEI` in `packages/shared/src/constants.ts`),
paid to `LAUNCH_FEE_TREASURY` (`0x888F…351C`, `addresses.ts`). Verification reads the tx from Monad and
requires: `to == treasury` (a direct transfer; value forwarded by a contract call does not count),
`value >= fee` (overpayment is accepted but covers one launch), receipt status success, and block
`<= finalized`. Launcher = `tx.from`. Receipts are unique by tx hash (lowercased).

**D-LF2: Rate limit.** At most 3 counted launches per launcher per rolling 24h. A launch counts once a
Registered event consumes a fee receipt. Checked at:
- verify time (wall clock): if the launcher already has 3 counted launches in the last 24h, the receipt
  is *not stored* and the call returns 429 with `nextSlotAt`. The payment stays valid on-chain and can
  be submitted again once a slot frees up.
- consume time (register block timestamp, so re-indexing is deterministic): a 4th registration in the
  window is indexed but not listed, and the receipt stays unused.
Admin listings (`source='admin'`) never count.

**D-LF3: Identity.** The launcher is the register() tx sender, read by the indexer through
`getTransaction`. The Registered event's `creator` (fee recipient) is never used for matching. Stored as
`idx_registrations.launcher`. Rows indexed before migration 0005 have `launcher = ''` and never match.

**D-LF4: Visibility.** A token is listed iff a fee receipt has `consumed_asset = token`. `/api/tokens`
(list, detail, all sub-resources), `/api/explorer` and `/api/creator/me` only return listed tokens;
unlisted ones 404. `GET /api/admin/tokens/unlisted` (Bearer `ADMIN_API_KEY`, disabled when unset)
shows the rest. Not filtered: `/api/services/*` and the `/s/*` gateway. They are service endpoints,
and hiding them would break paid calls.

**D-LF5: Matching.** On each Registered event the indexer, in the same DB transaction as the row insert,
consumes the launcher's oldest unused `source='fee'` receipt whose fee block `<=` the register block (the
fee must come before the launch). A per-launcher advisory lock serializes the check and the write.
`consumed_asset` is unique, so one receipt = one token, and re-indexing is a no-op.
Conservative addition: if verify runs *after* the indexer already saw the registration (the user
launched before calling verify), verify matches the oldest unlisted registration by that launcher at
or after the fee block. Without this, a paying user would stay hidden forever because of a race.

**D-LF6: Legacy tokens.** SIGHT (`0x30Ae…05aD`) and FEED (`0x2686…6dDf`) were launched before the fee.
`apps/server/src/scripts/listLegacyTokens.ts` writes a `source='admin'` receipt per asset (see runbook).
