import { createHash, randomUUID } from "node:crypto";
import type {
  Budgets,
  CallOptions,
  CallResult,
  CostControlConfig,
  ExceedAction,
  MeterEvent,
  Prices,
  Summary,
  Usage,
} from "./types.js";

export { memoryStore, fileStore } from "./stores.js";
export type * from "./types.js";

/** Dollar cost of a usage at a model's price. Throws on unknown model — cost math is never guessed. */
export function costOf(usage: Usage, model: string, prices: Prices): number {
  const p = prices[model];
  if (!p) throw new Error(`llm-cost-control: no price configured for model "${model}"`);
  return (usage.inTok * p.in + usage.outTok * p.out) / 1_000_000;
}

export class BudgetExceededError extends Error {
  constructor(
    public scope: string,
    public limitUsd: number,
    public attemptedUsd: number,
    public spentUsd: number,
  ) {
    super(
      `llm-cost-control: ${scope} budget exceeded — limit $${limitUsd}, already spent $${spentUsd.toFixed(4)}, attempted call ~$${attemptedUsd.toFixed(4)}`,
    );
    this.name = "BudgetExceededError";
  }
}

const TTL_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "90s" | "30m" | "24h" | "7d" | ms-number into milliseconds. */
export function parseTtl(ttl: number | string): number {
  if (typeof ttl === "number") return ttl;
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) throw new Error(`llm-cost-control: bad ttl "${ttl}" — use ms, or "90s"/"30m"/"24h"/"7d"`);
  return Number(m[1]) * TTL_UNITS[m[2]];
}

/** Stable content hash for cache keys. */
function hashKey(task: string, cacheKey: unknown): string {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, val]) => [k, canon(val)]),
        )
      : Array.isArray(v)
        ? v.map(canon)
        : v;
  return createHash("sha256").update(JSON.stringify([task, canon(cacheKey)])).digest("hex").slice(0, 32);
}

const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export class CostControl {
  private cfg: CostControlConfig;
  private now: () => Date;

  constructor(cfg: CostControlConfig) {
    if (!cfg.meter) throw new Error("llm-cost-control: a meter store is required — unmetered spend is a bug");
    this.cfg = cfg;
    this.now = cfg.now ?? (() => new Date());
  }

  async call<T>(opts: CallOptions<T>): Promise<CallResult<T>> {
    const { prices, routes, cache } = this.cfg;
    const ladder = routes[opts.task];
    if (!ladder?.length) throw new Error(`llm-cost-control: no route configured for task "${opts.task}"`);

    // 1. cache
    const key = opts.cacheKey !== undefined ? hashKey(opts.task, opts.cacheKey) : undefined;
    if (key && cache) {
      const hit = await cache.get(key);
      if (hit && hit.expiresAt > this.now().getTime()) {
        await this.meter(opts, { model: null, usage: { inTok: 0, outTok: 0 }, usd: 0, cacheHit: true, escalated: false, outcome: "ok" });
        return { ok: true, value: hit.value as T, model: "cache", usd: 0, cached: true, escalated: false, degraded: false };
      }
    }

    // 2. budget pre-check on the estimate at the cheapest rung
    let degraded = false;
    let rung = 0;
    const estimate = opts.estimate ?? { inTok: 0, outTok: 0 };
    const estUsd = costOf(estimate, ladder[0], prices);
    const verdict = await this.gate(opts.tenant, estUsd);
    if (verdict) {
      const [scope, action] = verdict;
      if (action === "throw") {
        const { limit, spent } = await this.scopeNumbers(scope, opts.tenant);
        throw new BudgetExceededError(scope, limit, estUsd, spent);
      }
      if (action === "skip") {
        await this.meter(opts, { model: null, usage: { inTok: 0, outTok: 0 }, usd: 0, cacheHit: false, escalated: false, outcome: "skipped" });
        return { ok: false, skipped: true, scope };
      }
      if (action === "queue") {
        const token = randomUUID();
        await this.meter(opts, { model: null, usage: { inTok: 0, outTok: 0 }, usd: 0, cacheHit: false, escalated: false, outcome: "queued" });
        return { ok: false, queued: true, token, scope };
      }
      // degrade: pin to cheapest rung, no escalation allowed
      degraded = true;
    }

    // 3. execute on the ladder
    let result = await opts.exec(ladder[rung]);
    let usd = costOf(result.usage, ladder[rung], prices);
    await this.enforcePerCall(usd, opts.tenant);
    let escalated = false;

    if (!degraded && opts.escalate && rung + 1 < ladder.length && (await opts.escalate(result))) {
      rung += 1;
      const second = await opts.exec(ladder[rung]);
      const secondUsd = costOf(second.usage, ladder[rung], prices);
      await this.enforcePerCall(secondUsd, opts.tenant);
      result = second;
      usd += secondUsd;
      escalated = true;
    }

    // 4. meter (a failed meter write fails the call — by design)
    await this.meter(opts, {
      model: ladder[rung],
      usage: result.usage,
      usd,
      cacheHit: false,
      escalated,
      outcome: degraded ? "degraded" : "ok",
    });

    // 5. cache
    if (key && cache && opts.ttl !== undefined) {
      await cache.set(key, result.value, this.now().getTime() + parseTtl(opts.ttl));
    }

    return { ok: true, value: result.value, model: ladder[rung], usd, cached: false, escalated, degraded };
  }

  /** Aggregate the day's meter log. */
  async summarize(day?: string, tenant?: string): Promise<Summary> {
    const events = await this.cfg.meter.readDay(day ?? dayOf(this.now()));
    const filtered = tenant ? events.filter((e) => e.tenant === tenant) : events;
    const sum: Summary = { calls: 0, usd: 0, inTok: 0, outTok: 0, cacheHits: 0, escalations: 0, byModel: {}, byTask: {}, byTenant: {} };
    for (const e of filtered) {
      sum.calls += 1;
      sum.usd += e.usd;
      sum.inTok += e.inTok;
      sum.outTok += e.outTok;
      if (e.cacheHit) sum.cacheHits += 1;
      if (e.escalated) sum.escalations += 1;
      const bump = (rec: Record<string, { calls: number; usd: number }>, k: string) => {
        rec[k] = rec[k] ?? { calls: 0, usd: 0 };
        rec[k].calls += 1;
        rec[k].usd += e.usd;
      };
      if (e.model) bump(sum.byModel, e.model);
      bump(sum.byTask, e.task);
      bump(sum.byTenant, e.tenant);
    }
    return sum;
  }

  // ---- internals ----

  private async spentToday(tenant?: string): Promise<number> {
    const events = await this.cfg.meter.readDay(dayOf(this.now()));
    return events.filter((e) => (tenant ? e.tenant === tenant : true)).reduce((a, e) => a + e.usd, 0);
  }

  /** Returns [scope, action] of the FIRST violated budget, or undefined. */
  private async gate(tenant: string, estUsd: number): Promise<[string, ExceedAction] | undefined> {
    const b: Budgets = this.cfg.budgets ?? {};
    if (b.perCall && estUsd > b.perCall.usd) return ["perCall", b.perCall.onExceed];
    if (b.perTenantDay) {
      const spent = await this.spentToday(tenant);
      if (spent + estUsd > b.perTenantDay.usd) return ["perTenantDay", b.perTenantDay.onExceed];
    }
    if (b.perDay) {
      const spent = await this.spentToday();
      if (spent + estUsd > b.perDay.usd) return ["perDay", b.perDay.onExceed];
    }
    return undefined;
  }

  /** Post-hoc guard on ACTUAL per-call cost — actuals above the ceiling always throw loudly. */
  private async enforcePerCall(usd: number, tenant: string): Promise<void> {
    const rule = this.cfg.budgets?.perCall;
    if (rule && usd > rule.usd) {
      const spent = await this.spentToday(tenant);
      throw new BudgetExceededError("perCall(actual)", rule.usd, usd, spent);
    }
  }

  private async scopeNumbers(scope: string, tenant: string): Promise<{ limit: number; spent: number }> {
    const b: Budgets = this.cfg.budgets ?? {};
    if (scope === "perCall") return { limit: b.perCall?.usd ?? 0, spent: await this.spentToday(tenant) };
    if (scope === "perTenantDay") return { limit: b.perTenantDay?.usd ?? 0, spent: await this.spentToday(tenant) };
    return { limit: b.perDay?.usd ?? 0, spent: await this.spentToday() };
  }

  private async meter<T>(
    opts: CallOptions<T>,
    r: { model: string | null; usage: Usage; usd: number; cacheHit: boolean; escalated: boolean; outcome: MeterEvent["outcome"] },
  ): Promise<void> {
    const event: MeterEvent = {
      ts: this.now().toISOString(),
      tenant: opts.tenant,
      job: opts.job,
      task: opts.task,
      model: r.model,
      inTok: r.usage.inTok,
      outTok: r.usage.outTok,
      usd: r.usd,
      cacheHit: r.cacheHit,
      escalated: r.escalated,
      outcome: r.outcome,
    };
    await this.cfg.meter.append(dayOf(this.now()), event);
  }
}
