# SPEC / PRD — @bytesbrains/llm-cost-control

> **One line:** the code-guarantees layer for LLM spend — caching, budget gates, model routing, and per-tenant metering wrapped around every model call, so managed-run retainers stay profitable by construction.

## 1. Problem

Every BytesBrains engagement ends in a managed run: a flat monthly fee to operate an AI system daily (VISION: "Sell the Build, Own the Run"). The margin on that fee is `retainer − (API spend + our time)`. Both leak silently:

- Identical or near-identical calls re-executed daily (no caching discipline)
- Expensive models used for tasks a cheap model handles (no routing)
- Runaway loops / bad inputs burning budget before anyone notices (no gates)
- No per-tenant attribution, so multi-client platforms can't price or bill honestly (no metering)

Every client project re-solves these ad hoc. That's bespoke work — the anti-pattern. This package makes cost discipline a reusable module dropped into every engagement.

## 2. Non-goals (v0.x, enforced)

- ❌ No dashboard, no web UI, no hosted service (the usage log is the interface; dashboards are per-client work)
- ❌ No LLM SDK of its own — callers bring their client (Anthropic/OpenAI/anything); we wrap, never replace
- ❌ No prompt optimization/compression — out of scope, different module
- ❌ No Redis/Postgres adapters in v0.1 (interface allows them later; memory + file stores ship first)

## 3. Design principle

**The model proposes, code guarantees.** The agent/pipeline decides *what* to ask; this layer guarantees *what it may cost*: a call cannot exceed its budget, cannot skip the meter, cannot silently use a gold-plated model for tin work. Same doctrine as our safety middleware, applied to spend.

## 4. Core concepts & API surface

```ts
import { CostControl, fileStore } from "@bytesbrains/llm-cost-control";

const cc = new CostControl({
  prices: { "claude-sonnet-5": { in: 3, out: 15 }, "claude-haiku-4-5": { in: 0.8, out: 4 } }, // $/MTok
  cache: fileStore("./.ccache"),            // content-hash cache, TTL per task
  meter: fileStore("./usage"),               // append-only JSONL per tenant
  budgets: {
    perRun:  { usd: 2.0, onExceed: "throw" },
    perDay:  { usd: 25,  onExceed: "degrade" },   // degrade -> route down; "skip" | "queue" | "throw"
    perTenantDay: { usd: 5, onExceed: "skip" },
  },
  routes: {
    extract:  ["claude-haiku-4-5"],                       // cheap only
    classify: ["claude-haiku-4-5"],
    reason:   ["claude-haiku-4-5", "claude-sonnet-5"],    // escalation ladder
  },
});

const res = await cc.call({
  tenant: "acme", job: "reconcile-daily", task: "classify",
  cacheKey: { docId, promptVersion }, ttl: "24h",
  estimate: { inTok: 1200, outTok: 300 },
  exec: async (model) => {                 // caller owns the SDK call
    const r = await anthropic.messages.create({ model, ... });
    return { value: r, usage: { inTok: r.usage.input_tokens, outTok: r.usage.output_tokens } };
  },
  escalate: (r) => needsBetterModel(r.value),   // optional: false -> keep cheap result
});
```

### Components

| Component | Guarantee | v0.1 behavior |
|---|---|---|
| **Cache** | identical work is never paid for twice within TTL | stable content-hash of `cacheKey`; memory + file stores; hit/miss recorded in meter |
| **Budget gates** | spend cannot exceed configured ceilings | pre-check on `estimate`, post-record on actuals; scopes: perRun / perDay / perTenantDay; actions: `throw` / `skip` (returns `{skipped}`) / `degrade` (forces cheapest route) / `queue` (returns token for later) |
| **Router** | each task class starts on the cheapest capable model | ladder per task; `escalate` predicate walks up one rung; budget `degrade` pins to rung 0 |
| **Meter** | every call is attributed or it doesn't happen | append-only JSONL: ts, tenant, job, task, model, tokens, usd, cacheHit, escalated; `summarize(tenant?, day?)` aggregates |
| **Prices** | cost math is explicit and versioned | static map supplied by caller; helper `costOf(usage, model)` |

### Failure semantics (loud, never silent)

- Budget exceeded with `throw` → typed `BudgetExceededError` carrying scope + numbers
- `skip`/`degrade`/`queue` outcomes are **returned values and metered events**, never silent no-ops
- Meter write failure → the call itself fails (unmetered spend is a bug, not a fallback)

## 5. v0.1 scope (ship this, nothing more)

1. `CostControl.call()` with cache → gate → route → exec → meter pipeline
2. Memory + file stores (one interface: `get/set/append/readDay`)
3. Budget scopes + 4 exceed-actions
4. Routing ladders + `escalate` predicate
5. `summarize()` + `costOf()`
6. Tests: budget math, cache hits, degrade behavior, escalation, meter integrity
7. README per template standard; publish `0.1.0` with provenance

**Deferred (v0.2+):** queue executor, Redis/SQLite stores, streaming-usage capture, OTel export, per-model rate limiting, Anthropic prompt-caching awareness (count cache-read tokens at discounted price).

## 6. First real workload (validation target)

A multi-tenant AI-visibility tracking run: N locations × M queries across 5 AI engines, daily, with per-tenant attribution and a hard daily budget. If v0.1 can express that run within budget semantics — cache repeat queries, meter per tenant, degrade under budget pressure — it validates. Autonomous ops agents with per-run budgets and multi-system automation estates are the same shape with different nouns.

## 7. Milestones

- **M1 (1–2 ring-fenced slots):** pipeline core + stores + budget gates, tests green
- **M2 (1–2 slots):** routing + escalation + summarize, README, examples/, `v0.1.0` tag → npm via release workflow (needs `NPM_TOKEN` secret)

## 8. Proof-asset requirements (this is also marketing)

- README leads with the margin argument (“the difference between a profitable retainer and a leaky one”), 60-second example, honest benchmark table (one workload, cache-on vs cache-off cost)
- Public from day one, alongside our other packages
- No feature creep past §5 — this package is a tool, not a product
