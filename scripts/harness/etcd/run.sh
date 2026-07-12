#!/usr/bin/env bash
# scripts/harness/etcd/run.sh — run the etcd-raft trace scenarios with the
# with_tla instrumentation enabled, then fold the raw TracingEvent streams
# into SysMoBench-canonical window NDJSON.
#
# Usage (from project root):
#   bash scripts/harness/etcd/run.sh
#
# Contract (tla_eval/tasks/etcd/task.yaml > tv.harness):
#   instrumentation_file: artifacts/etcd/tla_spec_trace.go   (TraceLogger sink)
#   test_file:            artifacts/etcd/tla_trace_test.go   (TestTLATrace_*)
#   run_command:          go test -tags with_tla -run 'TestTLATrace_' -count=1 -v .
#   traces_output_env:    TRACES_DIR

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)

REPO_PATH="${REPO_PATH:-$PROJECT_ROOT/artifacts/etcd}"
OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/data/sys_traces/etcd}"
RAW_DIR="${RAW_DIR:-$(mktemp -d)}"
PYTHON="${PYTHON:-python3}"

# Pinned upstream revision (etcd-io/raft): the corpus in data/sys_traces/etcd
# was captured at this commit; PROVENANCE.txt records it per run.
PINNED_COMMIT="${PINNED_COMMIT:-26647d57a34382bc60457ad508cea835ed9b52da}"

if [[ ! -f "$REPO_PATH/raft.go" ]]; then
  echo "[run.sh] cloning etcd-io/raft into $REPO_PATH (pinned $PINNED_COMMIT)" >&2
  git clone https://github.com/etcd-io/raft.git "$REPO_PATH"
  git -C "$REPO_PATH" checkout --quiet "$PINNED_COMMIT"
fi
if ! command -v go >/dev/null; then
  echo "ERROR: go not on PATH" >&2
  exit 1
fi

# Install (or refresh) the instrumentation sink and the deterministic
# scenarios into the checkout. artifacts/ is gitignored; the two files are
# versioned here, next to this script (task.yaml > tv.harness names them).
cp "$SCRIPT_DIR/tla_spec_trace.go" "$SCRIPT_DIR/tla_trace_test.go" "$REPO_PATH/"

UPSTREAM_COMMIT=$(git -C "$REPO_PATH" rev-parse HEAD 2>/dev/null || echo "unknown")

echo "[run.sh] REPO_PATH:       $REPO_PATH" >&2
echo "[run.sh] upstream commit: $UPSTREAM_COMMIT" >&2
echo "[run.sh] RAW_DIR:         $RAW_DIR" >&2
echo "[run.sh] OUT_DIR:         $OUT_DIR" >&2

mkdir -p "$RAW_DIR" "$OUT_DIR"

# 1. Capture raw TracingEvent streams (one .events.ndjson per scenario).
( cd "$REPO_PATH" && \
  GOTOOLCHAIN=auto TRACES_DIR="$RAW_DIR" \
  go test -tags with_tla -run 'TestTLATrace_' -count=1 -v . ) >&2

# 2. Fold into window NDJSON + self-consistency checks (fails on violations).
"$PYTHON" "$SCRIPT_DIR/build_windows.py" "$OUT_DIR" "$RAW_DIR"/etcd_run*.events.ndjson

# 3. Pin provenance.
cat > "$OUT_DIR/PROVENANCE.txt" <<EOF
source repo:      https://github.com/etcd-io/raft
upstream commit:  $UPSTREAM_COMMIT
harness:          scripts/harness/etcd (tla_spec_trace.go + tla_trace_test.go)
generated:        $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo "[run.sh] done -> $OUT_DIR (commit $UPSTREAM_COMMIT)" >&2
