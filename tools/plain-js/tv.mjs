// Plain-JS transition-validation runner (no SAM library).
//
// Reads a JSON request { specPath, windows } on stdin, where the spec is a
// CommonJS module exporting a pure transition function
//   next(state, action, data) -> { lockHeld, lockHolder }
// and each window is { action, data, preState, postState }.
//
// For each window: call next(pre, action, data) and compare the result's
// observable keys (lockHeld, lockHolder) to postState. Emits { ok, results }
// as JSON on stdout; per-window status is "pass" | "fail". A load failure or a
// missing next() export yields { ok:false, error } (the caller treats all
// windows as unscoreable).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const req = JSON.parse(readFileSync(0, 'utf-8'));

let mod;
try {
  mod = require(req.specPath);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'load failed: ' + (e && e.message) }));
  process.exit(0);
}
if (!mod || typeof mod.next !== 'function') {
  console.log(JSON.stringify({ ok: false, error: 'module does not export a next() function' }));
  process.exit(0);
}

const norm = (v) => (v === undefined ? null : v);
const results = [];
for (const w of req.windows) {
  const post = w.postState;
  let status;
  try {
    // Deep-copy the pre-state so a non-pure next() can't corrupt later windows.
    const out = mod.next(structuredClone(w.preState), w.action, w.data);
    const ok = out
      && out.lockHeld === post.lockHeld
      && norm(out.lockHolder) === norm(post.lockHolder);
    status = ok ? 'pass' : 'fail';
  } catch (e) {
    status = 'fail'; // a runtime error on a window is a failed transition
  }
  results.push({ action: w.action, status });
}
console.log(JSON.stringify({ ok: true, results }));
