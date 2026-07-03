#!/usr/bin/env python3
"""Multi-round Phase-3 repair (review point 9: 'whether Haiku converges with
more rounds is untested').

Iterates the single-round repair loop: score the current spec on the 28-window
corpus, feed ALL failing windows back, ask for a full rewrite, re-score; stop at
28/28, at --max-rounds, or when two consecutive rounds make no progress. Every
round's spec is saved (output/repair_multiround/<model>_round<i>.js) and every
round is additionally scored on the held-out set and Phase 2 distinct states,
so a late 'success' can be audited the same way the single-round repairs were.

Usage:
    python scripts/repair_multiround.py [--models haiku] [--max-rounds 3]
Requires Docker + ANTHROPIC_API_KEY.
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
from tla_eval.languages import get
from repair_generalization import (  # reuse the audited machinery
    SEEN_WINDOWS, HELDOUT_WINDOWS, latest_spec, p3, p2_p4, build_repair_prompt,
)

backend = get("js-sam")
OUT_DIR = PROJECT_ROOT / "output" / "repair_multiround"
RESULTS_FILE = PROJECT_ROOT / "output" / "repair_multiround.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["haiku"])
    ap.add_argument("--max-rounds", type=int, default=3)
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results = json.loads(RESULTS_FILE.read_text(encoding="utf-8")) if RESULTS_FILE.exists() else {}

    for model in args.models:
        if model in results:
            continue
        spec_path = latest_spec(model)
        if not spec_path:
            print(f"[{model}] no baseline spec; skipping")
            continue
        rounds = []
        seen, failures = p3(spec_path, SEEN_WINDOWS, f"{model}_r0")
        print(f"[{model}] round 0 (baseline): {seen['passed']}/{seen['total']}", flush=True)
        rounds.append({"round": 0, "spec": str(spec_path.relative_to(PROJECT_ROOT)),
                       "p3_seen": seen})
        current = spec_path
        prev_passed = seen["passed"]
        stalls = 0

        for rnd in range(1, args.max_rounds + 1):
            if not failures:
                break
            resp = get_configured_model(model).generate_direct(
                build_repair_prompt(current.read_text(encoding="utf-8"), failures),
                GenerationConfig(top_p=None))
            if not resp.success:
                rounds.append({"round": rnd, "error": resp.error_message})
                print(f"[{model}] round {rnd}: generation failed", flush=True)
                break
            spec_text = backend.extract_artifacts(resp.generated_text).spec
            rp = OUT_DIR / f"{model}_round{rnd}.js"
            rp.write_text(spec_text, encoding="utf-8")
            seen, failures = p3(rp, SEEN_WINDOWS, f"{model}_r{rnd}")
            heldout, _ = p3(rp, HELDOUT_WINDOWS, f"{model}_r{rnd}h")
            p2, p4 = p2_p4(rp)
            rounds.append({"round": rnd, "spec": str(rp.relative_to(PROJECT_ROOT)),
                           "p3_seen": seen, "p3_heldout": heldout,
                           "p2_distinct": p2.get("distinct_states"), "p4": p4})
            print(f"[{model}] round {rnd}: {seen['passed']}/{seen['total']} "
                  f"heldout={heldout['passed']}/{heldout['total']} "
                  f"P2={p2.get('distinct_states')} states", flush=True)
            current = rp
            if seen["passed"] <= prev_passed:
                stalls += 1
                if stalls >= 2:
                    print(f"[{model}] no progress for 2 rounds; stopping", flush=True)
                    break
            else:
                stalls = 0
            prev_passed = seen["passed"]

        results[model] = {"rounds": rounds}
        RESULTS_FILE.write_text(json.dumps(results, indent=1), encoding="utf-8")

    print("\n===== MULTI-ROUND REPAIR =====")
    for model, entry in results.items():
        traj = " -> ".join(f"{r['p3_seen']['passed']}/28" for r in entry["rounds"] if "p3_seen" in r)
        print(f"{model:8s} {traj}")


if __name__ == "__main__":
    main()
