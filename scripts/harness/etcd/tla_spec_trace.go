// SysMoBench etcd task — trace instrumentation sink.
//
// Upstream etcd-io/raft already ships full state-machine tracing behind the
// `with_tla` build tag (see state_trace.go): every interesting transition calls
// traceEvent(), which forwards a TracingEvent to the Config.TraceLogger. This
// file only supplies a concrete TraceLogger that appends each TracingEvent as
// one JSON line (NDJSON) to a per-run file — the raw input consumed by
// scripts/harness/etcd/build_windows.py.

//go:build with_tla

package raft

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// NdjsonTraceLogger implements TraceLogger by appending each TracingEvent as a
// single JSON line to a file. It is safe for concurrent use, although the
// SysMoBench harness drives the cluster single-threadedly.
type NdjsonTraceLogger struct {
	mu   sync.Mutex
	file *os.File
	enc  *json.Encoder
}

// NewNdjsonTraceLogger creates (truncating) the raw events file at path,
// creating parent directories as needed.
func NewNdjsonTraceLogger(path string) (*NdjsonTraceLogger, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create traces dir: %w", err)
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("create trace file: %w", err)
	}
	return &NdjsonTraceLogger{file: f, enc: json.NewEncoder(f)}, nil
}

// TraceEvent appends one event as a JSON line. Errors are surfaced by Close.
func (l *NdjsonTraceLogger) TraceEvent(e *TracingEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	// json.Encoder.Encode terminates each value with '\n' — exactly NDJSON.
	_ = l.enc.Encode(e)
}

// Close flushes and closes the underlying file.
func (l *NdjsonTraceLogger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.file.Close()
}
