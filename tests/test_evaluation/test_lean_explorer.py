"""Lean explorer — bounded progress (EF-reachability) checks.

Regression for the Phase-4 weakness review: the three JS-SAM Phase-4 invariants
are safety-only and hold for a never-releasing lock (a stuck lock trivially
preserves mutual exclusion), so safety-only Phase 4 cannot fail that defect
class in principle. The explorer's progress checks assert bounded reachability:
from every reachable state satisfying `from`, some state reachable within the
depth bound satisfies `goal`. A never-releasing lock violates ReleaseProgress;
an inert spec (never acquires) violates AcquireProgress.

Docker-gated like the other sandbox suites.
"""

import shutil
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from plain_js_tv import plain_js_explore  # noqa: E402
from lean_task_config import get as get_task_cfg  # noqa: E402

docker_required = pytest.mark.skipif(
    shutil.which("docker") is None,
    reason="Docker is not available on PATH",
)

FIXTURES = PROJECT_ROOT / "tests" / "fixtures" / "plain_js"


@docker_required
class TestProgressChecks:
    def test_reference_spec_satisfies_progress(self):
        cfg = get_task_cfg("spin")
        rep = plain_js_explore(
            cfg["reference"], cfg["actions"], cfg["invariants"],
            depth_max=6, progress=cfg["progress"],
        )
        assert rep.get("ok"), rep.get("error")
        assert rep.get("invariantViolations") == {}
        assert rep.get("progressViolations") == {}

    def test_never_releasing_lock_fails_release_progress_only(self):
        cfg = get_task_cfg("spin")
        rep = plain_js_explore(
            FIXTURES / "spin-neverrelease-lean.js", cfg["actions"], cfg["invariants"],
            depth_max=6, progress=cfg["progress"],
        )
        assert rep.get("ok"), rep.get("error")
        # Safety-only Phase 4 passes the broken lock — that is the documented gap.
        assert rep.get("invariantViolations") == {}
        # The progress check catches it: from a held state, free is unreachable.
        viol = rep.get("progressViolations") or {}
        assert "ReleaseProgress" in viol
        assert "AcquireProgress" not in viol  # acquiring still works
