#!/usr/bin/env python3
"""Sandboxed transition validation for plain-JS specs (no SAM library).

Runs tools/plain-js/tv.mjs inside a locked-down node:20-slim container (same
isolation as the JS-SAM helper: --network none, read-only rootfs, non-root user,
resource caps) and replays each window through the spec's pure `next()` function.
Returns per-window ['pass' | 'fail' | 'unscoreable'].
"""
import json
import os
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
HELPER_DIR = PROJECT_ROOT / "tools" / "plain-js"
DOCKER_IMAGE = "node:20-slim"
_CONTAINER_HELPER = "/opt/plain-js"
_CONTAINER_WORK = "/work"


def _mount(p) -> str:
    return str(p).replace("\\", "/")


def _user_args():
    if hasattr(os, "getuid"):
        return ["--user", f"{os.getuid()}:{os.getgid()}"]
    return ["--user", "1000:1000"]


def _run_script(script: str, spec_path: Path, extra: dict, timeout: int):
    """Run tools/plain-js/<script> in the sandbox with a JSON request built from
    {specPath: <container path>} + extra; return the parsed JSON response or None."""
    spec = Path(spec_path).resolve()
    container_spec = f"{_CONTAINER_WORK}/spin.js"
    request = {"specPath": container_spec, **extra}
    cmd = [
        "docker", "run", "--rm", "-i", "--network", "none",
        *_user_args(), "--read-only", "--tmpfs", "/tmp", "-e", "HOME=/tmp",
        "--memory", "2g", "--cpus", "2", "--pids-limit", "256",
        "-v", f"{_mount(HELPER_DIR)}:{_CONTAINER_HELPER}:ro",
        "-v", f"{_mount(spec)}:{container_spec}:ro",
        "-w", _CONTAINER_HELPER, DOCKER_IMAGE,
        "node", f"{_CONTAINER_HELPER}/{script}",
    ]
    try:
        proc = subprocess.run(cmd, input=json.dumps(request),
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def plain_js_tv(spec_path, windows, timeout: int = 120):
    """Phase 3: per-window ['pass'|'fail'|'unscoreable'] for a lean-contract spec."""
    extra = {
        "windows": [
            {
                "action": action["name"] if isinstance(action, dict) else action,
                "data": action.get("data", {}) if isinstance(action, dict) else {},
                "preState": pre,
                "postState": post,
            }
            for action, pre, post in windows
        ]
    }
    resp = _run_script("tv.mjs", Path(spec_path), extra, timeout)
    nw = len(windows)
    if not resp or not resp.get("ok"):
        return ["unscoreable"] * nw
    statuses = [r["status"] for r in resp.get("results", [])]
    return statuses if len(statuses) == nw else ["unscoreable"] * nw


def plain_js_explore(spec_path, actions, invariants, depth_max: int = 6, timeout: int = 120,
                     progress=None):
    """Phases 2 & 4 for a lean-contract spec: bounded exploration + invariant check.

    Returns the explorer's report dict, or {'ok': False, ...} on failure.
    `actions` is the input domain [{'action', 'data'}, ...]; `invariants` is
    [{'name', 'predicate'}] with predicate a "(state) => boolean" source string.
    `progress` is [{'name', 'from', 'goal'}] bounded EF-reachability properties
    (from every reachable state satisfying `from`, some state reachable within
    the bound satisfies `goal`) — catches defect classes safety invariants
    cannot (e.g. a never-releasing lock). Not a liveness check: no fairness,
    bounded horizon.
    """
    extra = {"actions": actions, "invariants": invariants, "depthMax": depth_max,
             "progress": progress or []}
    resp = _run_script("explore.mjs", Path(spec_path), extra, timeout)
    return resp or {"ok": False, "error": "explorer produced no output"}
