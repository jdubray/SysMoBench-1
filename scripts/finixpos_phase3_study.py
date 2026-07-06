#!/usr/bin/env python3
"""Paired JS-SAM vs lean-JS vs TLA+ Phase-3 study on `finixpos`.

Mirrors scripts/tla_phase3_study.py (spin) on the finixpos payment-alignment
corpus (75 windows, 17 real-execution scenarios). Three derivation-mode arms
(no semantics block anywhere — the model derives single-step semantics from
the TypeScript source):

    sam  = JS-SAM module contract   (tasks/finixpos/prompts/js-sam/direct_call.txt)
    lean = plain {init,next} module (tasks/finixpos/prompts/plain-js/direct_call_nosemantics.txt)
    tla  = constrained TLA+         (tasks/finixpos/prompts/direct_call_constrained_nosemantics.txt)

Replay: scripts/finixpos_tv.py (validated by positive/negative controls —
see tla_eval/tasks/finixpos/reference/CONTROLS.md).

Usage:
    python scripts/finixpos_phase3_study.py [--n 5] [--models claude fable sonnet haiku]
Requires Node >= 20, Java (TLC; auto-resolved), and ANTHROPIC_API_KEY (.env).
Resumable — partial results persist to output/finixpos_phase3_study.json.
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
from tla_eval.models.litellm_adapter import LiteLLMAdapter
from finixpos_tv import load_windows, replay

# ── Prompt caching (Anthropic) ─────────────────────────────────────────────
# The ~30k-token source packet is identical across the N generations of each
# (model, arm) cell. Mark the user turn with cache_control so consecutive
# same-prompt calls hit the prompt cache (5-min TTL — which is why main()
# groups generation calls back-to-back per (model, arm) and defers scoring).
_orig_build = LiteLLMAdapter._build_completion_params


def _cached_build(self, prompt, generation_config=None):
    params = _orig_build(self, prompt, generation_config)
    if "claude" in str(params.get("model", "")):
        params["messages"] = [{
            "role": "user",
            "content": [{"type": "text", "text": prompt,
                         "cache_control": {"type": "ephemeral"}}],
        }]
    return params


LiteLLMAdapter._build_completion_params = _cached_build

WINDOWS = load_windows()
NW = len(WINDOWS)
TASK_DIR = PROJECT_ROOT / "tla_eval" / "tasks" / "finixpos"
SOURCE_FILE = TASK_DIR / "source" / "source_packet.ts"
RESULTS_FILE = PROJECT_ROOT / "output" / "finixpos_phase3_study.json"
SPECS_DIR = PROJECT_ROOT / "output" / "finixpos_study_specs"


def _fill(tpl: str) -> str:
    src = SOURCE_FILE.read_text(encoding="utf-8")
    return tpl.replace("{source_code}", src).replace(
        "{file_path}", "Merchant/v2/src/workflows/terminal-payment.ts"
    )


def _extract_js(text: str) -> str:
    m = re.search(r"```(?:javascript|js)\b\s*\n(.*?)\n```", text, re.DOTALL)
    return m.group(1) if m else text


def _extract_tla(text: str) -> str:
    m = re.search(r"```tla\b\s*\n(.*?)\n```", text, re.DOTALL)
    return m.group(1) if m else text


def _score(spec_text: str, arm: str, ext: str):
    with tempfile.TemporaryDirectory() as d:
        sp = Path(d) / f"finixpos{ext}"
        sp.write_text(spec_text, encoding="utf-8")
        try:
            return replay(sp, arm, WINDOWS)
        except Exception as e:  # noqa: BLE001 — any replay crash = unscoreable spec
            print(f"    replay error ({arm}): {e}", flush=True)
            return ["unscoreable"] * NW


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--models", nargs="+", default=["claude", "fable", "sonnet", "haiku"])
    args = ap.parse_args()

    prompts = {
        "sam": _fill((TASK_DIR / "prompts/js-sam/direct_call.txt").read_text(encoding="utf-8")),
        "lean": _fill((TASK_DIR / "prompts/plain-js/direct_call_nosemantics.txt").read_text(encoding="utf-8")),
        "tla": _fill((TASK_DIR / "prompts/direct_call_constrained_nosemantics.txt").read_text(encoding="utf-8")),
    }
    arms = [("sam", _extract_js, ".js"), ("lean", _extract_js, ".js"), ("tla", _extract_tla, ".tla")]

    SPECS_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(RESULTS_FILE.read_text(encoding="utf-8")) if RESULTS_FILE.exists() else {}

    # ── Phase 1: generation, grouped (model, arm)-major so the N identical
    # prompts run back-to-back inside the prompt-cache TTL. Scoring (phase 2)
    # is deferred — a 7-minute TLC replay between calls would evict the cache.
    for model in args.models:
        for arm, extract, ext in arms:
            for gen in range(args.n):
                key = f"{model}|{arm}|{gen}"
                if key in results and ("statuses" in results[key] or "error" in results[key]):
                    continue
                if key in results and "spec_file" in results[key]:
                    continue  # generated earlier, scoring pending
                resp = get_configured_model(model).generate_direct(prompts[arm], GenerationConfig(top_p=None))
                if not resp.success:
                    results[key] = {"statuses": ["unscoreable"] * NW, "error": resp.error_message}
                else:
                    spec_text = extract(resp.generated_text)
                    spec_file = SPECS_DIR / f"{model}_{arm}_{gen}{ext}"
                    spec_file.write_text(spec_text, encoding="utf-8")
                    results[key] = {"spec_file": str(spec_file.relative_to(PROJECT_ROOT))}
                RESULTS_FILE.write_text(json.dumps(results, indent=0), encoding="utf-8")
                print(f"{key}: generated", flush=True)

    # ── Phase 2: score every cell that has a spec but no statuses ──────────
    arm_ext = {arm: (extract, ext) for arm, extract, ext in arms}
    for key, cell in results.items():
        if "statuses" in cell or "error" in cell:
            continue
        model, arm, gen = key.split("|")
        spec_text = (PROJECT_ROOT / cell["spec_file"]).read_text(encoding="utf-8")
        cell["statuses"] = _score(spec_text, arm, arm_ext[arm][1])
        RESULTS_FILE.write_text(json.dumps(results, indent=0), encoding="utf-8")
        st = cell["statuses"]
        print(
            f"{key}: pass={st.count('pass')}/{NW} fail={st.count('fail')} "
            f"unscoreable={st.count('unscoreable')}",
            flush=True,
        )

    # ---- Aggregate ----
    def gather(model, arm):
        out = []
        for gen in range(args.n):
            s = results.get(f"{model}|{arm}|{gen}", {}).get("statuses")
            if s:
                out.append(s)
        return out

    def uncond(xs):
        return 100 * sum(x == "pass" for x in xs) / len(xs) if xs else 0.0

    def cond(xs):
        sc = [x for x in xs if x in ("pass", "fail")]
        return 100 * sum(x == "pass" for x in sc) / len(sc) if sc else 0.0

    print(f"\n=== finixpos Phase-3 (N={args.n}, {NW} windows) — unconditional (conditional) ===")
    print(f"{'model':8s} {'SAM':>18s} {'lean':>18s} {'TLA+':>18s}")
    for model in args.models:
        row = []
        for arm, _, _ in arms:
            flat = [x for s in gather(model, arm) for x in s]
            row.append(f"{uncond(flat):5.1f}% ({cond(flat):5.1f}%)")
        print(f"{model:8s} {row[0]:>18s} {row[1]:>18s} {row[2]:>18s}")


if __name__ == "__main__":
    main()
