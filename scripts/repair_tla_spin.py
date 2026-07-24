#!/usr/bin/env python3
"""One-round TLA+ repair experiment (symmetry with Experiment 2).

The two Experiment-3 TLA+ specifications that fail Phase 2 on the unbounded
CHOOSE idiom receive one repair round: the model gets its own specification,
the .cfg the harness generated, and TLC's verbatim error output — nothing
else — and rewrites the specification. The rewrite is re-scored with the
same TLC invocation.

Usage (project root, java on PATH, ANTHROPIC_API_KEY set):
    python scripts/repair_tla_spin.py
"""
import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env", override=False)
except ImportError:
    pass

from tla_eval.config import get_configured_model  # noqa: E402
from tla_eval.models.base import GenerationConfig  # noqa: E402

SPECS = {
    "claude": PROJECT_ROOT
    / "output/compilation_check/tla/spin/direct_call_claude/20260701213702",
    "sonnet": PROJECT_ROOT
    / "output/compilation_check/tla/spin/direct_call_sonnet/20260701214129",
}
OUT_DIR = PROJECT_ROOT / "output" / "tla_repair"
RESULTS_FILE = PROJECT_ROOT / "output" / "tla_repair.json"
TLA2TOOLS = PROJECT_ROOT / "lib" / "tla2tools.jar"


def run_tlc(spec_dir):
    """Run TLC on spin.tla/spin.cfg in spec_dir; return (passed, output)."""
    proc = subprocess.run(
        ["java", "-cp", str(TLA2TOOLS), "tlc2.TLC", "-config", "spin.cfg",
         "-deadlock", "spin.tla"],
        cwd=spec_dir,
        capture_output=True,
        text=True,
        timeout=300,
    )
    out = proc.stdout + proc.stderr
    passed = proc.returncode == 0 and "Error" not in out
    distinct = None
    for line in out.splitlines():
        if "distinct states found" in line:
            try:
                distinct = int(line.split("distinct")[0].split(",")[-1].strip())
            except ValueError:
                pass
    return passed, distinct, out


def build_prompt(spec_text, cfg_text, tlc_output):
    return f"""You wrote this TLA+ specification of the Asterinas OS spinlock
(module `spin`), model-checked by TLC with the configuration shown:

```tla
{spec_text}
```

Configuration (spin.cfg):
```
{cfg_text}
```

TLC fails on it. Verbatim output:

```
{tlc_output}
```

Rewrite the ENTIRE specification so that TLC model checking succeeds, while
preserving the specification's intended semantics and keeping it compatible
with the same configuration file (module name `spin`, the constant `Threads`
assigned the model values t1, t2, t3, and `SPECIFICATION Spec`). Output only
the corrected module in a single ```tla code fence."""


def extract_tla(text):
    for fence in ("```tla", "```"):
        if fence in text:
            return text.split(fence, 1)[1].split("```", 1)[0].strip()
    return text.strip()


def main():
    results = {}
    for model, spec_dir in SPECS.items():
        spec_text = (spec_dir / "spin.tla").read_text(encoding="utf-8")
        cfg_text = (spec_dir / "spin.cfg").read_text(encoding="utf-8")
        base_pass, base_states, base_out = run_tlc(spec_dir)
        # Feed the model the tail of TLC's output: the error block, not the
        # version banner.
        err_tail = "\n".join(base_out.splitlines()[-30:])

        model_obj = get_configured_model(model)
        resp = model_obj.generate_direct(
            build_prompt(spec_text, cfg_text, err_tail),
            GenerationConfig(top_p=None),
        )
        if not resp.success:
            results[model] = {"error": resp.error_message}
            continue
        repaired = extract_tla(resp.generated_text or "")
        rdir = OUT_DIR / model
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / "spin.tla").write_text(repaired + "\n", encoding="utf-8")
        (rdir / "spin.cfg").write_text(cfg_text, encoding="utf-8")
        rep_pass, rep_states, rep_out = run_tlc(rdir)
        (rdir / "tlc_output.txt").write_text(rep_out, encoding="utf-8")
        results[model] = {
            "baseline_p2": base_pass,
            "repaired_p2": rep_pass,
            "repaired_distinct_states": rep_states,
            "still_has_unbounded_choose": "unbounded CHOOSE" in rep_out,
        }
        print(
            f"{model}: P2 {base_pass} -> {rep_pass} "
            f"(distinct states: {rep_states})"
        )
    RESULTS_FILE.write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"raw: {RESULTS_FILE}  specs: {OUT_DIR}")


if __name__ == "__main__":
    main()
