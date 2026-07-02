#!/usr/bin/env python3
"""Completes the lean-contract story: model-generated lean specs through ALL phases.

The paired study (scripts/tla_phase3_study.py) validated the plain-JS arm on
Phase 3 (transition validation) but discarded the generated spec text. The lean
prototype (scripts/lean_demo.py) validated Phases 2 & 4 on a *reference* spec.
This script merges the two: it (re)generates N plain-JS specs per model, SAVES
each one, and runs Phase 2 (bounded exploration), Phase 3 (transition validation)
and Phase 4 (invariants) on the *same* saved spec — so the claim "model-generated
lean specs pass all phases, N=5, four models" rests on one coherent artifact set.

Saved specs land in output/lean_specs/<model>_<gen>.js; results are resumable via
output/lean_full_pipeline.json (keyed model|gen). Costs ~N*|models| plain-JS
completions (the study driver never persisted these, so a small regen is required).

Usage:
    python scripts/lean_full_pipeline_study.py [--n 5] [--models claude fable sonnet haiku]
Requires Docker (sandbox) + ANTHROPIC_API_KEY.
"""
import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / ".env", override=False)
except ImportError:
    pass

from tla_eval.config import get_configured_model
from tla_eval.models.base import GenerationConfig
from tla_eval.tasks.loader import get_task_loader
from tla_eval.languages import get as get_backend
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows
from plain_js_tv import plain_js_tv, plain_js_explore
from lean_demo import ACTIONS, INVARIANTS  # shared action domain + spinlock invariants

WINDOWS = load_trace_windows("spin")
NW = len(WINDOWS)
JSB = get_backend("js-sam")
SPECS_DIR = PROJECT_ROOT / "output" / "lean_specs"
RESULTS_FILE = PROJECT_ROOT / "output" / "lean_full_pipeline.json"


def _fill(tpl: str, src: str) -> str:
    return tpl.replace("{source_code}", src).replace("{file_path}", "ostd/src/sync/spin.rs")


def evaluate(spec_path: Path) -> dict:
    """Run Phases 2/4 (explore) and Phase 3 (tv) on one saved lean spec."""
    rep = plain_js_explore(spec_path, ACTIONS, INVARIANTS, depth_max=6)
    loadable = bool(rep.get("ok"))
    p2_ok = loadable and rep.get("classification") is None
    viol = rep.get("invariantViolations") or {}
    p4_ok = loadable and not viol
    statuses = plain_js_tv(spec_path, WINDOWS)
    p3_pass = statuses.count("pass")
    p3_ok = p3_pass == NW
    return {
        "loadable": loadable,
        "p2_ok": p2_ok,
        "p2_classification": rep.get("classification"),
        "p2_states": rep.get("uniqueStates"),
        "p4_ok": p4_ok,
        "p4_violations": list(viol.keys()),
        "p3_pass": p3_pass,
        "p3_total": NW,
        "p3_ok": p3_ok,
        "all_phases": bool(p2_ok and p4_ok and p3_ok),
        "explore_error": None if loadable else rep.get("error"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--models", nargs="+", default=["claude", "fable", "sonnet", "haiku"])
    args = ap.parse_args()

    SPECS_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(RESULTS_FILE.read_text(encoding="utf-8")) if RESULTS_FILE.exists() else {}

    task = get_task_loader().load_task("spin")
    pjs_prompt = _fill(
        (PROJECT_ROOT / "tla_eval/tasks/spin/prompts/plain-js/direct_call.txt").read_text(encoding="utf-8"),
        task.source_code,
    )

    for model in args.models:
        for gen in range(args.n):
            key = f"{model}|{gen}"
            if key in results:
                continue
            spec_path = SPECS_DIR / f"{model}_{gen}.js"
            resp = get_configured_model(model).generate_direct(pjs_prompt, GenerationConfig(top_p=None))
            if not resp.success:
                results[key] = {"error": resp.error_message, "all_phases": False}
            else:
                spec_text = JSB.extract_artifacts(resp.generated_text).spec
                spec_path.write_text(spec_text, encoding="utf-8")
                results[key] = {"spec_file": str(spec_path.relative_to(PROJECT_ROOT)), **evaluate(spec_path)}
            RESULTS_FILE.write_text(json.dumps(results, indent=1), encoding="utf-8")
            r = results[key]
            print(f"{key}: load={r.get('loadable')} P2={r.get('p2_ok')} "
                  f"P3={r.get('p3_pass')}/{r.get('p3_total')} P4={r.get('p4_ok')} "
                  f"ALL={r.get('all_phases')}" + (f"  err={r['error']}" if r.get('error') else ""),
                  flush=True)

    # ---- Aggregate ----
    print("\n===== LEAN SPECS THROUGH ALL PHASES (N generations per model) =====")
    print(f"{'model':8s} {'loadable':>9s} {'P2 clean':>9s} {'P3=28/28':>9s} {'P4 hold':>8s} {'ALL PASS':>9s}")
    grand_all = 0
    grand_n = 0
    for model in args.models:
        rows = [results[f"{model}|{g}"] for g in range(args.n) if f"{model}|{g}" in results]
        n = len(rows)
        load = sum(1 for r in rows if r.get("loadable"))
        p2 = sum(1 for r in rows if r.get("p2_ok"))
        p3 = sum(1 for r in rows if r.get("p3_ok"))
        p4 = sum(1 for r in rows if r.get("p4_ok"))
        alle = sum(1 for r in rows if r.get("all_phases"))
        grand_all += alle
        grand_n += n
        print(f"{model:8s} {load:>4d}/{n:<4d} {p2:>4d}/{n:<4d} {p3:>4d}/{n:<4d} {p4:>3d}/{n:<4d} {alle:>4d}/{n:<4d}")
    print(f"\nAll four phases, all models: {grand_all}/{grand_n} model-generated lean specs pass every phase.")
    print(f"Saved specs: {SPECS_DIR.relative_to(PROJECT_ROOT)}/  ·  raw results: {RESULTS_FILE.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
