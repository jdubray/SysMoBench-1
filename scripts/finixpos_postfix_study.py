#!/usr/bin/env python3
"""Post-fix validation arms: lean-contract generations over the PATCHED
finixpos source, scored on the post-fix corpus (data/sys_traces/finixpos_fixed).

Review-response companion to scripts/finixpos_phase3_study.py — N=5 lean
generations for fable and claude only (the two ceiling models), derivation
mode. Reuses the prompt-cache monkeypatch and back-to-back generation
ordering.

Usage:
    python scripts/finixpos_postfix_study.py [--n 5] [--models fable claude]
Resumable — results persist to output/finixpos_postfix_study.json.
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

# Prompt caching, same monkeypatch as finixpos_phase3_study.py
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

TRACES_DIR = PROJECT_ROOT / "data" / "sys_traces" / "finixpos_fixed"
WINDOWS = load_windows(TRACES_DIR)
NW = len(WINDOWS)
TASK_DIR = PROJECT_ROOT / "tla_eval" / "tasks" / "finixpos"
SOURCE_FILE = TASK_DIR / "source" / "source_packet_fixed.ts"
PROMPT_FILE = TASK_DIR / "prompts" / "plain-js" / "direct_call_nosemantics_fixed.txt"
RESULTS_FILE = PROJECT_ROOT / "output" / "finixpos_postfix_study.json"
SPECS_DIR = PROJECT_ROOT / "output" / "finixpos_postfix_specs"


def _extract_js(text: str) -> str:
    m = re.search(r"```(?:javascript|js)\b\s*\n(.*?)\n```", text, re.DOTALL)
    return m.group(1) if m else text


def _score(spec_text: str):
    with tempfile.TemporaryDirectory() as d:
        sp = Path(d) / "finixpos.js"
        sp.write_text(spec_text, encoding="utf-8")
        try:
            return replay(sp, "lean", WINDOWS)
        except Exception as e:  # noqa: BLE001
            print(f"    replay error: {e}", flush=True)
            return ["unscoreable"] * NW


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--models", nargs="+", default=["fable", "claude"])
    args = ap.parse_args()

    prompt = PROMPT_FILE.read_text(encoding="utf-8") \
        .replace("{source_code}", SOURCE_FILE.read_text(encoding="utf-8")) \
        .replace("{file_path}", "Merchant/v2/src/workflows/terminal-payment.ts (gap-fix patch applied)")

    SPECS_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(RESULTS_FILE.read_text(encoding="utf-8")) if RESULTS_FILE.exists() else {}

    # Phase 1: generate back-to-back per model (cache hits)
    for model in args.models:
        for gen in range(args.n):
            key = f"{model}|lean|{gen}"
            if key in results:
                continue
            resp = get_configured_model(model).generate_direct(prompt, GenerationConfig(top_p=None))
            if not resp.success:
                results[key] = {"statuses": ["unscoreable"] * NW, "error": resp.error_message}
            else:
                spec_file = SPECS_DIR / f"{model}_lean_{gen}.js"
                spec_file.write_text(_extract_js(resp.generated_text), encoding="utf-8")
                results[key] = {"spec_file": str(spec_file.relative_to(PROJECT_ROOT))}
            RESULTS_FILE.write_text(json.dumps(results, indent=0), encoding="utf-8")
            print(f"{key}: generated", flush=True)

    # Phase 2: score
    for key, cell in results.items():
        if "statuses" in cell or "error" in cell:
            continue
        spec_text = (PROJECT_ROOT / cell["spec_file"]).read_text(encoding="utf-8")
        cell["statuses"] = _score(spec_text)
        RESULTS_FILE.write_text(json.dumps(results, indent=0), encoding="utf-8")
        st = cell["statuses"]
        print(f"{key}: pass={st.count('pass')}/{NW} fail={st.count('fail')} "
              f"unscoreable={st.count('unscoreable')}", flush=True)

    print(f"\n=== finixpos post-fix lean arms (N={args.n}, {NW} windows) ===")
    for model in args.models:
        counts = []
        for gen in range(args.n):
            s = results.get(f"{model}|lean|{gen}", {}).get("statuses")
            counts.append(str(s.count("pass")) if s else "—")
        print(f"{model:8s} lean: {', '.join(counts)} / {NW}")


if __name__ == "__main__":
    main()
