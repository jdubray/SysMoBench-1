// Generic bounded explorer for lean-contract specs { init, next } — no SAM library.
//
// Demonstrates that the lean JS-SAM contract supports Phase 2 (bounded behavior
// exploration: no crashes, determinism, serializable state) and Phase 4
// (invariant checking) without the SAM pattern's machinery. Reads a JSON request
// { specPath, actions, depthMax, invariants } on stdin; actions is the input
// domain [{ action, data }, ...]; invariants is [{ name, predicate }] where
// predicate is a "(state) => boolean" source string. Emits a JSON report.
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
let frontier = [start];
let depth = 0;
while (frontier.length && depth < depthMax) {
  const nextFrontier = [];
  for (const s of frontier) {
    for (const a of domain) {
      let s1, s2;
      try { s1 = mod.next(structuredClone(s), a.action, a.data); steps++; }
      catch (e) { classification = classification || 'runtime_error'; errors.push(e.message); continue; }
      try { s2 = mod.next(structuredClone(s), a.action, a.data); } catch (e) { /* handled above */ }
      if (key(s1) !== key(s2)) nondeterministic = true;
      try { JSON.parse(JSON.stringify(s1)); } catch (e) { classification = classification || 'nonserializable'; }
      checkInv(s1);
      const k = key(s1);
      if (!seen.has(k)) { seen.add(k); nextFrontier.push(s1); }
    }
  }
  frontier = nextFrontier;
  depth += 1;
}
if (nondeterministic && !classification) classification = 'nondeterminism';

out({
  ok: true,
  statesExplored: steps,
  uniqueStates: seen.size,
  classification,            // null => Phase-2 clean
  errors: errors.slice(0, 5),
  invariantViolations: invViolations,  // {} => Phase-4 all pass
});
