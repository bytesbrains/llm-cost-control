# @bytesbrains/llm-cost-control

[![npm](https://img.shields.io/npm/v/@bytesbrains/llm-cost-control)](https://www.npmjs.com/package/@bytesbrains/llm-cost-control)
[![CI](https://github.com/bytesbrains/llm-cost-control/actions/workflows/ci.yml/badge.svg)](https://github.com/bytesbrains/llm-cost-control/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The code-guarantees layer for LLM spend — **caching, budget gates, model routing, and per-tenant metering** wrapped around every model call. For anyone operating AI systems on a flat fee, this is the difference between a profitable run and a leaky one.

## Why

Daily AI workloads leak money four ways: identical calls re-executed (no caching), expensive models doing cheap work (no routing), runaway loops burning budget silently (no gates), and spend nobody can attribute per client (no metering). This package makes all four impossible by construction: **the model proposes, code guarantees** — your pipeline decides *what* to ask; this layer guarantees *what it may cost*.

- A call cannot exceed its budget — ceilings are enforced, not suggested
- A call cannot skip the meter — a failed meter write fails the call
- Every skip/degrade/queue is a **returned value and a metered event**, never a silent no-op

## Install

```bash
npm install @bytesbrains/llm-cost-control
```

## 60-second usage

```ts
import { CostControl, fileStore } from "@bytesbrains/llm-cost-control";

const cc = new CostControl({
  prices: { "claude-sonnet-5": { in: 3, out: 15 }, "claude-haiku-4-5": { in: 0.8, out: 4 } }, // $/MTok
  cache: fileStore("./.ccache"),
  meter: fileStore("./usage"),
  budgets: {
    perCall:      { usd: 0.5, onExceed: "throw" },   // no single call may cost more
    perDay:       { usd: 25,  onExceed: "degrade" }, // over budget -> cheapest model only
    perTenantDay: { usd: 5,   onExceed: "skip" },    // per-client fairness
  },
  routes: {
    classify: ["claude-haiku-4-5"],                    // cheap only
    reason:   ["claude-haiku-4-5", "claude-sonnet-5"], // escalation ladder
  },
});

const res = await cc.call({
  tenant: "acme", job: "reconcile-daily", task: "classify",
  cacheKey: { docId, promptVersion }, ttl: "24h",
  estimate: { inTok: 1200, outTok: 300 },
  exec: async (model) => {                    // you own the SDK call
    const r = await anthropic.messages.create({ model, /* ... */ });
    return { value: r, usage: { inTok: r.usage.input_tokens, outTok: r.usage.output_tokens } };
  },
  escalate: (r) => needsBetterModel(r.value), // optional: walk one rung up the ladder
});

if (res.ok) console.log(res.value, `$${res.usd}`, res.cached ? "(cache — free)" : res.model);

const today = await cc.summarize();           // { calls, usd, cacheHits, byTenant, byModel, byTask, ... }
```

## Guarantees

| Component | Guarantee |
|---|---|
| **Cache** | identical work is never paid for twice within TTL (stable content-hash; key order irrelevant) |
| **Budget gates** | spend cannot exceed ceilings — `throw` / `skip` / `degrade` / `queue` per scope; actuals over `perCall` always throw |
| **Router** | every task starts on the cheapest capable model; escalation is explicit and single-rung |
| **Meter** | every call is attributed (tenant/job/task/model/$) to an append-only log — or it doesn't happen |

## API

- `new CostControl({ prices, routes, budgets?, cache?, meter, now? })`
- `cc.call({ tenant, job, task, cacheKey?, ttl?, estimate?, exec, escalate? })` → `{ ok: true, value, model, usd, cached, escalated, degraded }` | `{ ok: false, skipped }` | `{ ok: false, queued, token }`
- `cc.summarize(day?, tenant?)` → aggregated `Summary`
- `costOf(usage, model, prices)` → `$` (throws on unknown model — cost math is never guessed)
- `memoryStore()` / `fileStore(dir)` — or implement the 4-method `Store` interface (Redis etc.)
- `BudgetExceededError` — carries `scope`, `limitUsd`, `attemptedUsd`, `spentUsd`

## Notes

- Bring your own SDK — this wraps any provider (Anthropic, OpenAI, local).
- `estimate` powers the *pre-flight* check; actual usage is enforced and metered regardless.
- v0.1 ships memory + file stores; the `Store` interface is deliberately tiny (`get/set/append/readDay`).

---

Built and maintained by [BytesBrains](https://bytesbrains.com) — AI automation & agents, engineered to production standards.
*The model proposes, code guarantees.*
