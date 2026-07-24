// Generic bounded explorer for lean-contract specs { init, next } — no SAM library.
//
// Demonstrates that the lean JS-SAM contract supports Phase 2 (bounded behavior
// exploration: no crashes, determinism, serializable state) and Phase 4
// (invariant checking) without the SAM pattern's machinery. Reads a JSON request
// { specPath, actions, depthMax, invariants, progress } on stdin; actions is the
// input domain [{ action, data }, ...]; invariants is [{ name, predicate }] where
// predicate is a "(state) => boolean" source string.
//
// `progress` is [{ name, from, goal }] (both "(state) => boolean" sources): a
// bounded PROGRESS check — from every reachable state satisfying `from`, some
// state reachable within the exploration bound must satisfy `goal` (an
// EF-reachability property). This catches defect classes that safety-only
// invariants provably cannot: a never-releasing lock satisfies mutual exclusion
// *because* it is broken, but fails "from held, free is reachable". It is NOT a
// liveness check — there is no fairness and the horizon is bounded — and it is
// labeled accordingly wherever results are reported. Emits a JSON report.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const req = JSON.parse(readFileSync(0, 'utf-8'));

let mod;
try { mod = require(req.specPath); }
catch (e) { out({ ok: false, error: 'load failed: ' + (e && e.message) }); }
if (!mod || typeof mod.init !== 'function' || typeof mod.next !== 'function') {
  out({ ok: false, error: 'lean contract requires exported init() and next()' });
}

const key = (s) => JSON.stringify(s);
const domain = req.actions || [];
const depthMax = req.depthMax ?? 6;
// eval() compiles the harness-supplied invariant predicates into functions, the
// same way the JS-SAM helper installs safety checks. Safe here: the predicates
// come from the benchmark's invariant library (not the untrusted spec), and the
// whole process runs inside the locked-down sandbox (--network none, read-only
// rootfs, non-root, resource caps). No untrusted network/host access is possible.
const invs = (req.invariants || []).map((i) => ({ name: i.name, fn: eval('(' + i.predicate + ')') }));
// Progress (bounded EF-reachability) properties; same harness-supplied-source
// rationale as the invariant predicates above.
const progress = (req.progress || []).map((p) => ({
  name: p.name,
  from: eval('(' + p.from + ')'),
  goal: eval('(' + p.goal + ')'),
}));

let steps = 0;
let classification = null;
const errors = [];
const invViolations = {};
let nondeterministic = false;

const checkInv = (s) => {
  for (const iv of invs) {
    try { if (!iv.fn(s) && !invViolations[iv.name]) invViolations[iv.name] = key(s); }
    catch (e) { /* predicate error is not a spec violation */ }
  }
};

const start = mod.init();
try { JSON.parse(JSON.stringify(start)); } catch (e) { classification = 'nonserializable'; }
checkInv(start);

const seen = new Set([key(start)]);
const snapshots = new Map([[key(start), structuredClone(start)]]); // key -> state
const edges = new Map();                                           // key -> Set of successor keys
let frontier = [start];
let depth = 0;
while (frontier.length && depth < depthMax) {
  const nextFrontier = [];
  for (const s of frontier) {
    const sk = key(s);
    if (!edges.has(sk)) edges.set(sk, new Set());
    for (const a of domain) {
      let s1, s2;
      try { s1 = mod.next(structuredClone(s), a.action, a.data); steps++; }
      catch (e) { classification = classification || 'runtime_error'; errors.push(e.message); continue; }
      try { s2 = mod.next(structuredClone(s), a.action, a.data); } catch (e) { /* handled above */ }
      if (key(s1) !== key(s2)) nondeterministic = true;
      try { JSON.parse(JSON.stringify(s1)); } catch (e) { classification = classification || 'nonserializable'; }
      checkInv(s1);
      const k = key(s1);
      edges.get(sk).add(k);
      if (!seen.has(k)) {
        seen.add(k);
        snapshots.set(k, structuredClone(s1));
        nextFrontier.push(s1);
      }
    }
  }
  frontier = nextFrontier;
  depth += 1;
}
if (nondeterministic && !classification) classification = 'nondeterminism';

// Progress: for every reachable state where from(s) holds, some state reachable
// from it (within the explored graph) must satisfy goal. First violating source
// state recorded per property.
const progressViolations = {};
if (progress.length && !classification) {
  const reachableFrom = (startKey) => {
    const visited = new Set([startKey]);
    const queue = [startKey];
    while (queue.length) {
      const k = queue.shift();
      for (const n of edges.get(k) ?? []) {
        if (!visited.has(n)) { visited.add(n); queue.push(n); }
      }
    }
    return visited;
  };
  for (const p of progress) {
    for (const [k, snap] of snapshots) {
      let applies;
      try { applies = p.from(snap); } catch (e) { continue; } // predicate error: skip state
      if (!applies) continue;
      let reached = false;
      for (const rk of reachableFrom(k)) {
        try { if (p.goal(snapshots.get(rk))) { reached = true; break; } } catch (e) { /* skip */ }
      }
      if (!reached) { progressViolations[p.name] = k; break; }
    }
  }
}

out({
  ok: true,
  statesExplored: steps,
  uniqueStates: seen.size,
  classification,            // null => Phase-2 clean
  errors: errors.slice(0, 5),
  invariantViolations: invViolations,   // {} => Phase-4 safety all pass
  progressViolations,                   // {} => bounded EF progress all pass
});
