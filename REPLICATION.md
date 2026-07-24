# Replication guide — JS-SAM vs TLA+ study (spin/locksvc)

This repository's cross-language study concluded that the specification
*contract* — not the language, not primarily the prompt — governs LLM
transcription fidelity on these tasks. **The first author of this study is the
author of the SAM pattern**, and several load-bearing materials are
experimenter-authored (trace scenarios, the semantics block, the repair
prompt, both sides' prompts). This guide exists so someone who is *not* the
author can rerun everything from the committed artifacts, audit those
materials, and vary them.

## What you need

- Python 3.12, `pip install -e .`
- Docker (JS sandbox: `node:20-slim`; every model-written artifact runs with
  `--network none`, read-only rootfs, non-root, resource caps)
- Java 17+ on PATH (TLC; jars pinned in `lib/`: tla2tools v1.8.0 + CommunityModules)
- `ANTHROPIC_API_KEY` in `.env` (models pinned in `config/models.yaml`:
  claude-opus-4-8, claude-fable-5, claude-sonnet-4-6, claude-haiku-4-5)

## Reproduce the analyses without any API calls

All raw data is committed. These re-derive every table in
`docs/js_sam_tla_phase3_results.md` and the paper from the committed JSON:

```bash
python scripts/tla_phase3_analysis.py     # base rates, uniqueness, permutation tests, factorial
python scripts/trace_coverage_audit.py    # combo coverage, schedule diversity, reorder premise
python scripts/tla_direct_tv.py output/tla_specs/haiku_0.tla --functional   # any saved spec
python scripts/lean_demo.py --task spin   # reference lean spec, all phases
python scripts/lean_demo.py --task locksvc
```

Committed raw artifacts: `output/tla_phase3_study.json` (per-window outcomes,
all arms), `output/study_specs/`, `output/tla_specs/`, `output/lean_specs*/`,
`output/repair_specs/`, `output/*_audit.json`, trace corpora
`data/sys_traces/{spin,locksvc}/`.

## Regenerate from scratch (API calls; each cell resumable)

```bash
python scripts/tla_phase3_study.py                 # factorial study (spin)
python scripts/lean_full_pipeline_study.py --task spin
python scripts/lean_full_pipeline_study.py --task locksvc
python scripts/repair_generalization.py            # repair + held-out audit
python scripts/repair_multiround.py --models haiku # multi-round repair
python scripts/tla_functional_audit.py             # TLA branching-factor audit
```

Delete the corresponding `output/*.json` first to force regeneration (the
drivers resume from cached cells otherwise). Model sampling is not seeded;
expect per-generation variance (documented cases: the Sonnet repair outcome,
±2-window replay sensitivity for one Haiku spec).

## Recapture the traces (hardware/toolchain required)

- **spin** (Asterinas kernel, QEMU): `scripts/harness/spin/run.sh` — see
  `tla_eval/tasks/spin/INSTRUMENTATION.md` and
  `data/patches/spin_2thread_ktest.patch`.
- **locksvc** (PGo, plain `go test`): clone `DistCompiler/pgo` to
  `data/repositories/pgo`, then `scripts/harness/locksvc/run.sh` and
  `scripts/harness/locksvc/build_windows.py` (the builder verifies the
  grant-before-CS reorder premise per event and refuses traces that fail it).

## Experimenter-authored materials to audit or vary

These are the levers a replication should treat as independent variables, not
constants — each is committed verbatim:

| Material | Path |
|---|---|
| spin trace scenarios (2, deterministic) | `data/patches/spin_2thread_ktest.patch` |
| locksvc workload | `scripts/harness/locksvc/locksvc_trace_test.go` |
| The semantics block (both languages) | `tla_eval/tasks/spin/prompts/direct_call_constrained.txt`, `.../js-sam/direct_call_constrained.txt`, `.../plain-js/direct_call.txt` |
| Derivation prompts (no semantics) | `.../plain-js/direct_call_nosemantics.txt`, `.../direct_call_nosemantics.txt` |
| Deployed JS-SAM prompt | `.../js-sam/direct_call.txt` |
| Repair prompt | `build_repair_prompt` in `scripts/repair_generalization.py` |
| Invariant sets | `data/js_sam_invariant_templates/spin/invariants.yaml`, `data/invariant_templates/spin/invariants.yaml` |
| Observable-state projections | spin: `{lockHeld, lockHolder}`; locksvc: `{holder, waiters-as-set}` (rationale in `scripts/harness/locksvc/build_windows.py`) |

Known sensitivity: prompt prescriptiveness alone moved Sonnet 50→100% — the
semantics block's wording is a first-class experimental variable. If you vary
one prompt, vary its counterpart in the other language identically.

## Known gaps a replication could close (see paper §Limitations)

- The as-deployed agent-mediated TLA+ Phase 3 (excluded here as a confound;
  costly).
- Other-vendor models (registry entries exist in `config/models.yaml`;
  blocked on credentials in this environment).
- The factorial on `locksvc` (lean arms done; SAM/TLA arms need locksvc
  prompts + a locksvc TLC replay module).
- Richer trace corpora: randomized/adversarial schedules, blocking-waiter
  wakeup instrumentation, workloads with re-requests and failure paths.
