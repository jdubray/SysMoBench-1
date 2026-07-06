# Contamination analysis (review point 2.6)

Empirical check of whether the evaluated models could have seen the
system-under-test in training, and of how much source surface form the
generations reuse. Checked 2026-07-04. Scripts: inline (this doc records the
queries); spec scans cover all 60 grid generations in
`output/finixpos_study_specs/`.

## 1. Repository publicity vs training cutoffs — contamination is ruled out by dates

The reviewer's premise is half right: the code **is** public on GitHub, at
**`getkizo/kizo-food`** (`apps/merchant/src/workflows/terminal-payment.ts`
etc.), confirmed via GitHub code search on distinctive identifiers
(`createTerminalPaymentWorkflow`, `sweepOrphanedTerminalSales`,
`pending_terminal_sales` — all resolve to that one public repo). The
development repo `jdubray/baan-baan-merchant` is **private**.

Timeline (GitHub API + local git):

| event | date |
|---|---|
| private dev repo created | 2026-02-20 |
| `terminal-payment.ts` first committed | 2026-03-21 |
| public `getkizo/kizo-food` repo created | 2026-03-10 |
| `terminal-payment.ts` present in public repo | 2026-03-23 |
| public repo last push | 2026-05-16 |

Training-data cutoffs (Anthropic models-overview docs, fetched 2026-07-04):
**Fable 5: Jan 2026 · Opus 4.8: Jan 2026 · Sonnet 4.6: Jan 2026 · Haiku 4.5:
Jul 2025.**

**Every evaluated checkpoint's training data ends before the system under
test existed.** The code was first written 2026-02/03 — after the latest
cutoff (Jan 2026) — so neither the public repo, the private repo, nor the
conversations that produced the code can be in any evaluated model's
training data. Claude API model IDs are pinned snapshots, so the checkpoints
did not silently update during the study. Fable 5's perfect grid cannot be
memorization of this repository.

Two honest residuals that dates do *not* rule out:
- **Library and pattern priors.** The SAM pattern (sam.js.org), the
  `@cognitive-fab/sam-pattern` library, and the author's earlier public SAM
  codebases long predate the cutoffs. Models plausibly know the *library and
  idiom* from training. That is background knowledge, not contamination of
  the system under test — but it is relevant to interpreting the SAM-arm
  results (see §3).
- **Future re-runs.** The repo has been public since 2026-03; any model
  trained after ~mid-2026 must be treated as potentially contaminated for
  this task.

## 2. Beyond-prompt artifact scan — zero hits

Method: extracted every identifier (≥6 chars, camelCase/snake_case) from the
wider repo files **not** included in the prompt's source packet
(`reconcile.ts`, `counter-ws.ts`, `dashboard-payments.ts`, `schema.sql`,
`payment-error-log.ts`, `payment-log.ts`, `order-locks.ts`,
`a920-emulator.ts`) minus every identifier occurring in the packet →
875 beyond-prompt candidate tokens (e.g. `sweepOrphanedTerminalSales`,
`order_split_sessions`, `CounterPaymentResult`, `pos_merchant_id`). Scanned
all 60 generated specs.

**Result: zero domain-token hits.** The only matches were the JavaScript
built-ins `startsWith`/`forEach` (filter artifacts, trivially derivable —
`startsWith` even appears in the prompt's own example). No generation shows
any knowledge of the repository beyond what the prompt contained.

## 3. Surface-form imitation — quantified (in-context copying, not contamination)

Every prompt contained the full source packet, so source-surface reuse is
in-context behavior. Indicator counts per (model, arm), out of 5 generations
each — occurrences of source-only idioms that the prompt's *contract and
example* do not use:

| model | arm | tuple wiring `['NAME',fn]` | `__actionName` (source) | sam-fsm/FSM refs | source comment fragments |
|---|---|---|---|---|---|
| Haiku | SAM | **5/5** | 0 | 0 | 0 |
| Opus | SAM | 0 | 4/5 | 3/5 | 3/5 |
| Fable | SAM | 0 | 2/5 | 4/5 | 4/5 |
| Sonnet | SAM | 0 | 0 | 1/5 | 0 |
| (lean arms) | lean | 0 | 0 | 0–4/5 (comments) | 1–5/5 (comments) |
| (tla arms) | tla | — | — | — | 4–5/5 (comments) |

Reading: **source surface forms permeate the generations in every arm** —
comment fragments like "anti-glitch"/"pre-FSM" and references to
`enforceAllowedTransitions` appear across models and arms — confirming the
reviewer's suspicion that models draw on the source's surface, not just its
semantics. But the *behavior-breaking* imitation is confined to one cell:
only Haiku adopts the source's `['NAME', fn]` tuple wiring (5/5, the 0%
mechanism), while the stronger models quote the source in comments and even
borrow `__actionName` naming without ever letting it break the executable
contract. Imitation intensity does not track failure except where a model
cannot keep prompt-contract and source-idiom apart.

## 4. Proposed limitation text (the "fourth fold")

> Fourth, contamination: the system under test is public on GitHub
> (getkizo/kizo-food, public since 2026-03) and was itself written by Claude
> models. For the checkpoints evaluated here this is ruled out by dates —
> every model's training data ends (Jan 2026 at the latest) before the code
> was first written (2026-02/03) — and an artifact scan of all 60
> generations found zero tokens from the repository beyond the prompt's
> source packet. Two residuals remain: the models do know the SAM *library
> and pattern* from training (they long predate the cutoffs), which shapes
> the SAM-arm results; and any future re-run on models trained after
> mid-2026 must treat this task as potentially contaminated.

## 5. Mistral panel addendum (2026-07-04)

- **mistral-large-2512 / devstral-2512:** v25.12 releases (December 2025).
  Training necessarily predates the code's existence (written 2026-02/03,
  public 2026-03-10) — contamination impossible by dates, as with the
  Claude panel.
- **labs-leanstral-1-5-1:** released mid-2026; knowledge cutoff not publicly
  stated (checked docs.mistral.ai models overview) — dates alone cannot rule
  out contamination. The §2 beyond-prompt artifact scan was rerun over all
  45 Mistral-panel generations: **zero domain-token hits** (all matches are
  generic English/JS tokens: `startsWith`, `unchanged`, `needed`, `Action`).
  Empirically negative; combined with Leanstral's high-variance, mid-pack
  performance (the opposite of a memorization signature), contamination is
  not a plausible explanation for any Mistral-panel result.
