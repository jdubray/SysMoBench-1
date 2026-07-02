# JS-SAM vs. TLA+ — same models, same task (`spin`)

**Task:** `spin` · **Method:** `direct_call` · **Models:** Opus 4.8, Fable 5,
Sonnet 4.6, Haiku 4.5 · **Date:** 2026-07-01

This is the head-to-head the JS-SAM backend exists to inform: do LLMs produce
usable specifications more readily in **JavaScript (SAM)** than in a formal
language (**TLA+**), on the same task with the same models?

Phases 1, 2, and 4 are compared directly (syntax, model checking, invariant
verification), using the **direct** invariant translator for both languages.
Phase 3 is not compared here: JS-SAM's Phase 3 is a self-contained direct replay,
while TLA+'s is a heavy coding-agent path — different mechanisms, not a fair
one-to-one.

## Results

| | P1 syntax | P2 model-checkable | P4 invariants |
|---|---|---|---|
| **JS-SAM** | 4/4 PASS | **4/4 PASS** (all 326,592 states) | **4/4 PASS** (3/3 each) |
| **TLA+**   | 4/4 PASS | **1/4 PASS** | **1/4 PASS** |

Per-model TLA+ detail:

| Model | P1 | P2 | P4 | Why P2 failed |
|---|---|---|---|---|
| Opus 4.8 | PASS | **FAIL** | FAIL | unbounded `CHOOSE` (TLC rejects) |
| Fable 5 | PASS | **PASS** (574 states) | **PASS** (7 inv) | — clean |
| Sonnet 4.6 | PASS | **FAIL** | FAIL | unbounded `CHOOSE` (TLC rejects) |
| Haiku 4.5 | PASS | **FAIL** | FAIL | config generation fell back → no usable `.cfg` |

## Findings

**Every model writes valid syntax in both languages (P1 4/4 vs 4/4).** The
languages diverge sharply at Phase 2 (is the spec actually *checkable*): all four
models produce runnable JS-SAM modules, but only one of four produces a
TLC-checkable TLA+ spec.

Two distinct causes, attributed precisely:

1. **A TLA+ semantic pitfall that JavaScript doesn't have.** Opus and Sonnet both
   modeled "no lock owner" as `NULL == CHOOSE v : v \notin Threads`. SANY accepts
   it (P1 passes), but TLC cannot evaluate an unbounded `CHOOSE`, so model
   checking fails. JavaScript has a native `null`, so the JS-SAM specs express the
   same idea without any TLC-style trap. This is a genuine, model-independent
   advantage of the JS substrate for this construct — and it caught **two of the
   four models**, including the most capable Opus.

2. **The config-generation surface that JS-SAM avoids.** TLA+ model checking needs
   a separate `.cfg` (CONSTANTS/INIT/NEXT/INVARIANTS) that the harness must
   generate to match the spec; for Haiku that generation fell back and produced no
   usable config (0 states explored). A JS-SAM module is self-contained and
   executable — there is **no separate config to generate**, so this whole failure
   mode does not exist.

**Net:** on this task, models reach an end-to-end-evaluable spec far more readily
in JS-SAM (4/4 through P4) than in TLA+ (1/4), for two structural reasons — a
formal-language semantic trap absent in JS, and a config-generation step JS-SAM
doesn't require. This is direct evidence for the JS-SAM hypothesis: *familiarity
with the host language plus a self-contained executable artifact lowers the bar
to a usable spec.*

## Caveats

- **The TLA+ gap is not purely model capability.** It mixes a real TLA+ pitfall
  (unbounded `CHOOSE`, 2/4) with a harness config-generation shortfall (1/4). The
  `CHOOSE` failures are the model's; the Haiku config failure is the harness's.
  Only Fable completed cleanly.
- **Single task, single generation, direct translator.** No repair round here
  (unlike `docs/js_sam_repair_experiment.md`); a repaired Opus/Sonnet might fix the
  `CHOOSE` easily.
- **Phase 3 not compared** (different mechanisms). JS-SAM's discriminating Phase-3
  scores are in `docs/js_sam_model_comparison.md`.
- **P4 invariant counts differ by library** (TLA+ spin ships 7 invariants,
  JS-SAM 3), so P4 is compared as pass/fail, not by count.
- TLA+ tooling note: the setup-downloaded `tla2tools.jar` / `CommunityModules`
  jars were truncated (broken zips) and had to be re-fetched from the pinned
  releases before any TLA+ phase would run.
