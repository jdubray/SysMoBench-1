#!/usr/bin/env python3
"""Generalization audit for the Phase-3 repair loop (review point 3).

The repair experiment re-checked repaired specs only on Phase 1 + Phase 3, on the
SAME 28 windows whose failures were quoted in the repair prompt. Nothing prevented
a repair from memorizing those windows (branch on the pre-state, return the
expected post). This audit re-runs the repair loop with artifacts saved and scores
every baseline and repaired spec on:

  - P3-seen      the original 28-window corpus (8 distinct (pre,action,data) combos)
  - P3-heldout   the 10 combos of the observable domain the corpus NEVER shows
                 (3 pre-states x 6 actions = 18 total; 8 seen). Posts are forced by
                 the observable single-step semantics validated against the kernel
                 on the seen combos: every held-out combo is an acquire on a held
                 lock, a release by a non-holder, or a release of a free lock — all
                 observable no-ops.
  - P2           bounded exploration with the distinct-semantic-state metric
  - P4           three observable safety invariants over all reachable states

Structural caveat (stated up front, also in the doc): the kernel instrumentation
emits acquire events at acquisition SUCCESS, so no real capture can contain an
acquire-on-held window — the held-out set is semantics-forced, not newly captured,
and since all held-out posts are "unchanged", a memorizer whose default branch
returns the state unchanged would still pass P3-heldout. Held-out scoring
therefore refutes only memorizers with unsafe defaults; the P2 distinct-state
audit and direct inspection of the repaired specs (saved to output/repair_specs/)
complement it.

Usage:
    python scripts/repair_generalization.py [--models claude fable sonnet haiku]
Requires Docker + ANTHROPIC_API_KEY. Resumable via output/repair_generalization.json.
"""
import argparse
import glob
import json
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / ".env", override=False)
except ImportError:
    pass

from tla_eval.languages import get
from tla_eval.languages.js_sam import _run_helper
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows
from tla_eval.config import get_configured_model
from tla_eval.models.base import GenerationConfig

backend = get("js-sam")
SEEN_WINDOWS = load_trace_windows("spin")
SPECS_DIR = PROJECT_ROOT / "output" / "repair_specs"
RESULTS_FILE = PROJECT_ROOT / "output" / "repair_generalization.json"

# Observable safety invariants (same trio the lean pipeline checks).
INVARIANTS = [
    {"name": "LockStatusConsistency",
     "predicate": "(s) => s.lockHeld === (s.lockHolder !== null)"},
    {"name": "ValidHolder",
     "predicate": "(s) => s.lockHolder === null || s.lockHolder === 0 || s.lockHolder === 1"},
    {"name": "MutualExclusion",
     "predicate": "(s) => !s.lockHeld || (s.lockHolder === 0 || s.lockHolder === 1)"},
]


def build_heldout_windows():
    """The 10 (pre, action, data) combos absent from the 28-window corpus.

    Enumerate the full observable domain and drop the seen combos; each
    held-out post is forced by the validated single-step semantics (acquire on
    held / release by non-holder / release of free lock => unchanged).
    """
    pres = [
        {"lockHeld": False, "lockHolder": None},
        {"lockHeld": True, "lockHolder": 0},
        {"lockHeld": True, "lockHolder": 1},
    ]
    seen = set()
    for a, pre, _post in SEEN_WINDOWS:
        d = a["data"]
        seen.add((pre["lockHeld"], pre["lockHolder"], a["name"],
                  d.get("thread"), d.get("callType")))

    def post_of(pre, name, thread):
        if name == "AcquireLock":
            if not pre["lockHeld"]:
                return {"lockHeld": True, "lockHolder": thread}
            return dict(pre)  # acquire on held: no observable change
        # ReleaseLock
        if pre["lockHolder"] == thread:
            return {"lockHeld": False, "lockHolder": None}
        return dict(pre)  # non-holder / free: no observable change

    heldout = []
    for pre in pres:
        for thread in (0, 1):
            for ct in ("lock", "try"):
                key = (pre["lockHeld"], pre["lockHolder"], "AcquireLock", thread, ct)
                if key not in seen:
                    heldout.append((
                        {"name": "AcquireLock", "data": {"thread": thread, "callType": ct}},
                        dict(pre), post_of(pre, "AcquireLock", thread)))
            key = (pre["lockHeld"], pre["lockHolder"], "ReleaseLock", thread, None)
            if key not in seen:
                heldout.append((
                    {"name": "ReleaseLock", "data": {"thread": thread}},
                    dict(pre), post_of(pre, "ReleaseLock", thread)))
    return heldout


HELDOUT_WINDOWS = build_heldout_windows()


def latest_spec(model):
    hits = sorted(glob.glob(str(
        PROJECT_ROOT
        / f"output/compilation_check/js-sam/spin/direct_call_{model}/*/spin.js"
    )))
    return Path(hits[-1]) if hits else None


def p3(spec_path, windows, tag):
    work = Path(tempfile.mkdtemp(prefix=f"rg_{tag}_"))
    outcome = backend.validate_transitions(spec_path, windows, work, timeout=180)
    fpath = work / "transition_failures.json"
    failures = json.loads(fpath.read_text(encoding="utf-8")) if fpath.exists() else []
    return {
        "passed": outcome.total_passed or 0,
        "total": outcome.total_windows or len(windows),
        "per_action": dict(outcome.per_action_pass_rates or {}),
    }, failures


def p2_p4(spec_path):
    with tempfile.TemporaryDirectory() as d:
        out = backend.run_model_checker(spec_path, None, Path(d), timeout=300)
    p2 = {
        "success": out.success,
        "classification": out.classification,
        "distinct_states": out.states_explored,
    }
    resp, err = _run_helper(
        "invariants",
        {"specPath": str(Path(spec_path).resolve()), "invariants": INVARIANTS},
        300,
    )
    if err or not resp:
        p4 = {"error": err or "no response"}
    else:
        results = resp.get("results", [])
        p4 = {
            "held": sum(1 for r in results if r.get("success")),
            "total": len(results),
            "failed": [r["name"] for r in results if not r.get("success")],
        }
    return p2, p4


def build_repair_prompt(spec_text, failures):
    # Same prompt as the original experiment (scripts/repair_phase3.py).
    lines = []
    for f in failures:
        action, pre, post = SEEN_WINDOWS[f["window"]]
        name = action["name"] if isinstance(action, dict) else action
        data = action.get("data", {}) if isinstance(action, dict) else {}
        lines.append(
            f"- action={name} data={json.dumps(data)}\n"
            f"  setState(pre): {json.dumps(pre)}\n"
            f"  real system's post-state: {json.dumps(post)}\n"
            f"  your model was wrong here: {f.get('reason')}"
        )
    return f"""You wrote this JS-SAM spinlock specification:

```javascript
{spec_text}
```

When each transition below is replayed as `setState(pre); actions[action](data); getState()`,
your model's resulting state did NOT match the real Asterinas spinlock. For every
case, the resulting state must equal the real system's post-state on the keys shown
(the projection compares only those keys):

{chr(10).join(lines)}

Rewrite the ENTIRE specification module so that every failing transition above now
produces the real system's post-state, while preserving all behavior that was
already correct. Keep the exact same module contract and exports. Output only the
corrected module in a single ```javascript code fence."""


def evaluate_spec(spec_path, tag):
    seen, failures = p3(spec_path, SEEN_WINDOWS, f"{tag}_seen")
    heldout, _ = p3(spec_path, HELDOUT_WINDOWS, f"{tag}_held")
    p2, p4 = p2_p4(spec_path)
    return {"p3_seen": seen, "p3_heldout": heldout, "p2": p2, "p4": p4}, failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["claude", "fable", "sonnet", "haiku"])
    args = ap.parse_args()

    SPECS_DIR.mkdir(parents=True, exist_ok=True)
    results = json.loads(RESULTS_FILE.read_text(encoding="utf-8")) if RESULTS_FILE.exists() else {}
    print(f"seen corpus: {len(SEEN_WINDOWS)} windows (8 combos); "
          f"held-out: {len(HELDOUT_WINDOWS)} combos (all observable no-ops)\n")

    for model in args.models:
        if model in results:
            continue
        spec_path = latest_spec(model)
        if not spec_path:
            print(f"[{model}] no baseline spec; skipping")
            continue

        entry = {"baseline_spec": str(spec_path.relative_to(PROJECT_ROOT))}
        base_eval, failures = evaluate_spec(spec_path, f"{model}_base")
        entry["baseline"] = base_eval
        b = base_eval
        print(f"[{model}] baseline: seen={b['p3_seen']['passed']}/{b['p3_seen']['total']} "
              f"heldout={b['p3_heldout']['passed']}/{b['p3_heldout']['total']} "
              f"P2={b['p2']['distinct_states']} states P4={b['p4'].get('held')}/3", flush=True)

        if failures:
            resp = get_configured_model(model).generate_direct(
                build_repair_prompt(spec_path.read_text(encoding="utf-8"), failures),
                GenerationConfig(top_p=None))
            if resp.success:
                corrected = backend.extract_artifacts(resp.generated_text).spec
                rep_path = SPECS_DIR / f"{model}_repaired.js"
                rep_path.write_text(corrected, encoding="utf-8")
                syn = backend.validate_syntax(corrected, None,
                                              Path(tempfile.mkdtemp()) / "p1",
                                              timeout=120, spec_filename="spin.js")
                if syn.success:
                    rep_eval, _ = evaluate_spec(rep_path, f"{model}_rep")
                    entry["repaired_spec"] = str(rep_path.relative_to(PROJECT_ROOT))
                    entry["repaired"] = rep_eval
                    r = rep_eval
                    print(f"[{model}] REPAIRED: seen={r['p3_seen']['passed']}/{r['p3_seen']['total']} "
                          f"heldout={r['p3_heldout']['passed']}/{r['p3_heldout']['total']} "
                          f"P2={r['p2']['distinct_states']} states P4={r['p4'].get('held')}/3", flush=True)
                else:
                    entry["repaired_error"] = f"compile: {syn.syntax_errors or syn.semantic_errors}"
                    print(f"[{model}] repaired spec failed to compile")
            else:
                entry["repaired_error"] = resp.error_message
                print(f"[{model}] repair generation failed: {resp.error_message}")
        else:
            entry["repaired"] = None  # nothing to repair

        results[model] = entry
        RESULTS_FILE.write_text(json.dumps(results, indent=1), encoding="utf-8")

    # ---- Summary ----
    print("\n===== REPAIR GENERALIZATION (seen 28 | held-out 10 | P2 distinct | P4) =====")
    print(f"{'model':8s} {'base seen':>10s} {'base held':>10s} {'rep seen':>9s} {'rep held':>9s} {'rep P2':>7s} {'rep P4':>7s}")
    for model in args.models:
        e = results.get(model)
        if not e:
            continue
        b = e["baseline"]
        r = e.get("repaired")
        bs = f"{b['p3_seen']['passed']}/{b['p3_seen']['total']}"
        bh = f"{b['p3_heldout']['passed']}/{b['p3_heldout']['total']}"
        if r:
            rs = f"{r['p3_seen']['passed']}/{r['p3_seen']['total']}"
            rh = f"{r['p3_heldout']['passed']}/{r['p3_heldout']['total']}"
            rp2 = str(r["p2"]["distinct_states"])
            rp4 = f"{r['p4'].get('held')}/3"
        else:
            rs = rh = rp2 = rp4 = "—" if "repaired_error" not in e else "ERR"
        print(f"{model:8s} {bs:>10s} {bh:>10s} {rs:>9s} {rh:>9s} {rp2:>7s} {rp4:>7s}")


if __name__ == "__main__":
    main()
