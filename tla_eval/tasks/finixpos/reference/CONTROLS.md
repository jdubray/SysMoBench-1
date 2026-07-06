# finixpos replay machinery + controls (study plan §4, validated 2026-07-03)

## Corpus

`data/sys_traces/finixpos/*.ndjson` — 17 scenarios, **75 windows**, event form
`{pre, action, data, post}` over the pinned 7-key observable state. The
language-neutral loader (`tla_eval/evaluation/semantics/trace_loader.py`) now
accepts `pre`/`post` as aliases for `pre_state`/`post_state` (tested in
`tests/test_evaluation/test_trace_loader.py::test_pre_post_alias_event_form`).
Note: `tests/.../test_direct_path_dispatches_to_backend` was already failing on
the clean tree before this change (pre-existing, unrelated).

## Replay commands (what the study driver should invoke)

All three arms go through one driver, `scripts/finixpos_tv.py` (JS helpers run
via local `node` — no Docker; TLC runs via the thinkorswim JRE, override with
`--java`/`FINIXPOS_JAVA`):

```bash
# lean arm — CommonJS { init, next } module (tools/plain-js/tv.mjs underneath)
python scripts/finixpos_tv.py <spec.js> --arm lean [--json out.json]

# SAM arm — full JS-SAM module contract (tools/js-sam/cli.mjs transitions)
python scripts/finixpos_tv.py <spec.js> --arm sam [--json out.json]

# TLA+ arm — constrained module `finixpos`; per-window TV synthesis + TLC
# (TVInit pins pre; one step of the window's action; INVARIANT NoPost;
#  CONSTANTS bound per window to the values observed in that window)
python scripts/finixpos_tv.py <spec.tla> --arm tla [--json out.json]
```

Statuses are `pass | fail | unscoreable`; the summary prints the two
pre-registered numbers (conditional over scoreable, unconditional over total).
A load failure / broken module contract ⇒ all 75 windows unscoreable (verified
for both JS arms with an `{init}`-only module). The SAM helper counts a
model-level rejection (`__error`) as **fail**, so SAM specs must express
no-ops as guarded acceptors, not sam-fsm rejections — the prompt says so.
TLA+ arm wall-clock: ~4 s/window (~5 min per full replay), JS arms <2 s total.

## Positive controls — hand-written references, all 75/75

| arm | spec | pass | unscoreable |
|---|---|---|---|
| lean | `reference_lean.js` | 75/75 | 0 |
| SAM | `reference_sam.js` | 75/75 | 0 |
| TLA+ | `reference_finixpos.tla` | 75/75 | 0 |

## Negative controls — mutations discriminate, symmetrically

`mutations/` holds two semantic mutations of each reference:

| mutation | lean | SAM | TLA+ | failed window (identical in all arms) |
|---|---|---|---|---|
| m1 drop CANCELLING+TAP_DECLINED→CANCELLED rewrite | 74/75 | 74/75 | 74/75 | `s04d_decline_during_cancel[3]` CANCELLING+TAP_DECLINED |
| m2 drop partial-payment guard | 74/75 | 74/75 | 74/75 | `s05b_partial_approval[2]` AWAITING_TAP+TAP_APPROVED |

Each mutation fails exactly the windows that exercise the removed rule and
passes everything else — the replay discriminates and is language-symmetric.
(The corpus carries 1 window per rule; audit combo counts are in
`tla_eval/tasks/finixpos/corpus_coverage.md`.)

## Trace-vs-EXTRACTION discrepancies

None. The 23 observed `(pre.txState, action)` combos all behave exactly as
EXTRACTION.md §2 predicts, including: partial approval leaves
`approvedAmountCents` null while setting `declineCode='PARTIAL_PAYMENT'`;
CANCELLING+TAP_DECLINED lands in CANCELLED **with** the decline code applied;
TAP_APPROVED in CANCELLING/AWAITING_VERIFICATION records without the partial
guard; EXIT_FLOW nulls all six transaction fields; the 8 no-op combos leave
the state bit-identical.

## Semantics encoded by the references (ground truth for grading)

FSM table of EXTRACTION.md §2, total (rejected action ⇒ no-op), plus:
INITIATE_PAYMENT(IDLE) resets all transaction fields; TRANSFER_CREATED
(INITIATING) sets transferId; VERIFICATION_STARTED(INITIATING);
TAP_APPROVED: partial rewrite in AWAITING_TAP (strict `<`), else RECORDING
from {AWAITING_TAP, AWAITING_VERIFICATION, CANCELLING} with
approvedAmountCents set; TAP_DECLINED: CANCELLED from CANCELLING, DECLINED
from {INITIATING, AWAITING_TAP, AWAITING_VERIFICATION}, declineCode applied
in both; PAYMENT_RECORDED(RECORDING) sets paymentId; CANCEL_PAYMENT from
{INITIATING, AWAITING_TAP}; CANCEL_CONFIRMED(CANCELLING); EXIT_FLOW from
{COMPLETED, DECLINED, CANCELLED} → IDLE, all fields nulled.
