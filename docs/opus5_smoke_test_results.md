# Opus 5 smoke test — `spin` / TLA+ / `direct_call`

**Date:** 2026-07-24 · **Model:** `claude-opus-5` (new `opus5` entry in `config/models.yaml`)
· **Task:** `spin` (Asterinas OS spinlock) · **Language:** TLA+ · **Method:** `direct_call` · **N = 5**

Scope: a smoke test of a newly released model, not a benchmark run. One task — the
smallest in the bench — one language, five generations. Every number below should be
read with that N.

## Headline

Opus 5 has **one shallow TLA+ idiom problem and no observed modeling problem** on this
task. Single-shot Phase 2 scores it at 20%. One repair round takes it to 100%, and
Phase 4 is clean at 35/35 once a harness bug is removed. The gap between 20% and 100%
is a single line of syntax preference.

The smoke test also surfaced **three harness bugs**, two of which corrupt scores for
reasons unrelated to model quality. Those are the more actionable result.

## Results by phase

| Phase | Metric | Result |
|---|---|---|
| 1 | `compilation_check` | **5/5 pass** — every spec parsed, 0 syntax / 0 semantic errors |
| 2 | `runtime_check`, first shot | **1/5 pass** |
| 2 | `runtime_check`, after one repair round | **5/5 pass, 0 regressions** |
| 4 | `invariant_verification` | **35/35 invariants pass** (after removing a name-collision bug) |
| 3 | `transition_validation` | **Not run** — launcher broken on Windows (see below) |

### Phase 2 first shot — one idiom, four failures

Four of five specs died at TLC evaluation with **0 states explored**:

```
Error: TLC attempted to evaluate an unbounded CHOOSE.
```

All four contained the identical sentinel definition, byte for byte:

```tla
NULL == CHOOSE v : v \notin Threads
```

Legal to SANY, refused by TLC. The spec is rejected before exploration begins, so the
failure is upstream of anything to do with locks, concurrency, or memory ordering.

The one passing run shows the model already knows the right idiom — it declared the
sentinel as a constant and constrained it, and the harness bound it to a TLC model value:

```tla
CONSTANTS Threads, NULL
ASSUME NULL \notin Threads
```
```
CONSTANTS  Threads = {t1, t2, t3}  NULL = NoThread
```

So the 4/5 failure rate is idiom selection, not capability. Three consecutive identical
failures initially looked deterministic; the fourth run broke that, which is why N=5
matters here and N=3 would have given the wrong answer.

### Phase 2 after repair — converges everything, breaks nothing

One repair round, following the existing `repair_tla_spin.py` protocol: the model gets its
own spec, the `.cfg`, and TLC's verbatim error — nothing else — and rewrites the module.

| run | baseline | repaired | distinct states |
|---|---|---|---|
| 12:47:54 | FAIL | **PASS** | 0 → 854 |
| 13:11:08 | FAIL | **PASS** | 0 → 5107 |
| 13:12:26 | FAIL | **PASS** | 0 → 1890 |
| 13:13:37 | PASS | **PASS** | 412 → 316 |
| 13:14:53 | FAIL | **PASS** | 0 → 282 |

4/4 failures converged in one round; `still_has_unbounded_choose` is false everywhere.
The already-passing spec was put through the same round as a control and survived intact.
This is the Sonnet-5 tier of repair behavior from the July grid, not the Sonnet-4.6 tier.

**Caveat worth keeping:** the repaired specs explore 282 to 5107 distinct states — an 18×
spread. All five pass the same gate while modeling visibly different things. Phase 2
passing means *checkable*, not *agreeing*.

### Phase 4 — 35/35, but only after fixing the harness

Raw scores looked bad: `MutualExclusion` failed in all 5 runs, `LockConsistency` in 3.
None of those were real violations.

The evaluator appends its own `<Name> == ...` definition to the generated module. When the
spec already defines an operator of that name — which it does whenever the model names its
invariants after the expert templates — SANY rejects the whole module:

```
Operator MutualExclusion already defined or declared.
line 179 ... This duplicates the one at line 168 ...
```

TLC never explores a state, and the invariant is recorded as a FAIL. The correlation is
perfect across all 5 runs × 7 invariants: **every** invariant with two definitions failed
and never ran; **every** invariant with one definition ran and passed.

`scripts/rescore_p4_name_collision.py` renames the appended definition to `<Name>_CHK`,
repoints the `.cfg`, and re-runs TLC — no model call, purely mechanical. All 8 collided
invariants then pass:

| run | invariant | rescored | states |
|---|---|---|---|
| 20260724135006 | MutualExclusion, LockConsistency | PASS, PASS | 854 |
| 20260724142245 | MutualExclusion | PASS | 5107 |
| 20260724142306 | MutualExclusion | PASS | 1890 |
| 20260724142325 | MutualExclusion, LockConsistency | PASS, PASS | 316 |
| 20260724142345 | MutualExclusion, LockConsistency | PASS, PASS | 282 |

**Phase 4: 35/35.** Zero genuine invariant violations across all five specs, including the
liveness properties. Note this run used `--inv-translator-type direct` rather than the
default agent translator — a deviation from the standard Phase 4 protocol, chosen to keep
the run fast and on one API key.

The scoring impact is severe and systematic: a spec is penalized **for naming its
invariants the way the expert templates name them**, i.e. for doing the expected thing.
Any model that adopts template naming is silently down-scored on Phase 4.

### Phase 3 — blocked, Windows path bug

`transition_validation` never launched:

```
/bin/bash: C:Usersjjdubcodesysmobenchscriptslaunch_tv_eval.sh: No such file or directory
```

`tla_eval/evaluation/semantics/transition_validation.py:98-105` builds a `bash` command
from Windows `Path` objects via `str()`. Bash consumes the backslashes as escapes and the
path collapses. Both the launcher path and the `--spec=` / `--workspace-root=` arguments
need POSIX conversion before they reach `bash`. Not attempted here — the run also needs
the Docker/QEMU trace harness and the warning advertises "30 min to several hours" per
spec, which did not fit the remaining key lifetime.

## Comparison

| model | spin P2 first shot | source |
|---|---|---|
| Fable 5 | PASS (574 states) | July 1 run, N=1 |
| **Opus 5** | **1/5 PASS** | this run, N=5 |
| Opus 4.8 | FAIL, same CHOOSE construct | July 1 run, N=1 |

Both comparison points are single samples, and that July batch was partly broken —
the first `claude` and `fable` runs died on a `Could not find or load main class tlc2.TLC`
classpath error, and the `sonnet` and `haiku` cells have no `result.json` at all. Opus 5
looks worse than Fable 5 and comparable to Opus 4.8 on raw single-shot P2, but "1/5 vs
0/1" will not support a ranking.

## What this says about the benchmark

Single-shot Phase 2 on this task separates Opus 5 from Fable 5 by 5×. Almost all of that
gap is one line of syntax preference that one round of repair erases. Two implications:

1. **N=1 cells are not safe here.** Three identical samples suggested determinism; the
   fourth refuted it. The July grid's N=1 cells cannot distinguish idiom luck from
   capability.
2. **The repair-round metric carries more signal than first-shot P2** for models in this
   tier. It separated Sonnet 5 from Sonnet 4.6 in the etcd study, and it is what
   distinguishes Opus 5's actual competence from its idiom habit here.

## Harness bugs found

1. **Phase 4 invariant name collision** *(corrupts scores)* — appended definition collides
   with the spec's own operator of the same name; SANY rejects the module and the invariant
   is scored FAIL without running. Rescorer: `scripts/rescore_p4_name_collision.py`.
   The evaluator should emit a uniquely-named operator, or strip the spec's existing
   definition, rather than appending a duplicate.
2. **Repair extractor takes the wrong fence** *(corrupts scores)* — `extract_tla` in
   `scripts/repair_tla_spin.py:90` takes the **first** ` ```tla ` fence. When a reply
   quotes the offending line in its own fence before emitting the rewrite, the extractor
   captures the quote and discards the module. It cost one run a spurious parse-error
   "failure" here; re-extracted correctly, that run passed with 5107 states.
   **`repair_tla_spin.py` was deliberately left untouched** so the recorded Experiment-3
   numbers are not silently altered — but those numbers were produced with this extractor,
   so any repair scored there as a parse failure should be re-checked before publication.
   A corrected extractor (prefer the fence containing `MODULE spin`, then the longest)
   lives in `scripts/repair_tla_spin_opus5.py`.
3. **Phase 3 launcher unusable on Windows** *(blocks the phase)* — see above.

## Artifacts

- `output/runtime_check/tla/spin/direct_call_opus5/` — the 5 baseline specs and results
- `output/tla_repair_opus5/` + `output/tla_repair_opus5.json` — repaired specs, TLC output
- `output/invariant_verification/tla/spin/direct_call_opus5/` — Phase 4, per-invariant
- `output/p4_collision_rescore.json` — collision rescore verdicts
- `scripts/repair_tla_spin_opus5.py`, `scripts/rescore_p4_name_collision.py`

## Config changes

- `config/models.yaml`: new `opus5` entry (`claude-opus-5`, no sampling params, 64000
  max tokens, 1800 s timeout).
- `tla_eval/models/litellm_adapter.py:284`: `claude-opus-5` **and** `claude-sonnet-5` added
  to `_should_omit_sampling_params`. The Claude 5 family 400s on `temperature`/`top_p`/
  `top_k` and litellm's `drop_params` does not yet cover these ids. `claude-sonnet-5` had
  only ever been patched in the `sysmobench-etcd` worktree, never in the main repo.

## Suggested next steps

1. Fix the Phase 4 name collision — it mis-scores every model that adopts template naming,
   and it is a bigger threat to leaderboard validity than anything found about Opus 5.
2. Decide on the `repair_tla_spin.py` extractor: fix and re-run, or leave and document.
3. Fix the Phase 3 Windows launcher, then run TV over the five repaired specs. That is the
   open question this smoke test could not answer: whether five specs spanning 282–5107
   states actually agree with the real spinlock's behavior.
4. Get Fable 5 and Sonnet 5 to N=5 on `spin` before any Opus-5-vs-them claim is made.
