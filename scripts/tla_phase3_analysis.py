#!/usr/bin/env python3
"""Generation-level analysis of the paired Phase-3 study (review point 4).

The study's original McNemar pooled windows across 5 generations per arm,
treating 140 outcomes as independent. That is pseudo-replication: generations
collapse to 1-2 unique behavioral fingerprints per (model, arm) — the same
underlying bug counted five times — so the pooled chi-square values were
inflated. This script re-analyzes output/tla_phase3_study.json at the correct
units:

  1. Uniqueness — for EVERY arm: unique per-window outcome vectors
     ("behavioral fingerprints") among the 5 generations. Two generations with
     identical fingerprints are the same evidence, whatever their text. (Where
     regenerated spec texts were saved — plain-JS lean, TLA audit — text-level
     uniqueness is reported alongside as corroboration.)
  2. Generation-level exact permutation test — unit = generation, statistic =
     difference in mean per-generation pass rate, all C(10,5)=252 relabelings,
     two-sided. No independence assumption over windows.
  3. Unique-solution-level view — pass rates over distinct fingerprints, with
     the honest note that n=1-2 per cell supports description, not inference.

Usage:
    python scripts/tla_phase3_analysis.py
Reads output/tla_phase3_study.json (committed with the study).
"""
import json
import sys
from collections import defaultdict
from itertools import combinations
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RESULTS_FILE = PROJECT_ROOT / "output" / "tla_phase3_study.json"

MODELS = ["claude", "fable", "sonnet", "haiku"]
# 2x2 factorial in (contract, prompt) + the TLA+ reference arm:
#   js  = SAM  contract, no semantics block     jsc = SAM  contract, semantics block
#   pjd = lean contract, no semantics block     pjs = lean contract, semantics block
ARMS = ["js", "jsc", "pjd", "pjs", "tla"]
NW = 28


def load():
    d = json.loads(RESULTS_FILE.read_text(encoding="utf-8"))
    cells = defaultdict(dict)  # (model, arm) -> {gen: statuses tuple}
    for k, v in d.items():
        m, a, g = k.split("|")
        cells[(m, a)][int(g)] = tuple(v["statuses"])
    return cells


def perm_test(xs, ys):
    """Exact two-sided permutation test on difference of means (5 vs 5)."""
    pooled = list(xs) + list(ys)
    n = len(xs)
    observed = abs(sum(xs) / len(xs) - sum(ys) / len(ys))
    count = 0
    total = 0
    idx = range(len(pooled))
    for combo in combinations(idx, n):
        a = [pooled[i] for i in combo]
        b = [pooled[i] for i in idx if i not in combo]
        diff = abs(sum(a) / len(a) - sum(b) / len(b))
        if diff >= observed - 1e-12:
            count += 1
        total += 1
    return observed, count / total


def text_uniqueness(glob_dir):
    """Unique spec texts among saved generations (where artifacts exist)."""
    import hashlib
    files = sorted(Path(glob_dir).glob("*"))
    by_model = defaultdict(set)
    for f in files:
        if f.suffix not in (".js", ".tla"):
            continue
        model = f.stem.split("_")[0]
        by_model[model].add(hashlib.md5(f.read_bytes()).hexdigest())
    return {m: len(s) for m, s in sorted(by_model.items())}


def main():
    cells = load()

    print("===== 1. UNIQUENESS (behavioral fingerprints per (model, arm), N=5 gens) =====")
    print(f"{'model':8s}" + "".join(f"{a:>8s}" for a in ARMS))
    for m in MODELS:
        row = []
        for a in ARMS:
            fps = list(cells[(m, a)].values())
            row.append(f"{len(set(fps))}/{len(fps)}")
        print(f"{m:8s}" + "".join(f"{r:>8s}" for r in row))
    print("\nText-level uniqueness of saved regenerated sets (corroboration; separate")
    print("generations from the study, same prompts):")
    for label, d in (("plain-JS (lean study, spin)", PROJECT_ROOT / "output/lean_specs"),
                     ("plain-JS (lean study, locksvc)", PROJECT_ROOT / "output/lean_specs_locksvc"),
                     ("TLA+ (functional audit)", PROJECT_ROOT / "output/tla_specs")):
        if d.exists():
            print(f"  {label}: {text_uniqueness(d)}")

    print("\n===== 2. PER-GENERATION PASS RATES (out of 28) =====")
    print(f"{'model':8s}" + "".join(f"{a:>22s}" for a in ARMS))
    for m in MODELS:
        row = []
        for a in ARMS:
            gens = cells[(m, a)]
            passes = [sum(1 for s in gens[g] if s == "pass") for g in sorted(gens)]
            row.append(str(passes))
        print(f"{m:8s}" + "".join(f"{r:>22s}" for r in row))

    print("\n===== 3. GENERATION-LEVEL EXACT PERMUTATION TEST (unit = generation, =====")
    print("=====    diff in mean pass rate, all C(10,5)=252 splits, two-sided)  =====")
    print("vs TLA reference, then the four factorial contrasts:")
    print("  prompt effect  | SAM:  js vs jsc    lean: pjd vs pjs")
    print("  contract effect| none: js vs pjd    sem:  jsc vs pjs")
    print(f"{'model':8s} {'comparison':>16s} {'mean diff':>10s} {'p (exact)':>10s}")
    comparisons = (
        ("jsc", "tla"), ("pjs", "tla"), ("pjd", "tla"), ("js", "tla"),
        ("js", "jsc"),   # prompt effect within SAM
        ("pjd", "pjs"),  # prompt effect within lean
        ("js", "pjd"),   # contract effect without semantics
        ("jsc", "pjs"),  # contract effect with semantics
    )
    for m in MODELS:
        for a, b in comparisons:
            if (m, a) not in cells or (m, b) not in cells:
                continue
            xs = [sum(1 for s in fp if s == "pass") / NW for fp in cells[(m, a)].values()]
            ys = [sum(1 for s in fp if s == "pass") / NW for fp in cells[(m, b)].values()]
            diff, p = perm_test(xs, ys)
            star = "*" if p < 0.05 else " "
            print(f"{m:8s} {a + ' vs ' + b:>16s} {diff:>10.3f} {p:>9.4f}{star}")

    print("\n===== 3b. THE 2x2 (mean pass rate; rows=contract, cols=prompt) =====")
    for m in MODELS:
        def mean(arm):
            if (m, arm) not in cells:
                return None
            vals = [sum(1 for s in fp if s == "pass") / NW for fp in cells[(m, arm)].values()]
            return 100 * sum(vals) / len(vals)
        js, jsc, pjd, pjs = mean("js"), mean("jsc"), mean("pjd"), mean("pjs")
        fmt = lambda v: f"{v:5.1f}%" if v is not None else "  n/a "
        print(f"{m:8s}  SAM : none={fmt(js)}  sem={fmt(jsc)}   lean: none={fmt(pjd)}  sem={fmt(pjs)}")

    print("\n===== 4. UNIQUE-SOLUTION-LEVEL VIEW (pass rate per distinct fingerprint) =====")
    for m in MODELS:
        parts = []
        for a in ARMS:
            fps = defaultdict(int)
            for fp in cells[(m, a)].values():
                fps[fp] += 1
            desc = ", ".join(
                f"{sum(1 for s in fp if s == 'pass')}/28 (x{n})" for fp, n in sorted(fps.items(), key=lambda kv: -kv[1])
            )
            parts.append(f"{a}: [{desc}]")
        print(f"{m:8s} " + "  ".join(parts))
    print("\nAt the unique-solution unit, n = 1-2 per cell: these support description")
    print("(effect sizes), not significance tests. The pooled window-level McNemar")
    print("chi-square values previously reported are retracted as pseudo-replicated.")


if __name__ == "__main__":
    main()
