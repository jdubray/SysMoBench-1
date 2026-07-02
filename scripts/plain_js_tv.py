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


def _run(spec_path: Path, windows, timeout: int):
    spec = Path(spec_path).resolve()
    container_spec = f"{_CONTAINER_WORK}/spin.js"
    request = {
        "specPath": container_spec,
        "windows": [
            {
                "action": action["name"] if isinstance(action, dict) else action,
                "data": action.get("data", {}) if isinstance(action, dict) else {},
                "preState": pre,
                "postState": post,
            }
            for action, pre, post in windows
        ],
    }
    cmd = [
        "docker", "run", "--rm", "-i", "--network", "none",
        *_user_args(), "--read-only", "--tmpfs", "/tmp", "-e", "HOME=/tmp",
        "--memory", "2g", "--cpus", "2", "--pids-limit", "256",
        "-v", f"{_mount(HELPER_DIR)}:{_CONTAINER_HELPER}:ro",
        "-v", f"{_mount(spec)}:{container_spec}:ro",
        "-w", _CONTAINER_HELPER, DOCKER_IMAGE,
        "node", f"{_CONTAINER_HELPER}/tv.mjs",
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
    resp = _run(Path(spec_path), windows, timeout)
    nw = len(windows)
    if not resp or not resp.get("ok"):
        return ["unscoreable"] * nw
    statuses = [r["status"] for r in resp.get("results", [])]
    if len(statuses) != nw:
        return ["unscoreable"] * nw
    return statuses
