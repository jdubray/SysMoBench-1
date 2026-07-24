#!/usr/bin/env python3
"""Final analysis for the finixpos JS-SAM vs TLA+ study (full 60-cell grid).

Inputs:  output/finixpos_v2_rescore.json  (statuses over the 101-window corpus v2)
Outputs: output/finixpos_final_analysis.json + printed markdown tables.

Statistics of record (mirrors scripts/tla_phase3_analysis.py):
  - per-model generation-level exact permutation test for each pairwise arm
    contrast: unit = generation, statistic = difference in mean unconditional
    pass rate, all C(10,5) = 252 relabelings (floor p = 1/252 ≈ 0.004; the
    attainable floor for a clean 5-vs-5 separation is 2/252 ≈ 0.0079 two-sided).
  - behavioral-uniqueness counts per (model, arm): distinct per-window status
    vectors among the 5 generations.
"""
import json
import sys
from itertools import combinations
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RESCORE = PROJECT_ROOT / "output" / "finixpos_v2_rescore.json"
OUT = PROJECT_ROOT / "output" / "finixpos_final_analysis.json"

MODELS = ["claude", "fable", "sonnet", "haiku", "leanstral", "mistral-large", "devstral"]
ARMS = ["sam", "lean", "tla"]
N = 5


def uncond(statuses):
    return sum(s == "pass" for s in statuses) / len(statuses)


def cond(statuses):
    sc = [s for s in statuses if s in ("pass", "fail")]
    return sum(s == "pass" for s in sc) / len(sc) if sc else 0.0


def perm_test(a, b):
    """Two-sided exact permutation test over all C(10,5) relabelings."""
    obs = sum(a) / len(a) - sum(b) / len(b)
    pool = a + b
    n = len(a)
    count = 0
    total = 0
    for idx in combinations(range(len(pool)), n):
        ga = [pool[i] for i in idx]
        gb = [pool[i] for i in range(len(pool)) if i not in idx]
        stat = sum(ga) / n - sum(gb) / n
        if abs(stat) >= abs(obs) - 1e-12:
            count += 1
        total += 1
    return obs, count / total


def main():
    r = json.loads(RESCORE.read_text(encoding="utf-8"))
    missing = [f"{m}_{a}_{g}" for m in MODELS for a in ARMS for g in range(N)
               if f"{m}_{a}_{g}" not in r]
    if missing:
        print(f"INCOMPLETE — {len(missing)} cells missing from rescore: {missing[:6]}...")
        sys.exit(1)

    grid = {(m, a): [r[f"{m}_{a}_{g}"]["statuses"] for g in range(N)]
            for m in MODELS for a in ARMS}

    out = {"table": {}, "permutation_tests": {}, "uniqueness": {}}

    print("## Final v2 table — unconditional (conditional) mean pass rate, N=5, 101 windows\n")
    print(f"| model | SAM | lean | TLA+ |")
    print(f"|---|---|---|---|")
    for m in MODELS:
        row = []
        for a in ARMS:
            gens = grid[(m, a)]
            u = 100 * sum(uncond(g) for g in gens) / N
            c = 100 * sum(cond(g) for g in gens) / N
            out["table"][f"{m}|{a}"] = {"uncond": u, "cond": c,
                                        "per_gen_pass": [sum(s == "pass" for s in g) for g in gens]}
            row.append(f"{u:.1f}% ({c:.1f}%)")
        print(f"| {m} | {row[0]} | {row[1]} | {row[2]} |")

    print("\n## Generation-level exact permutation tests (unconditional, two-sided)\n")
    print("| model | lean vs TLA+ | SAM vs TLA+ | lean vs SAM |")
    print("|---|---|---|---|")
    for m in MODELS:
        cells = []
        for a1, a2 in [("lean", "tla"), ("sam", "tla"), ("lean", "sam")]:
            x = [uncond(g) for g in grid[(m, a1)]]
            y = [uncond(g) for g in grid[(m, a2)]]
            d, p = perm_test(x, y)
            out["permutation_tests"][f"{m}|{a1}-{a2}"] = {"delta": d, "p": p}
            star = "*" if p < 0.05 else ""
            cells.append(f"d={d:+.3f}, p={p:.4f}{star}")
        print(f"| {m} | {cells[0]} | {cells[1]} | {cells[2]} |")

    print("\n## Behavioral uniqueness (distinct status vectors per model x arm, of 5)\n")
    print("| model | SAM | lean | TLA+ |")
    print("|---|---|---|---|")
    for m in MODELS:
        row = []
        for a in ARMS:
            uniq = len({tuple(g) for g in grid[(m, a)]})
            out["uniqueness"][f"{m}|{a}"] = uniq
            row.append(str(uniq))
        print(f"| {m} | {row[0]} | {row[1]} | {row[2]} |")

    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nwritten: {OUT.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
