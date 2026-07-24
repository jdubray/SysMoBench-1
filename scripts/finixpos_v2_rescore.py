#!/usr/bin/env python3
"""Rescore specs on the finixpos corpus v2 (data/sys_traces/finixpos_v2).

Usage:
    python scripts/finixpos_v2_rescore.py --arms lean sam        # JS specs
    python scripts/finixpos_v2_rescore.py --arms tla             # TLA+ specs
    python scripts/finixpos_v2_rescore.py --controls-tla         # TLA reference + mutations

Merges into output/finixpos_v2_rescore.json ({key: {statuses, spec_file}}).
"""
import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from finixpos_tv import load_windows, replay

TRACES_V2 = PROJECT_ROOT / "data" / "sys_traces" / "finixpos_v2"
SPECS_DIR = PROJECT_ROOT / "output" / "finixpos_study_specs"
REF_DIR = PROJECT_ROOT / "tla_eval" / "tasks" / "finixpos" / "reference"
OUT = PROJECT_ROOT / "output" / "finixpos_v2_rescore.json"

WINDOWS = load_windows(TRACES_V2)


def score(path: Path, arm: str):
    try:
        return replay(path, arm, WINDOWS)
    except Exception as e:  # noqa: BLE001
        print(f"  replay error ({arm}, {path.name}): {e}", flush=True)
        return ["unscoreable"] * len(WINDOWS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", nargs="*", default=[])
    ap.add_argument("--controls-tla", action="store_true")
    args = ap.parse_args()

    results = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}

    jobs = []
    for arm in args.arms:
        ext = ".tla" if arm == "tla" else ".js"
        for f in sorted(SPECS_DIR.glob(f"*_{arm}_*{ext}")):
            jobs.append((f.stem, f, arm))
    if args.controls_tla:
        jobs.append(("ref_tla", REF_DIR / "reference_finixpos.tla", "tla"))
        jobs.append(("tla_m1", REF_DIR / "mutations" / "tla_m1_no_cancel_rewrite.tla", "tla"))
        jobs.append(("tla_m2", REF_DIR / "mutations" / "tla_m2_no_partial_guard.tla", "tla"))

    for key, path, arm in jobs:
        if key in results:
            continue
        st = score(path, arm)
        results[key] = {"statuses": st, "spec_file": str(path.relative_to(PROJECT_ROOT))}
        OUT.write_text(json.dumps(results, indent=0), encoding="utf-8")
        bad = [
            (i, st[i], f"{WINDOWS[i].get('file','?')}[{WINDOWS[i].get('index','?')}]")
            for i in range(len(st)) if st[i] != "pass"
        ]
        print(f"{key}: pass={st.count('pass')}/{len(st)} "
              f"fail={st.count('fail')} unscoreable={st.count('unscoreable')}", flush=True)
        for i, s, w in bad:
            print(f"    {s}: [{i}] {w} {WINDOWS[i]['pre']['txState']} + {WINDOWS[i]['action']}", flush=True)


if __name__ == "__main__":
    main()
