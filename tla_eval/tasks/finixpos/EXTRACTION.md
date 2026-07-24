# finixpos — extraction of the POS ↔ PAX A920 ↔ Finix state-alignment protocol

**Provenance.** Copied verbatim from `C:/Users/jjdub/code/baanbaan/Merchant/v2/src`
(not a git repo; file mtimes recorded below). This is production code written by
Claude using SAM-pattern semantics (`@cognitive-fab/sam-pattern` + `@cognitive-fab/sam-fsm`),
running a real POS against a PAX A920 Pro payment terminal (Finix App) and the
Finix backend API.

| file in `source/` | origin | mtime | lines |
|---|---|---|---|
| `terminal-payment.ts` | `src/workflows/terminal-payment.ts` | 2026-06-11 | 2725 |
| `finix.ts` | `src/adapters/finix.ts` | 2026-06-16 | 975 |
| `terminal-outcome.ts` | `src/types/terminal-outcome.ts` | 2026-04-26 | 84 |
| `reconcile.ts` | `src/services/reconcile.ts` | 2026-06-15 | 1779 |
| `a920-emulator.ts` | `src/tools/a920-emulator.ts` | 2026-03-23 | 863 |

**Scope of study.** The single-terminal, single-payment lifecycle and its four
user-facing outcomes: **Succeeded, Declined (no retry), Error (card unreadable /
timeout / infra), Canceled (customer pays cash instead)**. Out of scope: split
payments (`splitMode` machinery), tip-on-terminal amount bookkeeping, the D135
WebSocket terminal, Clover, the dashboard `recordLocally=false` record-via-modal
flow, and the online (card-not-present) checkout. These are carried by the same
model but are orthogonal to the state-alignment question.

---

## 1. The three agents

```
┌─────────────┐   POST /transfers (idempotency_id)      ┌──────────────┐
│  POS (SAM   │ ───────────────────────────────────────▶ │ Finix backend │
│  workflow)  │   GET /transfers/:id   (poll, 2 s)      │  (transfer:   │
│  txState    │ ◀─────────────────────────────────────── │  PENDING →    │
│             │   PUT /devices/:id {action:CANCEL}      │  SUCCEEDED /  │
│             │ ───────────────────────────────────────▶ │  FAILED /     │
└─────────────┘                                          │  CANCELED)    │
       ▲                                                 └──────┬───────┘
       │ staff: initiate / cancel                               │ prompts
       │ (REST + WS entry points)                               ▼
                                                    ┌────────────────────┐
                                                    │ PAX A920 (customer │
                                                    │ taps / declines /  │
                                                    │ presses cancel)    │
                                                    └────────────────────┘
```

The POS never talks to the terminal directly: the terminal's behaviour is
observed **only** through the Finix transfer state. Alignment is by **polling**
(`GET /transfers/:id` every `POLL_INTERVAL_MS = 2000`); there is no webhook.
A server-side timeout `TIMEOUT_MS = 180_000` auto-cancels.

## 2. The POS state machine (verbatim from `terminal-payment.ts:217-246`)

FSM program counter `txState` (field deliberately not named `state` — SAM
reserved word), `deterministic: true`, `enforceAllowedTransitions: true`:

| state | allowed actions → next |
|---|---|
| `IDLE` | `INITIATE_PAYMENT` → INITIATING |
| `INITIATING` | `TRANSFER_CREATED` → AWAITING_TAP · `VERIFICATION_STARTED` → AWAITING_VERIFICATION · `TAP_DECLINED` → DECLINED · `CANCEL_PAYMENT` → CANCELLING |
| `AWAITING_TAP` | `TAP_APPROVED` → RECORDING · `TAP_DECLINED` → DECLINED · `CANCEL_PAYMENT` → CANCELLING |
| `AWAITING_VERIFICATION` | `TAP_APPROVED` → RECORDING · `TAP_DECLINED` → DECLINED |
| `PROCESSING` | (reserved, unreachable in v1) |
| `RECORDING` | `PAYMENT_RECORDED` → COMPLETED |
| `COMPLETED` | `EXIT_FLOW` → IDLE |
| `DECLINED` | `EXIT_FLOW` → IDLE |
| `CANCELLING` | `CANCEL_CONFIRMED` → CANCELLED · `TAP_APPROVED` → RECORDING · `CANCEL_DECLINED` → CANCELLED |
| `CANCELLED` | `EXIT_FLOW` → IDLE |

**SAM wiring** (`createTerminalPaymentWorkflow`, lines 272–1412):

- **Actions** (proposal builders, 736–817): pure; `INITIATE_PAYMENT` mints
  `idempotencyKey` (UUID) and `startedAt`; `EXIT_FLOW` nulls the transaction.
- **Acceptors** (846–954), in order:
  1. *Pre-FSM rewrite* (851–877): `CANCELLING + TAP_DECLINED → CANCEL_DECLINED`
     (one action name, two targets, without breaking determinism); and the
     **partial-payment guard**: `TAP_APPROVED` in `AWAITING_TAP` with
     `approvedAmount < amountCents` (strict) is rewritten to `TAP_DECLINED`
     with `declineCode='PARTIAL_PAYMENT'` (overpayment = tip, accepted).
  2. FSM acceptors (advance `txState`, silently reject disallowed actions).
  3. *Model mutation* (890–954): every branch is guarded by the expected
     **post**-transition `txState`, so FSM-rejected actions cannot corrupt the
     model (the anti-glitch invariant in the header comment: a late
     `TAP_APPROVED`/`TAP_DECLINED` in RECORDING/COMPLETED is a no-op).
- **Reactors** (957–973): FSM state machine + `dehydrateTerminalTx` (persist
  every state change to `terminal_transactions.sam_state`) + logging.
- **NAPs** (975–1100) — where all side effects live, each guarded by
  an in-flight flag so it fires once per state entry:
  - *createSale NAP*: `INITIATING` → `runCreateSale()` (async ladder, §4).
  - *poll NAP*: `AWAITING_TAP` with `transferId` → start 2 s poll interval.
  - *cancel NAP*: `CANCELLING` → `cancelTerminalSale()` + verification ladder (§5).
  - *record NAP*: `RECORDING` → `recordTerminalPayment()` (idempotent DB write)
    → `PAYMENT_RECORDED`.
- **render** (1108–1292): snapshots `_lastModel`, logs `payment_events` /
  `payment_errors`, maps `txState` → client status
  (`COMPLETED→approved, DECLINED→declined, CANCELLED→cancelled, else waiting`),
  releases the order-edit lock on DECLINED/CANCELLED, prunes the registry on
  terminal states.

## 3. The environment: Finix transfer lifecycle

`finix.ts` observable contract (all the POS can see):

- `createTerminalSale` → `POST /transfers` with `idempotency_id`; returns
  `{transferId, state}` — normally `PENDING`; documented edge cases
  immediate `SUCCEEDED` / `FAILED` / `CANCELED`; throws
  `FinixTransferCancelledError` on **422 duplicate idempotency key** (carries
  `existingTransferId`), throws generic errors on network/5xx.
- `getTerminalTransferStatus` → `{state ∈ PENDING|SUCCEEDED|FAILED|CANCELED|UNKNOWN,
  amount, tipAmountCents, card fields, failureCode, failureMessage}`.
- `cancelTerminalSale` → `PUT /devices/:id {action: CANCEL}` — device-scoped,
  not transfer-scoped. Normal: `state=FAILED, failure_code=CANCELLATION_VIA_API`.
  **Race**: customer tapped first → `state=SUCCEEDED` (caller must honour the
  charge). May also throw, or return FAILED while the transfer is actually
  SUCCEEDED (Bug #2 note at line 1005–1010).

Customer actions (tap, decline, cancel-on-device) are visible only as poll
results: `SUCCEEDED`, `FAILED` with an issuer decline code, `FAILED` with
`CANCELLATION_VIA_DEVICE`, or `CANCELED`.

## 4. `runCreateSale` recovery ladder (442–625) — the hard part #1

Attempted with a fixed idempotency key, `MAX_CREATE_ATTEMPTS = 2`:

1. Response `SUCCEEDED` immediately → fetch details →
   `recordSucceededTransferAndAdvance` (direct DB write, then
   `TRANSFER_CREATED`+`TAP_APPROVED` fast-forward).
2. Response `FAILED`/`CANCELED` immediately → `TAP_DECLINED(IMMEDIATE_FAILURE)`.
3. Response `PENDING` → `TRANSFER_CREATED` (normal path).
4. **422 duplicate key** → `handleDuplicateKey422`: fetch existing transfer;
   `SUCCEEDED` → record; `PENDING` → resume awaiting-tap on the existing
   transfer; `FAILED/CANCELED` → decline with the real code; **fetch failed →
   decline conservatively** (comment admits the transfer may be SUCCEEDED and
   unknown — no `pending_terminal_sales` row is written on this path).
5. Non-422 error → retry once with the SAME key (Finix idempotency closes the
   ambiguity window: either we create it now or we get the 422 path).
6. Both attempts failed → **last-gasp device cancel probe**: if the cancel
   returns SUCCEEDED (customer tapped during the network window) → record;
   if cancel returns an ID whose re-fetch is SUCCEEDED → record.
7. Nothing recovered → INSERT `pending_terminal_sales(idempotency_key)`,
   dispatch `VERIFICATION_STARTED` → `AWAITING_VERIFICATION`. The reconcile
   orphan sweep (`reconcile.ts:sweepOrphanedTerminalSales`) later resolves via
   `GET /transfers?idempotency_id=…` and calls
   `resolveTerminalVerificationForOrder` → `TAP_APPROVED` / `TAP_DECLINED`.
   Fresh attempts on the order are rejected with 409 until resolved.

## 5. Cancel ladder (cancel NAP, 1011–1070) — the hard part #2

On `CANCELLING`: call `cancelTerminalSale` once.
- Returns `SUCCEEDED` → tap beat cancel → `TAP_APPROVED` (record the charge).
- Returns non-SUCCEEDED or **throws** → probe `getTerminalTransferStatus`
  (prefer the ID from the cancel response, else the model's `transferId`):
  probe says SUCCEEDED → `TAP_APPROVED`; otherwise (or probe fails / no ID) →
  `CANCEL_CONFIRMED` → CANCELLED.

Meanwhile the poll interval **keeps running in CANCELLING** (pollTick guard,
347): a poll result can also resolve the race — `SUCCEEDED → TAP_APPROVED`,
`FAILED/CANCELED → TAP_DECLINED` (rewritten to `CANCEL_DECLINED` → CANCELLED).

Timeout: every poll tick checks `now − startedAt > 180 s` → log
`terminal_timeout`, set `_timedOut`, dispatch `CANCEL_PAYMENT` (same cancel
ladder; `_timedOut` only suppresses double error-logging).

## 6. The four outcomes — where each is decided

| user outcome | txState path | decided at |
|---|---|---|
| **Succeeded** | …→ RECORDING → COMPLETED | poll sees `SUCCEEDED` (382–399); or immediate-SUCCEEDED / 422-SUCCEEDED / cancel-race-SUCCEEDED recovery paths; `recordTerminalPayment` is idempotent via `ON CONFLICT (order_id, finix_transfer_id) DO NOTHING` + already-paid check |
| **Declined** | AWAITING_TAP → DECLINED | poll sees `FAILED` with an issuer code; `finixDeclineCodeToOutcome` (2572–2614) maps card codes → `status:'declined', retryable:false` (INSUFFICIENT_FUNDS, DO_NOT_HONOR, LOST/STOLEN/EXPIRED/INVALID_CARD, INVALID_PIN, …) |
| **Error** | INITIATING → DECLINED, or unknown code | `IMMEDIATE_FAILURE` / `INITIATION_FAILED` → `status:'error', retryable:true`; null/unknown code → `status:'declined', reason:'unknown', retryable:true` (generic bad read). *A decline that succeeds on retry — as observed in production — is this class: retry is a NEW payment initiated by staff, never automatic.* |
| **Canceled** | → CANCELLING → CANCELLED (staff/timeout) or AWAITING_TAP → DECLINED with `CANCELLATION_VIA_DEVICE` (customer pressed cancel on device, surfaces as poll FAILED) | `CANCELLATION_VIA_API` → `cancelled/cancelled_by_staff, retryable:true`; `CANCELLATION_VIA_DEVICE` → `cancelled/cancelled_by_customer, retryable:false`; workflow CANCELLED rows → `cancelled, retryable:true, retryDelayMs:3000` |

Note the deliberate asymmetry: **the same FSM state `DECLINED` fans out to
three user outcomes** (declined / cancelled / error) via `declineCode`, and the
user outcome `Canceled` is reachable through **two different FSM states**
(`CANCELLED` and `DECLINED+CANCELLATION_VIA_*`). Retry is always a fresh
`INITIATE_PAYMENT` with a fresh idempotency key, gated by the client-facing
`retryable` flag.

## 7. Cross-system alignment invariants (implicit in the code)

The code's own comments and mechanisms imply these correctness properties —
these become the Phase-4 invariant set:

- **I1 No lost charge**: if Finix reaches `SUCCEEDED` for the payment's
  idempotency key, the POS must eventually reach COMPLETED with a `payments`
  row for that transfer (never terminal DECLINED/CANCELLED with a SUCCEEDED
  transfer and no record).
- **I2 No double charge**: at most one Finix transfer per (order, attempt)
  idempotency key; at most one `payments` row per (order, transfer).
- **I3 Cancel honoured**: CANCELLED implies the transfer did not succeed
  (or was recorded instead — CANCELLING must exit via RECORDING when the tap won).
- **I4 Decline is terminal**: DECLINED never auto-retries; a new attempt
  requires a fresh INITIATE_PAYMENT (fresh key).
- **I5 No glitch writes**: late TAP_* arriving in RECORDING/COMPLETED/terminal
  states never mutate the model or the DB (acceptor post-state guards).
- **I6 Timeout liveness**: from AWAITING_TAP the workflow leaves the waiting
  states within TIMEOUT_MS + cancel-ladder latency.

## 8. Candidate weaknesses spotted during extraction (to be tested, not yet verdicts)

1. **Cancel during INITIATING can strand a live transfer** — `CANCEL_PAYMENT`
   is allowed from INITIATING; the FSM then sits in CANCELLING where
   `TRANSFER_CREATED` is *not* an allowed transition, so when the in-flight
   `runCreateSale` completes with PENDING, its `TRANSFER_CREATED` dispatch is
   silently rejected and `model.transferId` stays null; the cancel NAP probed
   with `transferId=null` and confirmed the cancel. If the device-level cancel
   raced ahead of the transfer creation, a live PENDING transfer remains that
   the customer can still tap — SUCCEEDED at Finix, CANCELLED at POS, no
   `pending_terminal_sales` row (I1/I3 violation window).
2. **422-path fetch failure declines without a breadcrumb** — in
   `handleDuplicateKey422`'s catch (660–673) the POS declines but writes no
   `pending_terminal_sales` row, so if the existing transfer was SUCCEEDED the
   orphan sweep will never look for it (I1 violation window; the code comment
   acknowledges the ambiguity).
3. **Partial-approval rejection does not void** — `PARTIAL_PAYMENT` rewrite
   declines the POS side but the (partial) charge, if Finix settled one,
   is not reversed/refunded anywhere in this flow (I1 mirror-image: charge
   exists, POS says declined).
4. **AWAITING_VERIFICATION has no timeout or cancel** — only TAP_APPROVED /
   TAP_DECLINED exit it; if the sweep can't resolve (Finix down), the order
   stays locked indefinitely (liveness, I6 analogue).

These are exactly the scenarios the trace corpus and the model-checking arms
of the study are designed to probe.
