import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  CostControl,
  costOf,
  fileStore,
  memoryStore,
  parseTtl,
  type CostControlConfig,
  type Store,
} from "../src/index.js";

const PRICES = {
  cheap: { in: 1, out: 5 },     // $1/$5 per MTok
  strong: { in: 10, out: 50 },
};
const ROUTES = {
  classify: ["cheap"],
  reason: ["cheap", "strong"],
};

/** 1M in + 1M out on cheap = $6; on strong = $60. */
const MTOK = { inTok: 1_000_000, outTok: 1_000_000 };

function cc(over: Partial<CostControlConfig> = {}) {
  return new CostControl({
    prices: PRICES,
    routes: ROUTES,
    cache: memoryStore(),
    meter: memoryStore(),
    ...over,
  });
}

const exec =
  (value: string, usage = MTOK) =>
  async (_model: string) => ({ value, usage });

describe("costOf", () => {
  it("computes $ from $/MTok", () => {
    expect(costOf(MTOK, "cheap", PRICES)).toBe(6);
    expect(costOf({ inTok: 500_000, outTok: 100_000 }, "strong", PRICES)).toBe(10);
  });
  it("throws on unknown model — never guesses", () => {
    expect(() => costOf(MTOK, "mystery", PRICES)).toThrow(/no price configured/);
  });
});

describe("parseTtl", () => {
  it("parses units", () => {
    expect(parseTtl("90s")).toBe(90_000);
    expect(parseTtl("30m")).toBe(1_800_000);
    expect(parseTtl("24h")).toBe(86_400_000);
    expect(parseTtl(5000)).toBe(5000);
  });
  it("rejects garbage", () => {
    expect(() => parseTtl("soon")).toThrow(/bad ttl/);
  });
});

describe("cache", () => {
  it("identical work is never paid for twice within TTL", async () => {
    const c = cc();
    let execs = 0;
    const run = () =>
      c.call({
        tenant: "acme", job: "daily", task: "classify",
        cacheKey: { doc: 1, v: "p1" }, ttl: "24h",
        exec: async (m) => { execs++; return { value: "x", usage: MTOK }; },
      });
    const a = await run();
    const b = await run();
    expect(execs).toBe(1);
    expect(a.ok && !a.cached).toBe(true);
    expect(b.ok && b.cached && b.usd === 0).toBe(true);
  });

  it("key order does not break the hash", async () => {
    const c = cc();
    let execs = 0;
    const mk = (k: object) =>
      c.call({ tenant: "t", job: "j", task: "classify", cacheKey: k, ttl: "1h",
        exec: async () => { execs++; return { value: 1, usage: MTOK }; } });
    await mk({ a: 1, b: 2 });
    await mk({ b: 2, a: 1 });
    expect(execs).toBe(1);
  });

  it("expired entries re-execute", async () => {
    let t = new Date("2026-01-01T00:00:00Z").getTime();
    const c = cc({ now: () => new Date(t) });
    let execs = 0;
    const run = () =>
      c.call({ tenant: "t", job: "j", task: "classify", cacheKey: "k", ttl: "1h",
        exec: async () => { execs++; return { value: 1, usage: MTOK }; } });
    await run();
    t += 2 * 3_600_000; // +2h
    await run();
    expect(execs).toBe(2);
  });
});

describe("budget gates", () => {
  it("perCall throw — estimate over ceiling", async () => {
    const c = cc({ budgets: { perCall: { usd: 1, onExceed: "throw" } } });
    await expect(
      c.call({ tenant: "t", job: "j", task: "classify", estimate: MTOK, exec: exec("x") }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it("perCall actuals over ceiling throw even without estimate", async () => {
    const c = cc({ budgets: { perCall: { usd: 1, onExceed: "throw" } } });
    await expect(
      c.call({ tenant: "t", job: "j", task: "classify", exec: exec("x", MTOK) }),
    ).rejects.toThrow(/perCall\(actual\)/);
  });

  it("perTenantDay skip — returns skipped, meters the event, spends nothing", async () => {
    const c = cc({ budgets: { perTenantDay: { usd: 5, onExceed: "skip" } } });
    const first = await c.call({ tenant: "acme", job: "j", task: "classify", exec: exec("x") }); // $6 spent
    expect(first.ok).toBe(true);
    const second = await c.call({ tenant: "acme", job: "j", task: "classify", estimate: MTOK, exec: exec("y") });
    expect(second.ok).toBe(false);
    expect("skipped" in second && second.skipped).toBe(true);
    const other = await c.call({ tenant: "other", job: "j", task: "classify", exec: exec("z") });
    expect(other.ok).toBe(true); // isolation: other tenant unaffected
    const sum = await c.summarize(undefined, "acme");
    expect(sum.calls).toBe(2); // skip was metered
  });

  it("perDay degrade — pins to cheapest rung and blocks escalation", async () => {
    const c = cc({ budgets: { perDay: { usd: 5, onExceed: "degrade" } } });
    await c.call({ tenant: "t", job: "j", task: "classify", exec: exec("warmup") }); // $6 > $5 spent
    const models: string[] = [];
    const r = await c.call({
      tenant: "t", job: "j", task: "reason", estimate: { inTok: 1000, outTok: 1000 },
      exec: async (m) => { models.push(m); return { value: "v", usage: { inTok: 1000, outTok: 1000 } }; },
      escalate: () => true, // would escalate if allowed
    });
    expect(models).toEqual(["cheap"]);
    expect(r.ok && r.degraded && !r.escalated).toBe(true);
  });

  it("queue returns a token and executes nothing", async () => {
    const c = cc({ budgets: { perDay: { usd: 0.001, onExceed: "queue" } } });
    let execs = 0;
    const r = await c.call({ tenant: "t", job: "j", task: "classify", estimate: MTOK,
      exec: async () => { execs++; return { value: 1, usage: MTOK }; } });
    expect(execs).toBe(0);
    expect(r.ok).toBe(false);
    expect("queued" in r && typeof r.token === "string").toBe(true);
  });
});

describe("routing & escalation", () => {
  it("starts on the cheapest rung", async () => {
    const c = cc();
    const models: string[] = [];
    await c.call({ tenant: "t", job: "j", task: "reason",
      exec: async (m) => { models.push(m); return { value: 1, usage: { inTok: 1, outTok: 1 } }; } });
    expect(models).toEqual(["cheap"]);
  });

  it("escalates exactly one rung when the predicate says so, and sums cost", async () => {
    const c = cc();
    const models: string[] = [];
    const r = await c.call({
      tenant: "t", job: "j", task: "reason",
      exec: async (m) => { models.push(m); return { value: m, usage: MTOK }; },
      escalate: (res) => res.value === "cheap", // only the first result triggers
    });
    expect(models).toEqual(["cheap", "strong"]);
    expect(r.ok && r.escalated && r.model === "strong").toBe(true);
    if (r.ok) expect(r.usd).toBe(66); // $6 + $60
  });

  it("throws on a task with no route", async () => {
    const c = cc();
    await expect(
      c.call({ tenant: "t", job: "j", task: "unknown", exec: exec("x") }),
    ).rejects.toThrow(/no route configured/);
  });
});

describe("meter integrity", () => {
  it("every executed call is attributed", async () => {
    const c = cc();
    await c.call({ tenant: "a", job: "j1", task: "classify", exec: exec("x") });
    await c.call({ tenant: "b", job: "j2", task: "reason", exec: exec("y") });
    const sum = await c.summarize();
    expect(sum.calls).toBe(2);
    expect(sum.usd).toBe(12);
    expect(Object.keys(sum.byTenant).sort()).toEqual(["a", "b"]);
  });

  it("a failed meter write fails the call — unmetered spend is a bug", async () => {
    const broken: Store = {
      ...memoryStore(),
      append: async () => { throw new Error("disk full"); },
    };
    const c = cc({ meter: broken });
    await expect(
      c.call({ tenant: "t", job: "j", task: "classify", exec: exec("x") }),
    ).rejects.toThrow(/disk full/);
  });

  it("requires a meter at construction", () => {
    expect(() => new CostControl({ prices: PRICES, routes: ROUTES } as never)).toThrow(/meter store is required/);
  });
});

describe("fileStore", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists cache entries and usage across instances", async () => {
    dir = mkdtempSync(join(tmpdir(), "ccstore-"));
    const a = cc({ cache: fileStore(dir), meter: fileStore(dir) });
    await a.call({ tenant: "t", job: "j", task: "classify", cacheKey: "k", ttl: "1h", exec: exec("v") });
    // new instance, same dir — cache hit, meter history intact
    const b = cc({ cache: fileStore(dir), meter: fileStore(dir) });
    let execs = 0;
    const r = await b.call({ tenant: "t", job: "j", task: "classify", cacheKey: "k", ttl: "1h",
      exec: async () => { execs++; return { value: "w", usage: MTOK }; } });
    expect(execs).toBe(0);
    expect(r.ok && r.cached && r.value === "v").toBe(true);
    const sum = await b.summarize();
    expect(sum.calls).toBe(2);
    expect(sum.cacheHits).toBe(1);
  });
});
