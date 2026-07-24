#!/usr/bin/env python3
"""Re-score Phase-4 invariants that failed only on a name collision.

The invariant evaluator appends its own `<Name> == ...` definition to the
generated module. When the spec already defines an operator of that name -- as
it does whenever the model names its invariants after the expert templates --
SANY rejects the module with "Operator <Name> already defined" and the
invariant is recorded as a FAIL without TLC ever exploring a state.

This rescorer renames the APPENDED definition (the harness's own, always last)
to `<Name>_CHK`, points the .cfg at the renamed operator, and re-runs TLC. No
model call: it only removes the collision and re-scores mechanically.

Usage (project root, java on PATH):
    python scripts/rescore_p4_name_collision.py <run-dir> [<run-dir> ...]
"""
import glob
import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TLA2TOOLS = PROJECT_ROOT / "lib" / "tla2tools.jar"


def has_collision(tla_text, name):
    return len(re.findall(r"^" + re.escape(name) + r" ==", tla_text, re.M)) > 1


def rescore(inv_dir, name):
    """Rename the appended definition, re-run TLC, return (passed, states, out)."""
    tla = (inv_dir / "spin.tla").read_text(encoding="utf-8")
    cfg = (inv_dir / "spin.cfg").read_text(encoding="utf-8")

    # The harness appends its definition last; rename only that occurrence.
    marker = "\\* Manual invariant: " + name
    head, sep, tail = tla.rpartition(marker)
    if not sep:
        return None, None, "no appended definition found"
    tail = re.sub(r"^" + re.escape(name) + r" ==", name + "_CHK ==", tail, count=1, flags=re.M)
    patched_tla = head + sep + tail
    patched_cfg = re.sub(r"^(\s*)" + re.escape(name) + r"\s*$", r"\g<1>" + name + "_CHK", cfg, flags=re.M)

    out_dir = inv_dir.parent / (name + "__rescored")
    out_dir.mkdir(exist_ok=True)
    (out_dir / "spin.tla").write_text(patched_tla, encoding="utf-8")
    (out_dir / "spin.cfg").write_text(patched_cfg, encoding="utf-8")

    proc = subprocess.run(
        ["java", "-cp", str(TLA2TOOLS), "tlc2.TLC", "-config", "spin.cfg",
         "-deadlock", "spin.tla"],
        cwd=out_dir, capture_output=True, text=True, timeout=600,
    )
    out = proc.stdout + proc.stderr
    (out_dir / "tlc_output.txt").write_text(out, encoding="utf-8")
    passed = proc.returncode == 0 and "Error" not in out
    states = None
    for line in out.splitlines():
        if "distinct states found" in line:
            try:
                states = int(line.split("distinct")[0].split(",")[-1].strip())
            except ValueError:
                pass
    return passed, states, out


def main():
    run_dirs = [Path(a) for a in sys.argv[1:]]
    if not run_dirs:
        sys.exit(__doc__)

    results = {}
    for run in run_dirs:
        run_res = {}
        for inv_dir in sorted(p for p in run.iterdir() if p.is_dir()):
            name = inv_dir.name
            tla = inv_dir / "spin.tla"
            if not tla.exists() or name.endswith("__rescored"):
                continue
            text = tla.read_text(encoding="utf-8")
            if not has_collision(text, name):
                continue
            ran = glob.glob(str(inv_dir / "states" / "*" / "*.st"))
            passed, states, _ = rescore(inv_dir, name)
            run_res[name] = {
                "originally_ran": bool(ran),
                "rescored_pass": passed,
                "distinct_states": states,
            }
            print(f"{run.name}/{name}: collision -> rescored pass={passed} states={states}")
        results[run.name] = run_res

    out_file = PROJECT_ROOT / "output" / "p4_collision_rescore.json"
    out_file.write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"raw: {out_file}")


if __name__ == "__main__":
    main()
