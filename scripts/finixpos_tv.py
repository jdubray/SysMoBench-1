#!/usr/bin/env python3
"""Transition-validation replay for the finixpos task — all three study arms.

Arms (docs/finixpos_study_plan.md §4):
  lean — plain-JS {init, next} module, replayed via tools/plain-js/tv.mjs
  sam  — JS-SAM module contract, replayed via tools/js-sam/cli.mjs transitions
  tla  — constrained TLA+ module `finixpos`, replayed via per-window TV modules
         (the tla_direct_tv.py trick: pin pre, one step, INVARIANT NoPost)

Unlike the spin drivers, the JS helpers are invoked with node directly (no
Docker) — this study runs hand/reference and model specs from the local repo
only. Java is not on PATH on this machine; --java or FINIXPOS_JAVA overrides
the default (thinkorswim JRE; see memory/windows-toolchain-paths.md).

Usage:
    python scripts/finixpos_tv.py <spec> --arm lean|sam|tla [--json out.json]

Per-window statuses are 'pass' | 'fail' | 'unscoreable'; the summary reports
the two pre-registered numbers (conditional over scoreable, unconditional
over total).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TRACES_DIR = PROJECT_ROOT / "data" / "sys_traces" / "finixpos"
DEFAULT_JAVA = r"C:\Users\jjdub\AppData\Local\thinkorswim\jre\bin\java.exe"

ACTIONS = [
    "INITIATE_PAYMENT", "TRANSFER_CREATED", "VERIFICATION_STARTED",
    "TAP_APPROVED", "TAP_DECLINED", "PAYMENT_RECORDED",
    "CANCEL_PAYMENT", "CANCEL_CONFIRMED", "EXIT_FLOW",
]

STATE_KEYS = ["txState", "orderId", "amountCents", "transferId",
              "declineCode", "approvedAmountCents", "paymentId"]
AMOUNT_KEYS = {"amountCents", "approvedAmountCents"}


def load_windows(traces_dir: Path = TRACES_DIR):
    """[(file, index, {action, data, pre, post})] over the whole corpus."""
    windows = []
    for f in sorted(traces_dir.glob("*.ndjson")):
        with open(f, encoding="utf-8") as fh:
            for i, line in enumerate(fh):
                line = line.strip()
                if not line:
                    continue
                w = json.loads(line)
                windows.append({"file": f.name, "index": i, "action": w["action"],
                                "data": w.get("data") or {}, "pre": w["pre"], "post": w["post"]})
    return windows


# ---------------------------------------------------------------------------
# JS arms
# ---------------------------------------------------------------------------

def _node(script_args, request, timeout=180):
    proc = subprocess.run(
        ["node", *script_args], input=json.dumps(request),
        capture_output=True, text=True, timeout=timeout,
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def replay_lean(spec_path: Path, windows, timeout=180):
    request = {
        "specPath": str(Path(spec_path).resolve()).replace("\\", "/"),
        "windows": [{"action": w["action"], "data": w["data"],
                     "preState": w["pre"], "postState": w["post"]} for w in windows],
    }
    resp = _node([str(PROJECT_ROOT / "tools" / "plain-js" / "tv.mjs")], request, timeout)
    if not resp or not resp.get("ok"):
        return ["unscoreable"] * len(windows)
    statuses = [r["status"] for r in resp.get("results", [])]
    return statuses if len(statuses) == len(windows) else ["unscoreable"] * len(windows)


def replay_sam(spec_path: Path, windows, timeout=180):
    request = {
        "specPath": str(Path(spec_path).resolve()).replace("\\", "/"),
        "targetActions": ACTIONS,
        "windows": [{"action": w["action"], "data": w["data"],
                     "preState": w["pre"], "postState": w["post"]} for w in windows],
    }
    resp = _node([str(PROJECT_ROOT / "tools" / "js-sam" / "cli.mjs"), "transitions"],
                 request, timeout)
    if not resp or not resp.get("ok"):
        return ["unscoreable"] * len(windows)
    if not resp.get("success"):  # spec failed to load / broke the contract
        return ["unscoreable"] * len(windows)
    # cli.mjs reports failures (windowIndex-keyed, capped); reconstruct statuses.
    failed = {f["window"] for f in resp.get("failures", [])}
    total_passed = resp.get("totalPassed", 0)
    statuses = ["fail" if i in failed else "pass" for i in range(len(windows))]
    # If failures were truncated by the helper's cap, trust totalPassed instead.
    if statuses.count("pass") != total_passed:
        return None  # caller must fall back to per-window replay
    return statuses


def replay_sam_windowwise(spec_path: Path, windows, timeout=60):
    """Fallback when the helper's failure cap truncates: one call per window."""
    statuses = []
    for w in windows:
        s = replay_sam(spec_path, [w], timeout)
        statuses.append(s[0] if s else "unscoreable")
    return statuses


# ---------------------------------------------------------------------------
# TLA+ arm
# ---------------------------------------------------------------------------

def _tla_value(key, v):
    if v is None:
        return "-1" if (key in AMOUNT_KEYS or key == "approvedAmount") else '"none"'
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return f'"{v}"'
    raise ValueError(f"unrenderable trace value {key}={v!r}")


def _action_call(name, data):
    if name == "INITIATE_PAYMENT":
        return (f'InitiatePayment({_tla_value("orderId", data.get("orderId"))}, '
                f'{_tla_value("amountCents", data.get("amountCents"))})')
    if name == "TRANSFER_CREATED":
        return f'TransferCreated({_tla_value("transferId", data.get("transferId"))})'
    if name == "VERIFICATION_STARTED":
        return "VerificationStarted"
    if name == "TAP_APPROVED":
        return f'TapApproved({_tla_value("approvedAmount", data.get("approvedAmount"))})'
    if name == "TAP_DECLINED":
        return f'TapDeclined({_tla_value("declineCode", data.get("declineCode"))})'
    if name == "PAYMENT_RECORDED":
        return f'PaymentRecorded({_tla_value("paymentId", data.get("paymentId"))})'
    if name == "CANCEL_PAYMENT":
        return "CancelPayment"
    if name == "CANCEL_CONFIRMED":
        return "CancelConfirmed"
    if name == "EXIT_FLOW":
        return "ExitFlow"
    raise ValueError(f"unknown action {name!r}")


def _collect_constants(w):
    """Bind each CONSTANT to the values observed in this window (+ a spare)."""
    orders, transfers, payments, codes, amounts = set(), set(), set(), set(), set()
    for st in (w["pre"], w["post"]):
        if st.get("orderId"):
            orders.add(st["orderId"])
        if st.get("transferId"):
            transfers.add(st["transferId"])
        if st.get("paymentId"):
            payments.add(st["paymentId"])
        if st.get("declineCode"):
            codes.add(st["declineCode"])
        for k in AMOUNT_KEYS:
            if isinstance(st.get(k), int):
                amounts.add(st[k])
    d = w["data"]
    if d.get("orderId"):
        orders.add(d["orderId"])
    if d.get("transferId"):
        transfers.add(d["transferId"])
    if d.get("paymentId"):
        payments.add(d["paymentId"])
    if d.get("declineCode"):
        codes.add(d["declineCode"])
    for k in ("amountCents", "approvedAmount"):
        if isinstance(d.get(k), int):
            amounts.add(d[k])
    fmt_s = lambda vals, spare: "{" + ", ".join(f'"{v}"' for v in sorted(vals | {spare})) + "}"
    fmt_n = lambda vals: "{" + ", ".join(str(v) for v in sorted(vals | {0})) + "}"
    return (f"CONSTANTS\n"
            f"  OrderIds = {fmt_s(orders, 'o_unused')}\n"
            f"  Amounts = {fmt_n(amounts)}\n"
            f"  TransferIds = {fmt_s(transfers, 'tr_unused')}\n"
            f"  DeclineCodes = {fmt_s(codes, 'dc_unused')}\n"
            f"  PaymentIds = {fmt_s(payments, 'p_unused')}\n")


def _pin(state):
    return "\n          /\\ ".join(
        f"{k} = {_tla_value(k, state[k])}" for k in STATE_KEYS)


def _tv_module(action_call, pre, post):
    vars_list = ", ".join(STATE_KEYS)
    return f"""---- MODULE finixpos_TV ----
EXTENDS finixpos

VARIABLE tv_stepped

TVInit == tv_stepped = FALSE
          /\\ {_pin(pre)}

TVStep == /\\ ~tv_stepped
          /\\ tv_stepped' = TRUE
          /\\ {action_call}

TVStutter == /\\ tv_stepped
             /\\ UNCHANGED <<{vars_list}, tv_stepped>>

TVNext == TVStep \\/ TVStutter

PostReached == {_pin(post)}

NoPost == ~(tv_stepped /\\ PostReached)
====
"""


def replay_tla_window(spec_text, w, java, cp, timeout=90):
    with tempfile.TemporaryDirectory(prefix="finixpos_tv_") as d:
        dp = Path(d)
        (dp / "finixpos.tla").write_text(spec_text, encoding="utf-8")
        (dp / "finixpos_TV.tla").write_text(
            _tv_module(_action_call(w["action"], w["data"]), w["pre"], w["post"]),
            encoding="utf-8")
        (dp / "finixpos_TV.cfg").write_text(
            _collect_constants(w) + "INIT TVInit\nNEXT TVNext\nINVARIANT NoPost\n",
            encoding="utf-8")
        try:
            proc = subprocess.run(
                [java, "-cp", cp, "tlc2.TLC", "-config", "finixpos_TV.cfg",
                 "finixpos_TV.tla"],
                cwd=d, capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return "unscoreable"
        out = (proc.stdout or "") + (proc.stderr or "")
        if "Invariant NoPost is violated" in out:
            return "pass"
        if ("No error has been found" in out) or ("Model checking completed" in out):
            return "fail"
        return "unscoreable"


def replay_tla(spec_path: Path, windows, java=None, timeout=90):
    java = java or os.environ.get("FINIXPOS_JAVA") or DEFAULT_JAVA
    jars = [PROJECT_ROOT / "lib" / "tla2tools.jar",
            PROJECT_ROOT / "lib" / "CommunityModules-deps.jar"]
    cp = os.pathsep.join(str(j) for j in jars if j.exists())
    spec_text = Path(spec_path).read_text(encoding="utf-8")
    return [replay_tla_window(spec_text, w, java, cp, timeout) for w in windows]


# ---------------------------------------------------------------------------
# Scoring + CLI
# ---------------------------------------------------------------------------

def replay(spec_path: Path, arm: str, windows):
    if arm == "lean":
        return replay_lean(spec_path, windows)
    if arm == "sam":
        statuses = replay_sam(spec_path, windows)
        return statuses if statuses is not None else replay_sam_windowwise(spec_path, windows)
    if arm == "tla":
        return replay_tla(spec_path, windows)
    raise ValueError(f"unknown arm {arm!r}")


def summarize(windows, statuses):
    total = len(statuses)
    passed = statuses.count("pass")
    scoreable = passed + statuses.count("fail")
    per_action = {}
    failed_windows = []
    for w, s in zip(windows, statuses):
        d = per_action.setdefault(w["action"], {"pass": 0, "fail": 0, "unscoreable": 0})
        d[s] += 1
        if s != "pass":
            failed_windows.append({"file": w["file"], "index": w["index"],
                                   "action": w["action"], "status": s,
                                   "preTxState": w["pre"]["txState"]})
    return {
        "total": total, "passed": passed, "scoreable": scoreable,
        "unscoreable": total - scoreable,
        "conditional": passed / scoreable if scoreable else 0.0,
        "unconditional": passed / total if total else 0.0,
        "per_action": per_action,
        "failed_windows": failed_windows,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--arm", required=True, choices=["lean", "sam", "tla"])
    ap.add_argument("--traces", default=str(TRACES_DIR))
    ap.add_argument("--json", help="write full summary JSON here")
    args = ap.parse_args()

    windows = load_windows(Path(args.traces))
    statuses = replay(Path(args.spec), args.arm, windows)
    s = summarize(windows, statuses)
    print(f"windows={s['total']} passed={s['passed']} scoreable={s['scoreable']} "
          f"unscoreable={s['unscoreable']}")
    print(f"conditional={100 * s['conditional']:.1f}%  "
          f"unconditional={100 * s['unconditional']:.1f}%")
    for name, d in sorted(s["per_action"].items()):
        print(f"  {name}: pass={d['pass']} fail={d['fail']} unscoreable={d['unscoreable']}")
    for fw in s["failed_windows"]:
        print(f"  {fw['status'].upper()}: {fw['file']}[{fw['index']}] "
              f"{fw['preTxState']} + {fw['action']}")
    if args.json:
        Path(args.json).write_text(json.dumps(s, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
