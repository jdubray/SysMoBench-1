#!/usr/bin/env python3
"""One-round TLA+ repair over the five Opus 5 `spin` Phase-2 runs.

Same protocol as `repair_tla_spin.py` (whose prompt, TLC invocation and
extraction are reused verbatim), applied to the N=5 Opus 5 sample instead of
the two Experiment-3 specs. Four of the five die on the unbounded CHOOSE
idiom; the fifth passes. All five are repaired, so the run measures repair
success on the failures AND regression on the already-passing spec — the
zero-regression question from Experiment 4.

Usage (project root, java on PATH, ANTHROPIC_API_KEY set):
    python scripts/repair_tla_spin_opus5.py
"""
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env", override=False)
except ImportError:
    pass

from scripts.repair_tla_spin import (  # noqa: E402
    build_prompt,
    run_tlc,
)
from tla_eval.config import get_configured_model  # noqa: E402
from tla_eval.models.base import GenerationConfig  # noqa: E402

MODEL = "opus5"
RUNS_DIR = PROJECT_ROOT / "output/runtime_check/tla/spin/direct_call_opus5"
OUT_DIR = PROJECT_ROOT / "output" / "tla_repair_opus5"
RESULTS_FILE = PROJECT_ROOT / "output" / "tla_repair_opus5.json"


def extract_tla(text):
    """Pull the repaired module out of a fenced response.

    `repair_tla_spin.extract_tla` takes the FIRST ```tla fence, which loses the
    module whenever the reply quotes the offending line in a fence of its own
    before emitting the rewrite. Prefer the block that actually contains the
    module header, then the longest block, then the raw text.
    """
    blocks = []
    for chunk in text.split("```")[1:]:
        body = chunk.split("```", 1)[0]
        if body.startswith("tla"):
            body = body[len("tla"):]
        body = body.strip()
        if body:
            blocks.append(body)

    module_blocks = [b for b in blocks if "MODULE spin" in b]
    if module_blocks:
        return max(module_blocks, key=len)
    if blocks:
        return max(blocks, key=len)
    return text.strip()


def main():
    only = set(sys.argv[1:])
    run_dirs = sorted(d for d in RUNS_DIR.iterdir() if (d / "spin.tla").exists())
    if only:
        run_dirs = [d for d in run_dirs if d.name in only]
    if not run_dirs:
        sys.exit(f"no runs with spin.tla under {RUNS_DIR}")

    model_obj = get_configured_model(MODEL)
    # Merge into any prior results so a filtered re-run updates one entry
    # instead of discarding the rest of the batch.
    results = {}
    if RESULTS_FILE.exists():
        results = json.loads(RESULTS_FILE.read_text(encoding="utf-8"))

    for spec_dir in run_dirs:
        run_id = spec_dir.name
        spec_text = (spec_dir / "spin.tla").read_text(encoding="utf-8")
        cfg_text = (spec_dir / "spin.cfg").read_text(encoding="utf-8")
        base_pass, base_states, base_out = run_tlc(spec_dir)
        # Feed the model the tail of TLC's output: the error block, not the
        # version banner.
        err_tail = "\n".join(base_out.splitlines()[-30:])

        # One empty/failed completion shouldn't abort the batch: record it and
        # move on, retrying once first (an empty body is transient here).
        prompt = build_prompt(spec_text, cfg_text, err_tail)
        resp = None
        for attempt in range(2):
            try:
                resp = model_obj.generate_direct(prompt, GenerationConfig(top_p=None))
                break
            except Exception as exc:  # noqa: BLE001 - recorded, not swallowed
                print(f"{run_id}: attempt {attempt + 1} raised {exc}")
                last_exc = exc
        if resp is None:
            results[run_id] = {"error": str(last_exc)}
            continue
        if not resp.success:
            results[run_id] = {"error": resp.error_message}
            print(f"{run_id}: generation failed - {resp.error_message}")
            continue

        repaired = extract_tla(resp.generated_text or "")
        rdir = OUT_DIR / run_id
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / "spin.tla").write_text(repaired + "\n", encoding="utf-8")
        (rdir / "spin.cfg").write_text(cfg_text, encoding="utf-8")
        rep_pass, rep_states, rep_out = run_tlc(rdir)
        (rdir / "tlc_output.txt").write_text(rep_out, encoding="utf-8")

        results[run_id] = {
            "baseline_p2": base_pass,
            "baseline_distinct_states": base_states,
            "repaired_p2": rep_pass,
            "repaired_distinct_states": rep_states,
            "still_has_unbounded_choose": "unbounded CHOOSE" in rep_out,
            "regressed": bool(base_pass and not rep_pass),
        }
        print(
            f"{run_id}: P2 {base_pass} -> {rep_pass} "
            f"(distinct states: {base_states} -> {rep_states})"
        )

    RESULTS_FILE.write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"raw: {RESULTS_FILE}  specs: {OUT_DIR}")


if __name__ == "__main__":
    main()
