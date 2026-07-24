#!/usr/bin/env python3
"""Audit the generated TLA+ arm under the FUNCTIONAL Phase-3 check.

The paired study scored the TLA+ arm with an EXISTENTIAL replay (a window passes
if the action can reach the trace post from the pre). A TLA+ action is a relation:
an over-permissive action passes existentially while admitting wrong post-states.
This regenerates N constrained TLA+ specs per model, SAVES each, and re-scores
every window under the functional check (branching factor must be 1 — the action's
one-step image from the pre is exactly {post}), reporting per spec:

  existential_pass  windows the old check passed
  functional_pass   windows with branching factor 1 AND post reached
  over_permissive   windows that passed existentially but have branching factor > 1
  max_bf            largest one-step branching factor over the spec's windows

If functional == existential for every spec (all bf==1), the TLA+ 100% is earned
under a check as strict as the JS one. Any over_permissive window is a spec the
existential replay flattered.

Usage:
    python scripts/tla_functional_audit.py [--n 5] [--models claude fable sonnet haiku]
Requires Java (TLC) + ANTHROPIC_API_KEY.
"""
import argparse
import json
import re
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
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows
from tla_direct_tv import direct_tv, functional_tv, summarize, summarize_functional

SPECS_DIR = PROJECT_ROOT / "output" / "tla_specs"
RESULTS_FILE = PROJECT_ROOT / "output" / "tla_functional_audit.json"


def _extract_tla(text: str) -> str:
    m = re.search(r"```tla\b\s*\n(.*?)\n```", text, re.DOTALL)
    return m.group(1) if m else text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--models", nargs="+", default=["claude", "fable", "sonnet", "haiku"])
    ap.add_argument("--task", default="spin")
    ap.add_argument("--timeout", type=int, default=60)
    args = ap.parse_args()

    windows = load_trace_windows(args.task)
    nw = len(windows)
    SPECS_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(RESULTS_FILE.read_text(encoding="utf-8")) if RESULTS_FILE.exists() else {}

    task = get_task_loader().load_task(args.task)
    prompt = (
        (PROJECT_ROOT / f"tla_eval/tasks/{args.task}/prompts/direct_call_constrained.txt")
        .read_text(encoding="utf-8")
        .replace("{source_code}", task.source_code)
        .replace("{file_path}", "ostd/src/sync/spin.rs")
    )

    for model in args.models:
        for gen in range(args.n):
            key = f"{model}|{gen}"
            if key in results:
                continue
            spec_path = SPECS_DIR / f"{model}_{gen}.tla"
            resp = get_configured_model(model).generate_direct(prompt, GenerationConfig(top_p=None))
            if not resp.success:
                results[key] = {"error": resp.error_message}
            else:
                spec_path.write_text(_extract_tla(resp.generated_text), encoding="utf-8")
                ex = summarize(direct_tv(spec_path, windows, args.timeout))
                fn = summarize_functional(functional_tv(spec_path, windows, args.timeout))
                results[key] = {
                    "spec_file": str(spec_path.relative_to(PROJECT_ROOT)),
                    "existential_pass": ex["passed"], "existential_unscoreable": ex["unscoreable"],
                    "functional_pass": fn["pass"], "over_permissive": fn["over_permissive"],
                    "functional_fail": fn["fail"], "functional_unscoreable": fn["unscoreable"],
                    "max_bf": fn["max_branching_factor"], "windows_bf_gt1": fn["windows_branching_gt1"],
                }
            RESULTS_FILE.write_text(json.dumps(results, indent=1), encoding="utf-8")
            r = results[key]
            print(f"{key}: existential_pass={r.get('existential_pass')}/{nw} "
                  f"functional_pass={r.get('functional_pass')}/{nw} "
                  f"over_permissive={r.get('over_permissive')} max_bf={r.get('max_bf')}"
                  + (f"  err={r['error']}" if r.get("error") else ""), flush=True)

    # ---- Aggregate ----
    print(f"\n===== TLA+ ARM: EXISTENTIAL vs FUNCTIONAL (task={args.task}, {nw} windows) =====")
    print(f"{'model':8s} {'exist pass':>11s} {'func pass':>10s} {'over_perm':>10s} {'max_bf':>7s}")
    for model in args.models:
        rows = [results[f"{model}|{g}"] for g in range(args.n)
                if f"{model}|{g}" in results and "existential_pass" in results[f"{model}|{g}"]]
        if not rows:
            continue
        ex = sum(r["existential_pass"] for r in rows)
        fn = sum(r["functional_pass"] for r in rows)
        op = sum(r["over_permissive"] for r in rows)
        mbf = max((r["max_bf"] for r in rows if r["max_bf"] is not None), default=None)
        tot = len(rows) * nw
        print(f"{model:8s} {ex:>5d}/{tot:<5d} {fn:>5d}/{tot:<5d} {op:>10d} {str(mbf):>7s}")
    total_op = sum(r.get("over_permissive", 0) for r in results.values() if "over_permissive" in r)
    print(f"\nTotal over-permissive windows (existential-only passes): {total_op}")
    print("If 0, the TLA+ arm's pass rate is unchanged under the functional check —")
    print("earned under the same strict relation the JS replay applies.")


if __name__ == "__main__":
    main()
