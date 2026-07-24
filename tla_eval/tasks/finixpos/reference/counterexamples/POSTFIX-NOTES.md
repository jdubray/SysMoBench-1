# Post-fix model-checking notes (review-response validation)

Models: `FinixPOSFixed.tla` (patched dispatch relation) + `FinixPOSFixedEnv.tla`
(patched environment). Configs `fixed_*.cfg`. TLC run with `-deadlock`,
tla2tools from `lib/`, thinkorswim JRE.

## Headline

Every original per-gap counterexample vanishes, and the four core invariants
(`Inv_I1_NoLostCharge`, `Inv_I3_CancelHonoured`, `Inv_VerificationHasBreadcrumb`,
`Inv_RecordingHasTransferId`) hold with **all five failure gates enabled
simultaneously** — 411 distinct states, full graph (`fixed_allfail.cfg`).
Per-gate runs: clean 131, bug1 239, bug2 136, bug3 181, bug4 143, bug5 135
distinct states, all "No error".

`Inv_RecordingHasTransferId` is the gap-7 invariant; it fails on the pre-fix
system (demonstrated live in the study as s03b's NULL `finix_transfer_id`).

## Two residuals found and characterized (not hidden)

### 1. NEW patch defect — recovery-path partial writes the row before the guard
`fixed_allfail_partialbook.cfg` → `Inv_NoPartialRecorded` VIOLATED
(`fixed_partialbook.raw.txt`, 6 states): customer partially approves ($5 of
$10) before the create response is delivered; `recordSucceededTransferAndAdvance`
(preview 1139+) writes the payments row FIRST, then dispatches
`TAP_APPROVED(5, tid)` which the (fixed) partial guard rewrites to
DECLINED/PARTIAL_PAYMENT and the render refunds. Net: **order marked paid at
the partial amount while the partial charge was refunded** — books wrong,
customer whole. Same shape reaches it via 422-SUCCEEDED, last-gasp-SUCCEEDED
and cancel-response-SUCCEEDED (all call `recordSucceededTransferAndAdvance`).
Pre-fix behaviour on this path was bug 3 itself (row kept, no refund), so the
patch is an improvement here, but incomplete.
**Patch-v2 recommendation:** apply the partial check inside
`recordSucceededTransferAndAdvance` BEFORE `recordTerminalPayment` — on
`details.amount < model.amountCents`, skip the DB write and dispatch the
approval (the guard will decline and refund), or decline directly with the
stash.

### 2. Documented residual — gap-4 fail-closed under a dead local DB
`fixed_bug4_strict.cfg` (I1 without the `dbFailed` exemption) → violated
(`fixed_bug4_strict_residual.raw.txt`, 8 states): both create responses lost →
Case-4 breadcrumb INSERT fails twice (DB down) → fail-closed decline
(VERIFICATION_UNAVAILABLE) → the network-lost create is *later* delivered by
Finix and the customer taps it → SUCCEEDED at Finix, DECLINED at POS, and no
DB-based recovery can exist because the DB that would hold the breadcrumb is
the thing that failed. This is inherent to a dead local DB, strictly better
than the pre-fix wedge (which additionally locked the order forever), and is
why `Recoverable` carries the explicit `dbFailed` disjunct. Mitigation beyond
the patch would need a non-DB breadcrumb (e.g. append-only file or the
payment_events log already written with the idempotency key at WARN level —
which the patch keeps; manual recovery remains possible from logs).

## Modeling deltas vs the pre-fix env (for auditability)

- `DeliverCreateResp` split: normal resume only from INITIATING; the
  PENDING-while-cancelled delivery is owned by `MidCreateCancelKills` /
  `MidCreateCancelMisses` (the two outcomes of `handleCancelledMidCreate`).
- The 422-PENDING resume is still an unguarded `_transferCreated` in the
  patched code; the model keeps it — the cancel NAP's breadcrumb-by-key is
  what protects that window, and TLC confirms I1 holds.
- `CancelNap`/`CancelNapBlind` write the breadcrumb-by-key when entering
  CANCELLING with no transferId (preview 1225-1237).
- New sweeps: `SweepCancelledRecover` (gap 5) and `SweepBreadcrumbRecover`
  (breadcrumb rows recovered after the workflow is terminal/pruned, per
  GAP-FIXES gap-2 note); `RefundNap` (gap 3).
- `Recoverable` defines "not lost" as visible-to-some-recovery-mechanism;
  the CANCELLED-row-with-id and PARTIAL-with-id disjuncts exist because the
  patch added exactly those two recovery mechanisms.
