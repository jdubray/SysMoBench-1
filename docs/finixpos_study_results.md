# finixpos study results — payment state alignment: correctness + JS-SAM vs TLA+

**Published as:** Jean-Jacques Dubray, "Can Code Specify a System Precisely
Enough to Formally Verify It?", arXiv:2607.05076, July 2026
(<https://arxiv.org/abs/2607.05076>). This document is the study of record
behind that paper.

**Status:** COMPLETE (2026-07-04), including the external-review response.
Both deliverables final: (a) correctness verdict — originally 7 confirmed
gaps + validated fix patch
(`baanbaan/Merchant/v2/patches/terminal-payment-gap-fixes.patch`); the review
response reclassified gap 2 (dead code on real rails — see the sandbox
finding), added gap 10 and one patch defect via failure-model extensions,
and documented the crash-restart windows (8/9/9b) as accepted operational
risk in the deployment context (see "Revisions after external review");
(b) full 3-arm × 4-model × N=5 grid, scored on both corpora, with exact
permutation tests.
*(History: the run stalled mid-grid on a $15 workspace API cap on
2026-07-03; the user raised it and the resumable driver completed the grid.)*

**Design:** `docs/finixpos_study_plan.md` · **Extraction:** `tla_eval/tasks/finixpos/EXTRACTION.md`
**System:** baanbaan Merchant/v2 POS ↔ PAX A920 Pro (Finix App) ↔ Finix backend —
production code written by Claude in SAM semantics. Four user outcomes:
Succeeded / Declined (no auto-retry) / Error / Canceled.
**Corpus:** 75 windows, 17 real-execution scenarios (instrumented workflow +
the repo's own A920 emulator + a failure-injection proxy), all chained and
validated; coverage in `tla_eval/tasks/finixpos/corpus_coverage.md`.
**Controls:** hand-written reference specs 75/75 in all three languages;
rule-drop mutations fail the identical windows in every language
(`tla_eval/tasks/finixpos/reference/CONTROLS.md`).

---

## Deliverable (a): is the implementation correct?

**The core protocol is correct. Seven failure-handling gaps are not — all
sharing one root cause: paths that abandon a possibly-live Finix transfer
without leaving the idempotency-key breadcrumb the recovery machinery
depends on.**

With all optional failure modes off, TLC exhaustively verifies no-lost-charge,
no-double-charge, cancel-honoured, and glitch-tolerance over the full state
graph — including tap-beats-cancel, the 422 recovery ladder, sweep resolution,
and late/duplicate-action no-ops. The four outcomes are sound on their main
paths; the observed decline-then-retry-succeeds pattern is by-design safe
(fresh idempotency key per attempt, `retryable` gating per decline code).

The gaps (full narratives in `tla_eval/tasks/finixpos/reference/FINDINGS.md`
and `counterexamples/`):

| # | gap | how found | severity |
|---|---|---|---|
| 1 | **Cancel during INITIATING strands a live transfer** — CANCELLING rejects `TRANSFER_CREATED`; customer taps the stranded PENDING transfer → Finix SUCCEEDED, POS CANCELLED, no breadcrumb | TLC counterexample **+ reproduced as a real execution** (scenario s04e) | highest |
| 2 | 422 duplicate-key + failed status fetch declines with **no `pending_terminal_sales` row** (unlike the sibling Case-4 path) — a SUCCEEDED transfer becomes invisible. **RECLASSIFIED after the sandbox experiment** — see "Revisions after external review": the 422 handler is dead code on real rails (the parser expects `errors[0].transfer`, which the real API does not send), so the blind-decline is unreachable and the lost-charge risk is absorbed by the Case-4 breadcrumb; the residual is a liveness/UX regression + a device-scoped last-gasp cancel | TLC (pre-fix model); reclassified by real-sandbox probe | reclassified: medium (liveness/UX), plus an oracle-divergence finding |
| 3 | Partial approval declined but the settled partial charge is **never voided** | TLC; Finix documents partial auth (`default_partial_authorization_enabled`) — production-plausible | high if partial auth enabled |
| 3b | The partial guard covers only AWAITING_TAP — a partial approval via CANCELLING or sweep resolution is **recorded and marks the order paid below total** | TLC | high if partial auth enabled |
| 4 | Breadcrumb INSERT failure still dispatches VERIFICATION_STARTED → AWAITING_VERIFICATION **has no other exit**: wedged, order locked | TLC | medium |
| 5 | "Conservative" cancel (cancel throws AND probe fails while transfer SUCCEEDED) confirms cancellation over a real charge; ttx row has the transferId but **no sweep over CANCELLED rows exists** | found during modeling | medium |
| 6 | Cancel NAP prefers the cancel response's transfer id over the one being polled (`result.transferId ?? knownTransferId`); a bogus id + blind poll → CANCEL_CONFIRMED over a real charge | trace harness (s04f) | medium |
| 7 | `resolveVerification({outcome:'approved', transferId})` **ignores the passed transferId** — recovered payment row written with `finix_transfer_id = NULL`, disabling the `ON CONFLICT` double-record guard for that row | trace harness (s03b) | medium |

Recommended fix shape (one pattern closes 1, 2, 4, 5): write the
`pending_terminal_sales` breadcrumb *before* entering any state that can
abandon a transfer (CANCELLING from INITIATING, the 422 catch, the
verification dispatch), and add a small sweep over recent CANCELLED ttx rows
with a transferId. For 3/3b: check `approvedAmount < amountCents` at *every*
TAP_APPROVED entry point and issue a void/refund on partial rejection. For 7:
thread `o.transferId` into the `_tapApproved` dispatch.

Environment assumptions flagged and doc-checked: partial authorization is a
real, configurable Finix feature (supports 3/3b); the device-cancel vs
in-flight-create race is undocumented (gap 1's enabling assumption — confirm
with Finix support; the defensive fix is cheap regardless).

### Revisions after external review (2026-07-04)

The review asked for a real-rails reproduction, a systematically derived
failure model, and a cross-attempt double-charge check. Each extension
changed the picture; all changes are recorded here.

**Gap 2 reclassified — and an oracle divergence demonstrated.** The Finix
*sandbox* experiment (`reference/sandbox_repro/SANDBOX_REPRO.md`) validated
that duplicate `idempotency_id` does 422 on real rails, but the real 422
body carries the existing transfer id only in `_links.transfer.href` — there
is no `errors[0].transfer` field, which is the only shape the production
parser (and the emulator) recognize. Replaying the captured real body
through the actual adapter raises a generic `Error`, so
`handleDuplicateKey422` — including gap 2's blind-decline catch and the
SUCCEEDED-fast-record branch — **never executes against the real API** (for
the pinned `Finix-Version: 2022-02-01`). Gap 2 as described is unreachable;
its lost-charge risk is absorbed by the Case-4 breadcrumb path. Residuals:
a tap-succeeded duplicate parks in AWAITING_VERIFICATION instead of
recording immediately (liveness/UX), and the last-gasp device-scoped CANCEL
can abort an unrelated prompt. The methodological finding outranks the gap:
**code and emulator agreed on a response shape reality does not produce** —
the correlated-oracle threat, demonstrated on first contact with real rails.
(Caveats: validated via a CNP transfer — no activated A920 exists on this
sandbox — and sandbox ≠ live.)

**New in-scope findings from the extended failure model**
(`reference/EXTENDED_FAILURE_MODEL.md`; systematic per-channel enumeration
table there). These occur with all equipment operating normally:

| # | finding | found by | pre-fix | post-fix |
|---|---|---|---|---|
| 10 | **Counter path lacks the 409 pending-row guard** (`startTerminalPayment`) — a counter retry can race the sweep into a second real charge; detected (loud log) but never refunded | two-attempt model | subsumed by 2 | **violated** (money), detected |
| — | **Recovery-path partial recorded before the guard** — `recordSucceededTransferAndAdvance` writes the payments row before dispatching, so a recovery-discovered partial is recorded, then declined *and refunded*: order marked paid at the partial amount with the money returned (customer whole, books wrong) | post-fix re-model-check | (was bug 3) | **patch defect** |

Also in scope: the **reviewer's double-charge composition is mechanically
confirmed pre-fix** (blind decline → tap → unblocked retry → two SUCCEEDED
transfers, first invisible; the books never double, which is why it's
silent). Post-fix, I2 holds exhaustively on the dashboard path. A
stale-probe variant of gap 5 (no error assumption needed) is violated
pre-fix and **closed post-fix** by the CANCELLED-rows sweep.

**Crash–restart windows: documented accepted operational risk (not
defects).** The crash-restart extension was built as the review asked, and
it found three real windows (traces saved in `counterexamples/ext_*`):
crash during INITIATING (row has no transfer id; the stale-row cleanup
additionally marks it CANCELLED without a probe — window 8), crash in
RECORDING between Finix success and the local record (window 9), and crash
in CANCELLING (window 9b); crash in AWAITING_TAP — the designed rehydration
case — recovers correctly pre- and post-fix. **The system owner classifies
process-crash / terminal-power-loss scenarios as accepted operational risk
in this deployment**, and the correctness bar as: the state machine must be
correct while all equipment is operating. Rationale: a staff-present
restaurant POS with small ticket sizes, cash remediation always available,
and the `payment_events` log preserving the idempotency key of every attempt
for manual reconciliation. The same classification covers the gap-4
residual under a dead local DB (local DB failure is equipment failure; the
fail-closed decline is strictly better than the pre-fix wedge, and manual
recovery from the warn-level log entry remains possible). An **optional
hardening** exists if the risk posture ever changes: one sweep over crashed
non-terminal rows keyed by the always-persisted `idempotency_key` closes
windows 8/9/9b.

**Failure-model scope (per review 2.2).** The verdict "core protocol
correct" is now explicitly scoped: **verified correct under a failure model
comprising** message loss/duplication and error responses on every Finix RPC
(create / status poll / device cancel), the five interleaving/error gates
(early cancel, fetch failure, partial approval, DB write failure, blind
cancel), one-step-stale reads, cross-attempt retry composition, and
customer/staff races — **with process crash–restart and terminal power loss
treated as accepted operational risk** (rationale above; boundary examined,
not blind: the crash model and its counterexamples are retained). Still
unmodeled: multi-terminal/multi-order interleavings, clock skew beyond the
timeout abstraction, deeper-than-one-step read reordering, and Finix-side
internal transitions not observable via the pinned API version. The
per-channel enumeration table in `EXTENDED_FAILURE_MODEL.md` §1 records
which cells each gate covers.

**Patch v2 — authored + validated** (cumulative, supersedes v1;
`baanbaan/Merchant/v2/patches/terminal-payment-gap-fixes-v2.patch`, per-hunk
notes in `patches/GAP-FIXES.md`). Items:

1. **Gap 10 — hoist the 409 pending-row guard into `startTerminalPayment`**
   (counter path), checked before creds. *Validated:* `gap10-counter-guard-check.ts`.
2. **Real-rails 422 parsing** — `parseFinixResponse` also reads
   `_links.transfer.href` / the message. *Validated:* `sandbox-422-parse-check.ts`
   (baseline → generic Error on the real body; v2 → typed error with the id).
3. **Partial check before the DB write** in `recordSucceededTransferAndAdvance`
   — closes the recovery-partial bookkeeping defect. *Validated:* scenario
   `s09_recovery_partial` + TLC (item 6).
4. **Emulator 422 body corrected** to the real shape. *Validated:* fixed corpus
   v2 drives s06a–c through the real body + v2 parser to the same terminal states.
5. **Refunds are operationally manual (owner amendment)** — the POS never
   calls the refund API; partial charges are surfaced via `payment_errors`
   (+ audit event) with the transfer id, amount, and a
   refund-via-Finix-dashboard instruction. Deliberate access-control decision:
   the POS has no per-employee refund authorization, so a POS-triggered refund
   would execute with the system's authority — every employee would
   effectively hold refund power; the Finix dashboard's login/role
   restrictions keep that authority scoped. (Supersedes the earlier
   refund-idempotency caveat, now moot.)
6. **Recovery sweeps skip/reject partials** — the patched-model re-check
   found the CANCELLED-rows sweep (a v1 fix) would *re-record* a partial the
   guard had rejected+refunded. v2 adds `decline_code != 'PARTIAL_PAYMENT'` to
   the CANCELLED sweep AND a full partial guard to reconcile.ts's
   `sweepOrphanedTerminalSales` direct-DB path (partial → declined
   PARTIAL_PAYMENT + surfaced for manual refund + pending row dropped; never
   recorded). *Validated:* TLC
   `Inv_NoPartialRecorded` + all-gates battery hold over the full
   failure-enabled graph, 376 distinct states, no error
   (`FinixPOSFixedV2Env.tla`, `fixedv2_allfail*.cfg` — breadcrumb-sweep guard
   faithful to shipped code; refund action re-modeled as `SurfacePartialNap`;
   `FinixPOSRefund.tla` retired, its property no longer exists); reach-test
   `reconcile-partial-guard-check.ts` 10/10 (partial rejected + surfaced with
   tid/amount, and a recording proxy confirms NO refund/reversal request;
   full-amount recovery recorded normally — no over-block).

*(Optional hardening, accepted-risk tier):*
`terminal-payment-crash-sweep.patch` — an idempotency-key sweep over crashed
non-terminal rows closing windows 8/9/9b, shipped separately for deployments
that change context (unattended kiosks, larger tickets).

**v2 validation:** typecheck 428/428 with zero NEW errors (the two
reconcile.ts hits are pre-existing baseline errors, line-shifted); both patches
apply clean (v2 covers 4 files incl. reconcile.ts); fixed corpus v2 all 24
scenarios green (partial scenarios also assert the manual-refund surfacing
record); gap-10 guard check passes; reconcile partial-guard reach-test 10/10
incl. the no-refund-API-call recorder assertion; TLC no error over 376
distinct states. The re-model-check itself found a
new gap (item 6) — the same "extensions find new gaps" pattern as the rest of
the review response.

## Deliverable (b): JS-SAM vs TLA+ — final results (full 60-cell grid)

All arms derivation mode (no semantics block). Analysis of record: the
101-window corpus v2 (`output/finixpos_v2_rescore.json`); v1 (75 windows,
`output/finixpos_phase3_study.json`) shown for continuity.

**Mean pass rate, unconditional (conditional), N=5, corpus v2:**

| model | SAM contract | lean `next()` | TLA+ (constrained) |
|---|---|---|---|
| Opus 4.8   | 98.8% (98.8%) | **100%** (100%) | 98.8% (99.6%) |
| Fable 5    | **100%** (100%) | **100%** (100%) | **100%** (100%) |
| Sonnet 4.6 | 98.8% (98.8%) | 99.4% (99.4%) | 88.3% (98.3%) |
| Haiku 4.5  | **0.0%** (0.0%) | 95.8% (95.8%) | 79.6% (97.1%) |

**Fable 5 is the only model perfect on all three arms** (15/15 cells at
101/101; its two v1 TLA+ cells showed one unscoreable window each, but both
windows pass in 2.4 s on re-run and on the v2 rescore — transient TLC/JVM
flakes under machine load, footnoted as tooling, not spec defects).

**Generation-level exact permutation tests** (unit = generation, statistic =
difference in mean unconditional v2 pass rate, all C(10,5)=252 relabelings,
two-sided; floor p = 0.0079):

| model | lean vs TLA+ | SAM vs TLA+ | lean vs SAM |
|---|---|---|---|
| Opus   | Δ=+.012, p=.44 | Δ=0, p=1 | Δ=+.012, p=1 |
| Fable  | Δ=0, p=1 | Δ=0, p=1 | Δ=0, p=1 |
| Sonnet | Δ=+.111, **p=.0079** | Δ=+.105, **p=.0079** | Δ=+.006, p=1 |
| Haiku  | Δ=+.162, **p=.0079** | Δ=−.796, **p=.0079** | Δ=+.958, **p=.0079** |

**Behavioral uniqueness** (distinct v2 status vectors of 5): Opus 2/1/3,
Fable 1/1/1, Sonnet 2/2/5, Haiku 1/5/2 (SAM/lean/TLA+). Fable converged on a
single behavior per arm; Haiku's five SAM specs are five texts with one
(broken) fingerprint, while its five lean specs are five genuinely different
behaviors.

### Autopsy taxonomy — every imperfect cell classified

Four error components; every lost window in the grid falls into exactly one:

| component | meaning | cells affected (v2) |
|---|---|---|
| **semantic** — a real transition rule is wrong/missing | cancel rewrite (CANCELLING+TAP_DECLINED→CANCELLED, implemented as an acceptor *outside* the FSM table), partial guard, INITIATING-decline | claude_sam_2 (both rewrites, −6); claude_tla_4 (init-decline, −2); sonnet_sam_0/1 + sonnet_lean_0 (cancel rewrite, −3 each); sonnet_tla_1/3 (partial ± init-decline fails); haiku_lean_1/2/3 (−6/−9/−3); haiku_tla fails (partial ×3 in 4 of 5 gens) |
| **replay-contract** — guard-idiom disabled actions: no-op windows deadlock TLC (unscoreable, not wrong) | all remaining TLA+ losses | claude_tla_2 (4 no-op windows); every sonnet_tla gen (9 uniform no-op windows); every haiku_tla gen (11+ windows incl. rewrites expressed as deadlocks) |
| **ceremony** — spec violates the executable contract; logic may be right but never runs | Haiku SAM: all five generations use the production source's `['NAME', fn]` tuple wiring for `component.actions`; intents never fire → 0/101 despite mostly-correct acceptor logic | haiku_sam_0..4 (uniform — one fingerprint) |
| **tooling** — transient TLC/JVM flake; passes on re-run | fable_tla_2/tla_4, one window each on v1 only | none on v2 |

The single most-missed *semantic* rule across models and languages is the
**cancel rewrite** — precisely because the production code implements it as a
pre-FSM acceptor that overrides the (faithfully transcribed) FSM transition
table. sonnet_lean_0 is the cleanest exhibit: it copied the FSM table
verbatim — where TAP_DECLINED is legitimately absent from CANCELLING — and
missed that the acceptor layer rewrites it. Models that transcribe structure
faithfully but skim cross-cutting override logic fail exactly here. The
second is the **partial guard**; notably Haiku misses it *identically in
lean and TLA+* (same 3 windows) — a model-level miss, not a language effect.

### Final reading against the pre-committed interpretations (plan §6)

1. **The lean-contract ceiling replicates, with a gradient.** Lean is the
   best or tied-best arm for every model (the only arm never significantly
   worse than any other). But unlike spin — where lean rescued even Haiku to
   100% — the hard protocol re-opens a capability gap *within* the lean arm
   (Haiku 95.8%): contract minimality removes ceremony and replay-contract
   error, and what remains is genuine modeling ability.
2. **TLA+'s deficit stays a replay-contract artifact, now with statistics.**
   Sonnet's and Haiku's lean-vs-TLA+ gaps are significant (p=.0079) but
   their *conditional* TLA+ scores are 98.3%/97.1% — the unconditional gap
   is dominated by guard-idiom unscoreables (the attempt-as-non-step idiom),
   exactly as in spin. Opus and Fable write no-op-tolerant TLA+ unprompted
   and show no gap.
3. **The SAM ceremony penalty is source-shape-aggravated — the new result.**
   The going-in hypothesis allowed that a SAM-shaped source might *help* the
   SAM arm. The opposite: Haiku imitated the source's library wiring over the
   prompt's contract in 5/5 generations (0%, p=.0079 against both other
   arms), and the SAM arm's other imperfections (claude_sam_2, sonnet_sam_0/1)
   are the same semantic misses as elsewhere plus nothing — for capable
   models SAM ≈ lean; for weak models the contract surface is fatal.
4. **Model capability ordering on a hard real-world protocol:** Fable 5
   (perfect grid) > Opus 4.8 ≳ Sonnet 4.6 > Haiku 4.5, visible in every
   arm and sharpest under TLA+ (uniqueness 1/3/5/2 tracks convergence).

Analysis artifacts: `scripts/finixpos_final_analysis.py`,
`output/finixpos_final_analysis.json`, per-window detail in
`output/finixpos_v2_rescore.json`.

## Cross-vendor replication (Mistral panel, added 2026-07-04)

To break the model-lineage fold of the circularity limitation (code written
by Claude models, evaluated by Claude models), the identical 3-arm × N=5
protocol was run on three Mistral models: **mistral-large-2512** (flagship),
**devstral-2512** (code specialist), and **labs-leanstral-1-5-1** (Lean 4
theorem-proving specialist, 119B/6B-active — no relation to our "lean"
contract arm, which is a bare JavaScript transition function). Same prompts,
same source packet, same mechanical replay.

### Results — corpus v1 (75 windows) and v2 (101 windows)

| model | SAM v1 | lean v1 | TLA+ v1 | SAM v2 | lean v2 | TLA+ v2 |
|---|---|---|---|---|---|---|
| mistral-large | 79.5% (99.3%) | 98.7% | 35.5% (99.3%) | 79.6% | 97.0% | 34.5% (59.1%) |
| devstral | 58.1% (96.9%) | 94.1% | 68.5% (98.5%) | 58.2% | 92.7% | 65.7% (96.6%) |
| leanstral | 64.8% | 88.8% | 49.9% (98.4%) | 64.6% | 87.7% | 47.5% (57.8%) |

(unconditional, conditional in parentheses where materially different)

Permutation tests (v2, generation-level): mistral-large lean>TLA+ Δ=+.626
p=.0079*; devstral lean>TLA+ Δ=+.269 p=.0079*; leanstral's contrasts are
directionally identical but non-significant at N=5 (its within-arm variance
is the highest in the study — uniqueness 4/4/3 of 5).

### What replicates vendor-independently (7/7 models)

- **Lean is best-or-tied everywhere, and is the only arm with zero
  unscoreable generations across the entire study.** Every lean loss, for
  every model of either vendor, is an honest semantic miss.
- **Contract ordering (lean ≥ SAM, lean > TLA+ unconditional)** holds for
  all seven models.
- **Semantic misses are language-independent per model.** mistral-large
  misses exactly the partial-payment guard — the same single window in all
  5 lean generations (window 64), and the same rule as *fails* in its TLA+
  arm on v2's added partial windows. devstral's consistent lean misses
  (partial guard, TAP_DECLINED-from-INITIATING, tap-beats-cancel) recur as
  disabled-action unscoreables in its TLA+ arm. Same model, same
  misreadings, any syntax — the spin study's core claim, now cross-vendor.

### What the Mistral panel adds (and one claim it forces us to sharpen)

- **The SAM checkability hazard reaches frontier scale cross-vendor, with a
  new fingerprint.** mistral-large lost 1/5 and devstral 2/5 SAM generations
  to structurally dead modules (0 unscoreable ×75) — but *not* Haiku's tuple
  wiring. Autopsy: hallucinated/misused **reactor** semantics —
  mistral-large_sam_3 invented a `getProposal()/clearProposal()` API whose
  re-entrant `instance({})` calls livelock the module; devstral_sam_0's
  reactor references an undefined variable; devstral_sam_2's reactor
  unconditionally auto-advances RECORDING→COMPLETED. Different vendor,
  different hallucination, same component: the SAM contract surface offers
  many ways to write plausible non-executing code.
- **TLA+ adds a new failure mechanism: the imperative-override
  contradiction.** mistral-large's three partially-scoreable TLA+ specs all
  contain `txState' = "INITIATING" /\ UNCHANGED <<txState>>` (with a comment
  "Override above") — a self-contradictory conjunction that permanently
  disables InitiatePayment, deadlocking all 18 IDLE windows. Declarative
  semantics misread as imperative assignment-with-override. Its two dead
  TLA+ specs are parse errors (unterminated IF/THEN/ELSE); leanstral's are
  cfg-syntax-in-module and out-of-scope operator references.
- **The sharpened claim:** "TLA+ conditional ≈97–100%" holds only where
  losses are idiom/checkability (all four Claude models, devstral 96.6%).
  For mistral-large and leanstral, corpus v2's added rule-coverage windows
  expose genuine semantic misses in the TLA+ arm too (conditional 59.1% /
  57.8%) — the same misses as their JS arms. The correct universal statement
  is the language-independence of semantic error, not a universal
  conditional ceiling.
- **Specialization bought nothing.** The Lean 4 prover specialist showed no
  TLA+ advantage (it produced 2/5 unparseable TLA+ specs and the study's
  highest variance); the code specialist sits mid-pack. Absolute level
  tracks general capability, not domain tuning.

### Contamination bookkeeping (Mistral panel)

mistral-large-2512 and devstral-2512 are v25.12 releases (December 2025) —
their training necessarily predates the code's existence (2026-02/03):
contamination impossible, same dates argument as the Claude panel.
leanstral-1-5 post-dates the repo's publication and its cutoff is not
publicly stated, so dates alone cannot rule it out; the beyond-prompt
artifact scan (methodology per `tla_eval/tasks/finixpos/CONTAMINATION.md`)
was therefore run over all 45 Mistral-panel specs: **zero domain-token
hits** (only generic English/JS tokens). Leanstral's erratic, mid-pack
performance is additionally the opposite of a memorization signature.

## Artifact index

- Extraction: `tla_eval/tasks/finixpos/EXTRACTION.md`, verbatim sources in `tla_eval/tasks/finixpos/source/`
- Plan: `docs/finixpos_study_plan.md` · Task: `tla_eval/tasks/finixpos/task.yaml` · Prompts: `tla_eval/tasks/finixpos/prompts/`
- Instrumentation patch: `data/patches/finixpos_trace.patch`; harness: `baanbaan/Merchant/v2/tools/finixpos-trace-harness/`
- Corpus: `data/sys_traces/finixpos/*.ndjson` (75 windows); coverage: `tla_eval/tasks/finixpos/corpus_coverage.md`
- Reference models + TLC: `tla_eval/tasks/finixpos/reference/` (FinixPOS.tla, FinixPOSEnv.tla, FINDINGS.md, counterexamples/, CONTROLS.md, reference specs + mutations)
- Replay: `scripts/finixpos_tv.py` · Driver: `scripts/finixpos_phase3_study.py` · Results: `output/finixpos_phase3_study.json`, specs in `output/finixpos_study_specs/`

## Corpus v2 (added after review of the single-window caveat)

v1's two acceptor-rewrite rules were each detected by exactly one window. Six
added scenarios (`run-v2-extras.ts`; real executions, same harness) bring the
corpus to **101 windows** (`data/sys_traces/finixpos_v2/`, v1's 75 untouched):
3 CANCELLING+TAP_DECLINED windows (three decline codes), 3 AWAITING_TAP
partial approvals (three ratios), and 2 partial approvals delivered through
the unguarded paths (CANCELLING, resolveVerification). The latter two are
**live bug-3b evidence**: the real code recorded short charges
(`approvedAmountCents=1680 < amountCents=2180`, s08d additionally with
`finix_transfer_id = NULL` — bug 7) and marked the orders paid.

**Controls on v2** (references 101/101 in all three languages):

| mutation | lean | sam | tla | windows failed |
|---|---|---|---|---|
| m1 drop CANCELLING rewrite | 98/101 | 98/101 | 98/101 | the 3 CANCELLING+TAP_DECLINED, identical across languages |
| m2 drop partial guard | 98/101 | 98/101 | 98/101 | the 3 AWAITING_TAP partials, identical across languages |

Each rule now costs ~3% and is detected by 3 windows; the bug-3b windows
correctly PASS for specs that (like the real code) accept partials outside
AWAITING_TAP.

**Rescore of the 15 generations saved at the time** (this appendix predates
the grid's completion; the full-grid v2 rescore is now the analysis of record
in deliverable (b) above — `output/finixpos_v2_rescore.json` holds all 60):

| spec | v1 (75) | v2 (101) | shortfall identity |
|---|---|---|---|
| claude lean ×4 | 75 ×4 | 101 ×4 | — |
| claude sam 0,1,3 | 75 | 101 | — |
| claude sam 2 | 73 | **95** (6 fail) | missed BOTH rewrite *rules*: all 3 cancel-rewrite + all 3 partial windows |
| claude tla 0,1,3 | 75 | 101 | — |
| claude tla 2 | 71 | **97** (4 unscoreable) | same 4 guard-idiom no-op windows as v1; no new losses |
| haiku lean 0 | 74 | **98** (3 fail) | missed the partial-guard *rule* (all 3 partial windows) |
| haiku sam 0 | 0 | **0** (101 fail) | dead intent wiring (tuple-style actions), unchanged |
| haiku tla 0 | 62 | **80** (3 fail + 18 unscoreable) | fails = the same 3 partial windows as its lean spec; unscoreables = guard-idiom no-ops/rewrites |

**Behavioral uniqueness (v2 status vectors):** claude lean 1 distinct
behavior of 4; claude sam 2 of 4; claude tla 2 of 4; haiku n=1 per arm.

**Did any conclusion change? No — two sharpened.** (1) v2 turns window-level
misses into rule-level measurements: claude_sam_2's penalty grows from 2.7%
to 5.9% because it genuinely lacks both rewrite rules, and haiku's partial-guard
omission is now visible as the *same semantic miss in its lean and TLA+ specs*
(identical 3 failing windows) — the miss is model-level, not language-level,
while haiku's TLA+ adds 18 replay-contract (guard-idiom) unscoreables and its
SAM spec stays at zero for wiring reasons: a clean per-arm decomposition of
semantic vs contract vs ceremony error. (2) The corpus itself now carries two
more real-execution confirmations of bug 3b/7.

## Post-fix validation (review response)

*Added 2026-07-04 in response to the reviewer's point that the study
identified the gaps and authored a patch but did not (a) re-verify the patched
system through the same pipeline, nor (b) establish that the gaps found were
the only ones. All three verification layers were rerun against the patch
(`patches/terminal-payment-gap-fixes.patch`, preview
`terminal-payment-gapfix-preview.ts`).*

### 1. Re-model-check: all 7 counterexamples vanish; invariants hold with every failure gate on

`reference/FinixPOSFixed.tla` + `reference/FinixPOSFixedEnv.tla` model the
patched dispatch relation and environment (breadcrumb-on-every-abandon-path,
mid-create cancel handler, widened partial guard, fail-closed
VERIFICATION_UNAVAILABLE, CANCELLED-rows sweep, multi-id cancel probe,
transferId threading). TLC (`fixed_*.cfg`, `-deadlock`):

| config | gates | result | distinct states |
|---|---|---|---|
| `fixed_clean` | none | **HOLDS** (all invariants incl. `Inv_NoPartialRecorded`) | 131 |
| `fixed_bug1..bug5` | one each | **HOLDS** — every pre-fix counterexample gone | 136–239 |
| `fixed_allfail` | **all five simultaneously** | **HOLDS** (I1, I3, wedge, gap-7 tid) | 411 |

The invariant set is strictly stronger than the pre-fix study's: it adds
`Inv_RecordingHasTransferId` (gap 7 — fails pre-fix, demonstrated live as
s03b's NULL transfer id) and judges "no lost charge" against the patch's
recovery mechanisms (`Recoverable`).

**Answering (b) — were those the only problems?** Within the modeled failure
envelope (every gate on, full state graph), yes for the pre-fix gap classes —
and the exercise surfaced exactly two remaining issues, both reported:

1. **NEW patch defect (bookkeeping, narrow):** `Inv_NoPartialRecorded` is
   violated on the *recovery* paths (`fixed_allfail_partialbook.cfg`,
   trace `counterexamples/fixed_partialbook.raw.txt`):
   `recordSucceededTransferAndAdvance` writes the payments row **before**
   dispatching, so a partial approval discovered via immediate-SUCCEEDED /
   422-SUCCEEDED / last-gasp recovery is recorded *and then* declined and
   refunded — order marked paid at the partial amount with the money
   returned. Customer is whole; the books are wrong. Patch-v2: apply the
   partial check inside `recordSucceededTransferAndAdvance` before the DB
   write. (Pre-fix this same path was bug 3 itself — row kept, no refund —
   so the patch improves it but incompletely.)
2. **Documented residual (inherent):** gap 4's fail-closed decline under a
   dead local DB (`fixed_bug4_strict.cfg`, trace
   `counterexamples/fixed_bug4_strict_residual.raw.txt`): if the breadcrumb
   INSERT fails twice AND a network-lost create later materializes AND the
   customer taps it, no DB-based recovery can exist — the DB that would hold
   the breadcrumb is the thing that failed. Strictly better than the pre-fix
   wedge; manual recovery from the `payment_events` warn entry (which carries
   the idempotency key) remains possible. Full notes:
   `reference/counterexamples/POSTFIX-NOTES.md`.

### 2. Post-fix real-execution corpus: 23/23 scenarios green, corpus discriminates

`tools/finixpos-trace-harness/run-fixed-corpus.ts` replays **all 23 study
scenarios** against the patched instrumented workflow
(`terminal-payment-traced-fixed.ts`) with post-fix expected outcomes:
**23/23 green, 99 windows** (`data/sys_traces/finixpos_fixed/`), chained,
DB-asserted. Every live bug reproduction flips to the safe outcome:

| scenario | pre-fix (ground truth in v1/v2 corpus) | post-fix |
|---|---|---|
| s04e cancel during INITIATING | stranded tappable transfer, no breadcrumb | cancelled dead, **breadcrumb row present** |
| s04f cancel after blind tap | CANCELLED over a SUCCEEDED charge | **COMPLETED** — multi-id probe honours the charge (new discriminating proxy rule: polls blind until the cancel resolves, probes see the truth) |
| s08c partial mid-cancel | $16.80 recorded, order paid | **CANCELLED / PARTIAL_PAYMENT**, nothing recorded, order unpaid |
| s08d partial via verification | $16.80 recorded, order paid | **DECLINED / PARTIAL_PAYMENT**, transfer id stashed for refund |
| s03b verification approved | payments row with NULL transfer id | row carries `TRswept_approved` |

Controls: `reference_lean_fixed.js` passes **99/99**; the *pre-fix* reference
replayed on the post-fix corpus fails **exactly the 6 windows whose semantics
the patch changed** (3 stash, 2 widened-guard, 1 tid-threading) and nothing
else — the corpus discriminates pre- from post-fix behavior precisely.
(Known coverage gap: the new AWAITING_VERIFICATION × CANCEL_PAYMENT staff
exit appears only in the TLC model, not the trace corpus.)

### 3. LLM arms on the fixed system: 10/10 generations at 100%

`scripts/finixpos_postfix_study.py` — lean contract, derivation mode, patched
source packet (`source_packet_fixed.ts`), prompt updated only for the changed
`TAP_APPROVED` data shape; scored on the 99-window post-fix corpus:

| model | lean, N=5 |
|---|---|
| Fable 5 | 99, 99, 99, 99, 99 / 99 |
| Opus 4.8 | 99, 99, 99, 99, 99 / 99 |

Both models independently re-derived the *patched* semantics (widened partial
guard with stash, transferId threading, verification cancel exit) from the
fixed source alone — simultaneously confirming the earlier lean-ceiling result
transfers to the modified system and providing model-independent evidence that
the patched source's observable semantics are internally coherent.

### Reviewer answer, in three sentences

We reran the full verification pipeline against the patch: TLC now proves all
study invariants over the complete failure-enabled state graph (all five gates
on, every original counterexample gone), all 23 real-execution scenarios
reproduce the corrected behavior with the five live bug reproductions flipped
to safe outcomes, and 10/10 fresh LLM generations model the patched system at
100% on the new 99-window corpus. The same rerun answers the "only problems?"
question honestly: it found one new (narrow, customer-favorable) bookkeeping
defect on the recovery-partial path — fix specified for patch v2 — and one
inherent residual (fail-closed decline under a dead local DB), both with saved
TLC traces. Verification artifacts: `reference/FinixPOSFixed*.tla` +
`fixed_*.cfg`, `counterexamples/POSTFIX-NOTES.md`,
`data/sys_traces/finixpos_fixed/`, `output/finixpos_postfix_study.json`.
