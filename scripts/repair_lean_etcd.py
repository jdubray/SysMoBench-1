#!/usr/bin/env python3
"""One-round repair experiment for the etcd lean-contract study.

Mirrors the Experiment-2 methodology on the lean {init, next} contract: for
every saved generation in output/lean_specs_etcd that failed any phase, build
a repair prompt containing the full original module plus the evaluator's own
feedback — every failing Phase-3 window (pre, action, data, expected post,
the module's actual output) and every Phase-4 invariant violation (predicate
source + violating state) — ask the same model for a rewrite, and re-score
the repaired module across all phases.

Usage (project root, Docker available, ANTHROPIC_API_KEY set):
    python scripts/repair_lean_etcd.py [model ...]
"""
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

from lean_full_pipeline_study import evaluate  # noqa: E402
from lean_task_config import TASKS  # noqa: E402
from plain_js_tv import _run_script, plain_js_explore  # noqa: E402
from tla_eval.config import get_configured_model  # noqa: E402
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows  # noqa: E402
from tla_eval.models.base import GenerationConfig  # noqa: E402

TASK = "etcd"
MODELS = sys.argv[1:] or ["haiku", "sonnet", "claude", "fable"]
SPECS_DIR = PROJECT_ROOT / "output" / f"lean_specs_{TASK}"
OUT_DIR = PROJECT_ROOT / "output" / f"lean_specs_{TASK}_repaired"
RESULTS_FILE = PROJECT_ROOT / "output" / f"lean_etcd_repair.json"


def tv_detail(spec_path, windows):
    """Per-window results including the module's actual output on failures."""
    extra = {
        "windows": [
            {
                "action": a["name"],
                "data": a.get("data", {}),
                "preState": pre,
                "postState": post,
            }
            for a, pre, post in windows
        ]
    }
    resp = _run_script("tv.mjs", Path(spec_path), extra, 180)
    if not resp or not resp.get("ok"):
        return None
    return resp["results"]


def build_prompt(spec_text, window_failures, inv_failures, cfg):
    parts = [
        "You wrote this plain-JavaScript transition-function specification of the",
        "etcd/raft 3-node cluster (module contract: `module.exports = { init, next }`;",
        "`next(state, action, data)` is pure and returns the complete new cluster",
        "state):",
        "",
        "```javascript",
        spec_text,
        "```",
        "",
    ]
    if window_failures:
        parts += [
            "The harness replayed real execution traces of the system: it pins a",
            "captured pre-state, calls `next(pre, action, data)` once, and",
            "deep-compares the result to the captured post-state. Your module was",
            "wrong on the following windows:",
            "",
        ]
        for f in window_failures:
            parts.append(
                f"- action={f['action']} data={json.dumps(f['data'])}\n"
                f"  pre:  {json.dumps(f['pre'])}\n"
                f"  real system's post: {json.dumps(f['post'])}\n"
                f"  your module returned: {json.dumps(f['got'])}"
            )
        parts.append("")
    if inv_failures:
        parts += [
            "Bounded exploration of your module (actions drawn from the declared",
            "input domains) also violated these safety invariants:",
            "",
        ]
        for name, state in inv_failures:
            pred = next(
                (i["predicate"] for i in cfg["invariants"] if i["name"] == name), "?"
            )
            parts.append(
                f"- {name}: `{pred}`\n  violated at reachable state: {state}"
            )
        parts.append("")
    parts += [
        "Rewrite the ENTIRE module so that every failing window above now produces",
        "the real system's post-state and every invariant holds over all reachable",
        "states, while preserving all behavior that was already correct. Keep the",
        "exact same module contract, state shape, and action/data schemas. Output",
        "only the corrected module in a single ```javascript code fence.",
    ]
    return "\n".join(parts)


def extract_js(text):
    if "```javascript" in text:
        return text.split("```javascript", 1)[1].split("```", 1)[0].strip()
    if "```js" in text:
        return text.split("```js", 1)[1].split("```", 1)[0].strip()
    if "```" in text:
        return text.split("```", 1)[1].split("```", 1)[0].strip()
    return text.strip()


def main():
    cfg = TASKS[TASK]
    windows = load_trace_windows(TASK)
    nw = len(windows)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results = (
        json.loads(RESULTS_FILE.read_text(encoding="utf-8"))
        if RESULTS_FILE.exists()
        else {}
    )
    baseline = json.loads(
        (PROJECT_ROOT / "output" / f"lean_full_pipeline_{TASK}.json").read_text(
            encoding="utf-8"
        )
    )

    for model in MODELS:
        model_obj = None
        for gen in range(5):
            key = f"{model}|{gen}"
            if key in results:
                continue
            base = baseline.get(key, {})
            if base.get("all_phases"):
                results[key] = {"skipped": "baseline already passes all phases"}
                continue
            spec_path = SPECS_DIR / f"{model}_{gen}.js"
            spec_text = spec_path.read_text(encoding="utf-8")

            detail = tv_detail(spec_path, windows)
            window_failures = []
            if detail:
                for i, r in enumerate(detail):
                    if r["status"] != "pass":
                        a, pre, post = windows[i]
                        window_failures.append(
                            {
                                "action": a["name"],
                                "data": a.get("data", {}),
                                "pre": pre,
                                "post": post,
                                "got": r.get("got"),
                            }
                        )
            rep = plain_js_explore(
                spec_path, cfg["actions"], cfg["invariants"], depth_max=8
            )
            inv_failures = sorted((rep.get("invariantViolations") or {}).items())

            prompt = build_prompt(spec_text, window_failures, inv_failures, cfg)
            if model_obj is None:
                model_obj = get_configured_model(model)
            resp = model_obj.generate_direct(prompt, GenerationConfig(top_p=None))
            if not resp.success:
                results[key] = {"error": resp.error_message}
                RESULTS_FILE.write_text(
                    json.dumps(results, indent=1), encoding="utf-8"
                )
                print(f"{key}: generation FAILED: {resp.error_message}")
                continue
            repaired = extract_js(resp.generated_text or "")
            rpath = OUT_DIR / f"{model}_{gen}.js"
            rpath.write_text(repaired + "\n", encoding="utf-8")

            r = evaluate(rpath, cfg, windows, nw)
            results[key] = {
                "baseline_p3": f"{base.get('p3_pass')}/{base.get('p3_total')}",
                "baseline_p4_violations": base.get("p4_violations"),
                "fed_windows": len(window_failures),
                "fed_invariants": [n for n, _ in inv_failures],
                **{f"repaired_{k}": v for k, v in r.items()},
            }
            RESULTS_FILE.write_text(json.dumps(results, indent=1), encoding="utf-8")
            print(
                f"{key}: P3 {results[key]['baseline_p3']} -> "
                f"{r['p3_pass']}/{r['p3_total']}  "
                f"P4 {base.get('p4_violations')} -> {r['p4_violations']}  "
                f"ALL={r['all_phases']}"
            )

    print(f"\n===== ONE-ROUND REPAIR — task={TASK} =====")
    print(f"{'model':<9} {'repaired ALL-pass':<18} {'P3=97/97':<9} {'P4 hold'}")
    for model in MODELS:
        cells = [results.get(f"{model}|{g}", {}) for g in range(5)]
        allp = sum(1 for c in cells if c.get("repaired_all_phases"))
        p3 = sum(1 for c in cells if c.get("repaired_p3_ok"))
        p4 = sum(1 for c in cells if c.get("repaired_p4_ok"))
        print(f"{model:<9} {allp}/5{'':<15} {p3}/5{'':<6} {p4}/5")
    print(f"raw: {RESULTS_FILE}  specs: {OUT_DIR}")


if __name__ == "__main__":
    main()
