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

## Tokens come from chain (2026-09-25)

**D-TK1: Source of truth.** The indexer upserts the `tokens` row on each Registered event, in the same
transaction as the registration: asset, creator (event field), launcher (register() tx sender), router,
poolId, numeraire, initializer, register tx/block/time (`launched_at` = block time), and
name/symbol/decimals read from the ERC-20. Idempotent: re-indexing refreshes on-chain fields only and
never overwrites a known name/symbol/launcher with ''. An ERC-20 read that *reverts* falls back to
''/''/18 so the row still exists; an RPC error fails the chunk, which is retried.
Code: `apps/server/src/services/tokenSync.ts`, migration `0006_tokens_onchain.sql`.

**D-TK2: POST /api/tokens is metadata-only.** Fields: imageUrl, xHandle (new `x_handle` column; the
legacy `twitter` URL column is left as is), website, description. It needs a personal_sign by the token's
on-chain creator (`tokens.creator`) over `tokenMetadataMessage` (shared), which binds the asset, every
provided field and `issuedAt`. issuedAt must be within 10 min of server time and newer than the last
accepted update (`metadata_signed_at`), so an old signed update cannot be replayed. Unknown asset → 404:
it can no longer create tokens. Signing by the launcher alone is not accepted (conservative).
POST /api/services returns 403 for tokens that are not listed (D-LF4). The `/s/*` gateway and existing
services are not filtered.

**D-TK3: Backfill.** `apps/server/src/scripts/backfillTokens.ts` runs the same upsert for every
`idx_registrations` row and fills `idx_registrations.launcher` from the register tx where it is ''.
It does not change listing status (use `listLegacyTokens.ts` for that).
Also fixed: `tokens.launched_at` is TIMESTAMPTZ in SQL but was declared without a time zone in the drizzle
schema, which shifted reads by the host's UTC offset.

## Creator-signed service create/update (2026-09-25)

**D-SV1.** `POST /api/services` and `PATCH /api/services/:id` only accept a personal_sign by the token's
**on-chain creator**, taken from the `tokens` row the indexer writes from the Registered event. The body's
`creator` field is no longer accepted, and `router` also comes from the tokens row.
- Message: `serviceCreateMessage` / `serviceUpdateMessage` (shared) = a fixed header plus canonical JSON
  (fixed key order) of every provided field and `issuedAt`. Updates also bind the service id and asset.
  JSON is used instead of `key: value` lines so multi-line values (e.g. JSON schemas) cannot forge fields.
- Order of checks: token not registered → 404; not listed → 403; `issuedAt` more than 10 min from server
  time → 400; an update with `issuedAt` ≤ the last accepted one → 409; signer ≠ on-chain creator → 403.
- Replay: every accepted message's keccak256 is inserted into `signed_requests` in the same transaction
  as the write; an exact replay → 409. Keyed on the message, not the signature, so ECDSA signature
  malleability cannot bypass it. Updates are also monotonic on `services.auth_signed_at`.
- The PATCH response no longer returns `upstreamSecret`.
- Existing services created by the old, unsigned flow keep working (gateway unchanged). Their
  `creator` column may hold a client-supplied value, but it is no longer used for authorization.
