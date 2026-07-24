#!/usr/bin/env python3
"""Phase-3 repair-loop experiment for the JS-SAM backend.

For each model: score its generated spec on Phase 3 (transition validation),
feed the failing transitions back to the model, ask it to rewrite the spec, then
re-score. Reports baseline vs repaired scores per model.

Usage (from the project root, with Docker available and ANTHROPIC_API_KEY set):
    python scripts/repair_phase3.py [model ...]

Defaults to the four Claude tiers. Each model must already have a generated spec
under output/compilation_check/js-sam/spin/direct_call_<model>/<ts>/spin.js
(produced by a prior `--metric compilation_check` run).
"""
import glob
import json
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / ".env", override=False)
except ImportError:
    pass

from tla_eval.languages import get
from tla_eval.evaluation.semantics.trace_loader import load_trace_windows
from tla_eval.config import get_configured_model
from tla_eval.models.base import GenerationConfig

MODELS = sys.argv[1:] or ["claude", "fable", "sonnet", "haiku"]
backend = get("js-sam")
windows = load_trace_windows("spin")  # List[(action, pre, post)]


def latest_spec(model):
    hits = sorted(glob.glob(str(
        PROJECT_ROOT
        / f"output/compilation_check/js-sam/spin/direct_call_{model}/*/spin.js"
    )))
    return Path(hits[-1]) if hits else None


def score(spec_path, work_dir):
    work_dir.mkdir(parents=True, exist_ok=True)
    outcome = backend.validate_transitions(spec_path, windows, work_dir, timeout=180)
    fpath = work_dir / "transition_failures.json"
    failures = json.loads(fpath.read_text(encoding="utf-8")) if fpath.exists() else []
    passed = outcome.total_passed or 0
    total = outcome.total_windows or len(windows)
    return passed, total, outcome.per_action_pass_rates, failures


def build_repair_prompt(spec_text, failures):
    lines = []
    for f in failures:
        action, pre, post = windows[f["window"]]
        name = action["name"] if isinstance(action, dict) else action
        data = action.get("data", {}) if isinstance(action, dict) else {}
        lines.append(
            f"- action={name} data={json.dumps(data)}\n"
            f"  setState(pre): {json.dumps(pre)}\n"
            f"  real system's post-state: {json.dumps(post)}\n"
            f"  your model was wrong here: {f.get('reason')}"
        )
    return f"""You wrote this JS-SAM spinlock specification:

```javascript
{spec_text}
```

When each transition below is replayed as `setState(pre); actions[action](data); getState()`,
your model's resulting state did NOT match the real Asterinas spinlock. For every
case, the resulting state must equal the real system's post-state on the keys shown
(the projection compares only those keys):

{chr(10).join(lines)}

Rewrite the ENTIRE specification module so that every failing transition above now
produces the real system's post-state, while preserving all behavior that was
already correct. Keep the exact same module contract and exports. Output only the
corrected module in a single ```javascript code fence."""


def main():
    summary = []
    for model in MODELS:
        spec_path = latest_spec(model)
        if not spec_path:
            print(f"[{model}] no spec found; skipping")
            continue
        spec_text = spec_path.read_text(encoding="utf-8")

        b_pass, b_total, b_pa, failures = score(spec_path, Path(tempfile.mkdtemp()))
        print(f"[{model}] baseline Phase3: {b_pass}/{b_total} = {100*b_pass/b_total:.1f}%  {dict((k, round(v,3)) for k,v in b_pa.items())}")

        if not failures:
            summary.append((model, b_pass, b_total, b_pass, b_total))
            continue

        model_obj = get_configured_model(model)
        # top_p omitted: Sonnet/Haiku 4.x reject temperature + top_p together;
        # Opus/Fable drop sampling params entirely via the adapter guard.
        resp = model_obj.generate_direct(build_repair_prompt(spec_text, failures),
                                         GenerationConfig(top_p=None))
        if not resp.success:
            print(f"[{model}] repair generation FAILED: {resp.error_message}")
            summary.append((model, b_pass, b_total, None, None))
            continue

        corrected = backend.extract_artifacts(resp.generated_text).spec
        fixed_dir = Path(tempfile.mkdtemp())
        fixed_spec = fixed_dir / "spin.js"
        fixed_spec.write_text(corrected, encoding="utf-8")

        syn = backend.validate_syntax(corrected, None, fixed_dir / "p1",
                                      timeout=120, spec_filename="spin.js")
        if not syn.success:
            print(f"[{model}] repaired spec FAILED to compile: {syn.syntax_errors or syn.semantic_errors}")
            summary.append((model, b_pass, b_total, None, None))
            continue

        r_pass, r_total, r_pa, _ = score(fixed_spec, fixed_dir / "p3")
        print(f"[{model}] REPAIRED Phase3: {r_pass}/{r_total} = {100*r_pass/r_total:.1f}%  {dict((k, round(v,3)) for k,v in r_pa.items())}")
        summary.append((model, b_pass, b_total, r_pass, r_total))

    print("\n===== REPAIR SUMMARY =====")
    for model, bp, bt, rp, rt in summary:
        base = f"{100*bp/bt:.1f}%"
        rep = f"{100*rp/rt:.1f}%" if rp is not None else "n/a"
        print(f"{model:8s}  baseline {base:>6s}  ->  repaired {rep:>6s}")


if __name__ == "__main__":
    main()
