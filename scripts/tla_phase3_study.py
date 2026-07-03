#!/usr/bin/env python3
"""Paired JS-SAM vs. TLA+ Phase-3 study on `spin` (see docs/js_sam_tla_phase3_plan.md).

N generations per model per language over the same 28-window kernel corpus,
each scored per-window under a comparable direct replay (JS-SAM: setState/action/
diff; TLA+: constrained spec + direct TLC replay). Paired by (model, window):
reports per-language conditional/unconditional pass rates and a per-model McNemar
test over windows. Resumable — partial results persist to output/tla_phase3_study.json.

Usage:
    python scripts/tla_phase3_study.py [--n 5] [--models claude fable sonnet haiku]
Requires Docker (JS-SAM sandbox), Java (TLC), and ANTHROPIC_API_KEY.
"""
import argparse
import json
import re
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

from tla_eval.config import get_configured_model
from tla_eval.models.base import GenerationConfig
from tla_eval.tasks.loader import get_task_loader
from tla_eval.languages import get as get_backend
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows
from tla_direct_tv import functional_tv
from plain_js_tv import plain_js_tv

WINDOWS = load_trace_windows("spin")
NW = len(WINDOWS)
JSB = get_backend("js-sam")
RESULTS_FILE = PROJECT_ROOT / "output" / "tla_phase3_study.json"


def _fill(tpl: str, src: str) -> str:
    return tpl.replace("{source_code}", src).replace("{file_path}", "ostd/src/sync/spin.rs")


def _extract_tla(text: str) -> str:
    m = re.search(r"```tla\b\s*\n(.*?)\n```", text, re.DOTALL)
    return m.group(1) if m else text


def score_js(spec_text: str):
    """Per-window ['pass'|'fail'|'unscoreable'] for a JS-SAM spec."""
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        sp = dp / "spin.js"
        sp.write_text(spec_text, encoding="utf-8")
        syn = JSB.validate_syntax(spec_text, None, dp / "p1", timeout=120, spec_filename="spin.js")
        if not syn.success:
            return ["unscoreable"] * NW
        out = JSB.validate_transitions(sp, WINDOWS, dp / "p3", timeout=180)
        if (out.total_windows or 0) == 0:
            return ["unscoreable"] * NW
        failed = set()
        fpath = dp / "p3" / "transition_failures.json"
        if fpath.exists():
            for e in json.loads(fpath.read_text(encoding="utf-8")):
                failed.add(e["window"])
        return ["fail" if i in failed else "pass" for i in range(NW)]


def score_tla(spec_text: str):
    # Functional check (branching factor 1) so the TLA+ arm is scored under the
    # same strict relation as the JS replay: an over-permissive window (post
    # reachable but branching factor > 1) counts as a fail, not a pass. See
    # scripts/tla_functional_audit.py — for the constrained prompt every generated
    # spec is deterministic (bf=1), so this equals the existential score in practice.
    with tempfile.TemporaryDirectory() as d:
        sp = Path(d) / "spin.tla"
        sp.write_text(spec_text, encoding="utf-8")
        out = []
        for _name, status, _bf in functional_tv(sp, WINDOWS, timeout=60):
            out.append("fail" if status == "over_permissive" else status)
        return out


def score_pjs(spec_text: str):
    with tempfile.TemporaryDirectory() as d:
        sp = Path(d) / "spin.js"
        sp.write_text(spec_text, encoding="utf-8")
        return plain_js_tv(sp, WINDOWS, timeout=120)


def mcnemar(js, tla):
    """(b, c, note) over paired unconditional outcomes (pass vs not-pass)."""
    b = sum(1 for j, t in zip(js, tla) if j == "pass" and t != "pass")  # JS only
    c = sum(1 for j, t in zip(js, tla) if j != "pass" and t == "pass")  # TLA only
    n = b + c
    stat = ((abs(b - c) - 1) ** 2) / n if n > 0 else 0.0  # continuity-corrected chi2 (df=1)
    return b, c, stat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--models", nargs="+", default=["claude", "fable", "sonnet", "haiku"])
    args = ap.parse_args()

    task = get_task_loader().load_task("spin")
    src = task.source_code
    js_prompt = _fill((PROJECT_ROOT / "tla_eval/tasks/spin/prompts/js-sam/direct_call.txt").read_text(encoding="utf-8"), src)
    jsc_prompt = _fill((PROJECT_ROOT / "tla_eval/tasks/spin/prompts/js-sam/direct_call_constrained.txt").read_text(encoding="utf-8"), src)
    pjs_prompt = _fill((PROJECT_ROOT / "tla_eval/tasks/spin/prompts/plain-js/direct_call.txt").read_text(encoding="utf-8"), src)
    tla_prompt = _fill((PROJECT_ROOT / "tla_eval/tasks/spin/prompts/direct_call_constrained.txt").read_text(encoding="utf-8"), src)

    RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(RESULTS_FILE.read_text(encoding="utf-8")) if RESULTS_FILE.exists() else {}

    # js  = deployed JS-SAM prompt (does NOT state the single-step semantics)
    # jsc = constrained JS-SAM prompt (same semantics block as the TLA arm)
    # pjs = plain-JS next(state,action,data) — no SAM, two keys — isomorphic to the TLA relation
    # tla = constrained TLA+ prompt
    _js_extract = lambda t: JSB.extract_artifacts(t).spec
    arms = [("js", js_prompt, score_js, _js_extract),
            ("jsc", jsc_prompt, score_js, _js_extract),
            ("pjs", pjs_prompt, score_pjs, _js_extract),
            ("tla", tla_prompt, score_tla, _extract_tla)]

    for model in args.models:
        for gen in range(args.n):
            for lang, prompt, scorer, extract in arms:
                key = f"{model}|{lang}|{gen}"
                if key in results:
                    continue
                resp = get_configured_model(model).generate_direct(prompt, GenerationConfig(top_p=None))
                if not resp.success:
                    results[key] = {"statuses": ["unscoreable"] * NW, "error": resp.error_message}
                else:
                    results[key] = {"statuses": scorer(extract(resp.generated_text))}
                RESULTS_FILE.write_text(json.dumps(results, indent=0), encoding="utf-8")
                st = results[key]["statuses"]
                print(f"{key}: pass={st.count('pass')}/{NW} fail={st.count('fail')} unscoreable={st.count('unscoreable')}", flush=True)

    # ---- Aggregate ----
    def cond(xs):
        sc = [x for x in xs if x in ("pass", "fail")]
        return 100 * sum(x == "pass" for x in sc) / len(sc) if sc else 0.0
    def uncond(xs):
        return 100 * sum(x == "pass" for x in xs) / len(xs) if xs else 0.0
    def gather(model, lang):
        acc = []
        for gen in range(args.n):
            s = results.get(f"{model}|{lang}|{gen}", {}).get("statuses")
            if s:
                acc.append(s)
        return acc

    print("\n===== PASS RATES (mean over N generations) =====")
    print(f"{'model':8s} {'JS(depl)':>9s} {'JS(constr)':>11s} {'plainJS':>8s} {'TLA(constr)':>12s}")
    for model in args.models:
        row = []
        for lang in ("js", "jsc", "pjs", "tla"):
            flat = [x for s in gather(model, lang) for x in s]
            row.append(f"{uncond(flat):.1f}%" if flat else "n/a")
        print(f"{model:8s} {row[0]:>9s} {row[1]:>11s} {row[2]:>8s} {row[3]:>12s}")

    print("\n===== DESCRIPTIVE window discordance (b=first-only pass, c=TLA-only pass) =====")
    print("JS(constr) vs TLA isolates the language; plainJS vs TLA isolates SAM's machinery.")
    print(f"{'model':8s} {'JS(constr) vs TLA':>20s} {'plainJS vs TLA':>18s}")
    for model in args.models:
        def flat(lang):
            return [x for s in gather(model, lang) for x in s]
        def cell(a, b_lang):
            xa, xb = flat(a), flat(b_lang)
            if not xa or not xb or len(xa) != len(xb):
                return "n/a"
            bb, cc, _st = mcnemar(xa, xb)
            return f"b={bb} c={cc}"
        print(f"{model:8s} {cell('jsc','tla'):>20s} {cell('pjs','tla'):>18s}")
    print(
        "\nNOTE: b/c are DESCRIPTIVE only. Pooling windows across generations is"
        "\npseudo-replicated (generations collapse to 1-2 unique behavioral"
        "\nfingerprints per arm), so no chi-square is reported here. For inference"
        "\nrun scripts/tla_phase3_analysis.py: uniqueness per arm + an exact"
        "\ngeneration-level permutation test."
    )


if __name__ == "__main__":
    main()
