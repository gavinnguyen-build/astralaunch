# Verification: one API link services, 2026-09-30

What: the "one API link" service model (docs/decisions.md D-SL1..D-SL9): the gateway forwarding any request,
streaming, the charge rule, the protected upstream, the encrypted API key, the link check, and the protection probe.

## Official facilitator: payment window (read-only)

The payment window rises to 150 s, because an authorization must outlive a 120 s upstream call. I checked this
against `https://x402-facilitator.molandak.org` with verify-only calls. The payer was a freshly generated wallet
holding 0 USDC, so nothing could settle; no settle call was made.

| Window | Result |
|---|---|
| 60 s (previous) | `insufficient_funds` |
| 150 s | `insufficient_funds` |
| 300 s | `insufficient_funds` |
| Control: 1 s, verified 7 s later | `invalid_payment_expired` |

The facilitator checks time before balance (see the control), so it accepts the longer windows. In the SDK
facilitator (`@x402/evm` 2.26) the only time rule is `validBefore ≥ now + 6 s`.

## Fork end-to-end with real payments

Script: `apps/server/scripts/fork-service-link-e2e.ts`.

Setup:
- a local Anvil fork of Monad mainnet on :8546;
- the local SDK facilitator on :4022 (the server's fork guard refuses any non-local facilitator);
- the server on :3103 with a scratch DB and production `PAYMENT_TIMEOUT_SECONDS=60`;
- a purpose-built upstream on :4031.

The agent (Anvil #5) pays in fork USDC through the x402 SDK client. `payTo` is the real v2 SIGHT router. Each
charge was checked on-chain: the agent's USDC went down by exactly the price, and the router's went up by it.

```
PASS service created from the pasted link (201, kind json)
PASS JSON GET → 200 {"answer":"hello monad"}
PASS JSON GET charged 20000 (router +20000)
PASS payment window 150s covers the 120 s timeout
PASS upstream received the API key and the protect secret
PASS Server / X-Powered-By stripped
PASS JSON POST → {"echo":{"q":"post","n":[1,2]}}
PASS JSON POST charged 20000
PASS SSE → 200 text/event-stream
PASS SSE: all events delivered
PASS SSE: 3 chunks, gaps 151 / 303 ms (streamed, not buffered)
PASS SSE charged once: 20000
PASS multipart → 200 image/png, 19 bytes identical
PASS multipart charged 20000
PASS session s-1790784772185 round-trip (turn 2)
PASS each session call charged once
PASS upstream 500 → 502, charged 0
PASS error scrubbed: {"error":"Upstream returned an error; you were not charged","upstreamStatus":500,"upstreamBody":"{\"error\":\"model overloaded at <upstream>/v1\"}"}
PASS direct call without the secret answered → unprotected
PASS after requiring the secret → protected
PASS paid calls through the gateway still work once protected
ALL CHECKS PASSED
```

## Moving the legacy services

The same fork stack, with demo-services on :4001 and a legacy `nullsight` row (http upstream with a `/sight` prefix,
no link). `astralaunch-anvil/src/mainnet-register-service.ts` sent a signed PATCH with
`API_LINK=…/sight/signals?handle=monad`. The server answered 200, and the upstream `…/sight` and example
`/signals?handle=monad` were unchanged. The check recorded `json`; the timeout is 120 s; the price was unchanged.

## Suites

The server has 191 tests (47 new). The indexer has 85, the keeper 90, demo-services 7, and the contracts 230
(non-fork). Typecheck passes for shared, server, indexer, keeper, demo-services and web, and the web build passes.

**Not verified:** a deploy to production, and the Privy wallet UI in a browser for the Launch / Creator / token
page changes (typechecked and built only).

## POST-only APIs and the sample request (D-SL10)

The same fork stack and script, with scenario 8: a POST-only JSON API (`/v1/complete`: GET gets 405, a POST without
`message` gets 422) on a second real v2 token (FEED and its router).

```
PASS POST-only link: check passes without a sample (GET → 405, launch allowed)
PASS attached without a sample: token page sample null (Try hidden, agent link kept)
PASS agent POST through the gateway → {"reply":"you said hi agent"}, charged 20000
PASS POST sample added and checked with it: response { "reply": "you said hello" }
PASS paid sample call (web x402 code, POST body): 200 {"reply":"you said hello"}, settle 0x9d43765b…
ALL CHECKS PASSED   (27 checks: the 22 above plus these 5)
```

The paid sample call uses the web's own `prepareCall` / `payAndCall` (`apps/web/src/lib/x402.ts`) with the sample's
method and body, which is exactly what "Try a sample call" runs.

Unit tests (`service-sample.test.ts`, 10 tests) cover:
- the check: a 405, then a 404 followed by a POST `{}` answered 422, are reachable; a 404 on both is refused; a POST
  sample is sent with its JSON body; a failing sample is refused;
- the schema rules: valid JSON, 16 KB counted in UTF-8 bytes, a body only with POST, a sample needs `apiLink`;
- old signed messages unchanged;
- create without a sample, where the detail and manifest return `sample: null`;
- a PATCH that adds and then removes a sample;
- the probe rules without a sample, and a sample refused on a legacy service.

Suites: server 201, indexer 85, keeper 90, demo-services 7. Typecheck passes for every package, and the web build passes.
