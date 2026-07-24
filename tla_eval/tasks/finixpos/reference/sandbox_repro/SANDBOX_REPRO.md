# Gap-2 reproduction against the real Finix sandbox (review ask 2.1(iii))

**Date:** 2026-07-04 · **Host:** `finix.sandbox-payments-api.com` (asserted on every
request) · **Finix-Version:** `2022-02-01` (the version the production adapter pins)
· **Amounts:** ≤ 100¢, the one settled charge was reversed (`cnp-7-reversal`, 201)
· **Evidence:** `step1_evidence.jsonl` (redacted — no Authorization headers; card
details replaced by `(card details redacted)`) · **Probes:** `probe_*.mjs`,
adapter-replay check at
`baanbaan/Merchant/v2/tools/finixpos-trace-harness/sandbox-422-parse-check.ts`.

## What was run

1. **Device path (card-present):** the `.env` device IDs are stale ("Device not
   found"). `GET /merchants/:id/devices` shows 5 real devices; the only enabled
   one is a PAX_D135, which the API refuses for API-initiated transactions
   ("cannot be used to initiate transactions via API" — it is the
   WebSocket-driven counter terminal, matching `counter-ws.ts`). All three
   PAX_A920PRO devices are `enabled: false` ("Please activate the Device
   before…"); activation requires a physical terminal, and even `PUT
   /devices/:id {enabled:true}` times out (Finix evidently contacts the device).
   **The card-present create path cannot be exercised without a physical A920**;
   device states were verified unchanged afterwards.
2. **CNP fallback (validates the `/transfers` idempotency semantics, not the
   device path):** buyer identity → sandbox test-card payment instrument →
   `POST /transfers` with `idempotency_id = K` → **201, state SUCCEEDED**
   (`TRqh8GguJnVXqEkGA7Hrkf3v`) → duplicate `POST` with the same `K` → **422**;
   same-K-different-amount → same 422; charge reversed.

## Finding 1 — duplicate idempotency_id **does** 422 on real rails

> `422 {"_embedded":{"errors":[{"logref":…,"message":"Duplicate transfer
> TRqh8GguJnVXqEkGA7Hrkf3v already exists with idempotency ID 37a69c18-…",
> "code":"UNKNOWN","_links":{"transfer":{"href":"…/transfers/TRqh8GguJnVXqEkGA7Hrkf3v"},…}}]}}`

The existing transfer id is present **only** in `_links.transfer.href` and in the
human-readable `message`. There is **no `transfer` field and no `failure_code`**
on the error object.

## Finding 2 (the headline) — the code's 422 model does not match reality: the
## entire duplicate-key recovery ladder is dead code on real rails

`parseFinixResponse` (finix.ts:209–227) constructs `FinixTransferCancelledError`
only when `errors[0].transfer` exists. Replaying the captured real body through
the **actual production adapter** (`sandbox-422-parse-check.ts`):

| 422 body | error raised by production code |
|---|---|
| real sandbox (2026-07-04, Finix-Version 2022-02-01) | **generic `Error`** |
| repo's A920 emulator (`a920-emulator.ts:176-185`) | `FinixTransferCancelledError` |

Consequences, traced through `runCreateSale` (terminal-payment.ts:442-625):

- On real rails a duplicate-key 422 is an untyped error → **retry with same key
  → 422 again → last-gasp device cancel → verification-pending breadcrumb
  (Case 4)**. `handleDuplicateKey422` — including its SUCCEEDED-fast-record and
  PENDING-resume branches — **never executes**.
- **Gap 2 as originally described (blind decline in the 422 handler's catch,
  no breadcrumb) is unreachable against today's sandbox+version** — it sits
  behind a parse that never matches. The lost-charge risk it described is, on
  real rails, absorbed by Case 4's breadcrumb (safer than the audit assumed).
- New degradations replace it: (a) a tap-succeeded-then-response-lost payment
  that should be recorded instantly (the SUCCEEDED branch) instead parks in
  AWAITING_VERIFICATION until the orphan sweep resolves it — a liveness/UX
  regression; (b) the last-gasp `PUT /devices {action:CANCEL}` fired on this
  path is **device-scoped** and can abort an unrelated in-flight prompt on
  that terminal.

## Scope and caveats (stated precisely)

- The 422 semantics were validated on a **CNP transfer**; the card-present
  device path could not be driven (no activated A920 on this sandbox). The
  `/transfers` resource and `idempotency_id` mechanism are shared, but a
  device-transfer duplicate could in principle return a different shape —
  unverified.
- Sandbox ≠ live; and error shapes can be API-version-dependent. The probe
  pinned the same `Finix-Version: 2022-02-01` the production adapter sends, so
  the divergence holds for the deployment configuration the code actually uses.
- The full client-path repro (workflow → 422 → blocked GET → decline, no
  breadcrumb) was **not** performed on real rails: it requires the device path,
  and — given Finding 2 — the pre-fix code cannot reach that path against the
  real 422 shape anyway. The adapter-replay check stands in as the exact
  evidence at the parse layer.

## Relevance to review point 2.1 (correlated oracle)

This is the reviewer's structural-blindness thesis demonstrated on first
contact with real rails: **the emulator and the code agree on a 422 body shape
(`errors[0].transfer` + `failure_code`) that the real API does not produce.**
Every emulator-reproduced result involving the 422 path (scenarios s06a–c,
their windows in the corpus, and the gap-2 patch hunk) inherits this caveat:
correct against the shared model, aimed at a branch reality never takes. The
paper should (i) rename "live reproduction" → "emulator-reproduced"
throughout, (ii) present this divergence as a first-class finding — it both
*narrows* gap 2 (unreachable today) and *validates* the audit method's
extension to real rails (one probe found a real integration defect the
whole emulator-based study could not see), and (iii) recommend the defensive
fix: parse the existing transfer id from `_links.transfer.href` (or the
message) in addition to `errors[0].transfer`, then the (patched, breadcrumbed)
422 ladder becomes live and correct on real rails.
