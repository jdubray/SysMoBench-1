# sandbox_repro — evidence from the real Finix sandbox (2026-07-04)

- `SANDBOX_REPRO.md` — findings writeup (read this first).
- `step1_evidence.jsonl` — redacted request/response transcript, in execution
  order: stale-device attempts, device enumeration, disabled-A920 attempts
  (+ timed-out enable attempts; device states verified unchanged afterwards),
  CNP identity/instrument/transfer, duplicate-key 422s, reversal.
- `probe_step1.mjs` / `probe_listdevices.mjs` / `probe_a920.mjs` /
  `probe_cnp.mjs` — the probe scripts (Node, no deps). Safety rails: sandbox
  host asserted per request, amounts ≤ 100¢, credentials read from the
  baanbaan `.env` and never logged.
- Adapter-replay check (real 422 body → which error class the production code
  raises): `baanbaan/Merchant/v2/tools/finixpos-trace-harness/sandbox-422-parse-check.ts`
  (run with `bun` from `Merchant/v2`).

Re-running `probe_cnp.mjs` creates and reverses a 100¢ sandbox charge.
