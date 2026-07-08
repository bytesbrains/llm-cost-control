/** Token usage for a single model call. */
export interface Usage {
  inTok: number;
  outTok: number;
}

/** $ per million tokens, per model. */
export type Prices = Record<string, { in: number; out: number }>;

/** What happens when a budget ceiling would be crossed. */
export type ExceedAction = "throw" | "skip" | "degrade" | "queue";

export interface BudgetRule {
  usd: number;
  onExceed: ExceedAction;
}

export interface Budgets {
  /** Ceiling for a single call (checked on estimate, verified on actuals). */
  perCall?: BudgetRule;
  /** Cumulative ceiling across all tenants for the current day. */
  perDay?: BudgetRule;
  /** Cumulative ceiling per tenant for the current day. */
  perTenantDay?: BudgetRule;
}

/** Task class -> escalation ladder, cheapest model first. */
export type Routes = Record<string, string[]>;

/** One metered event — the append-only audit line. */
export interface MeterEvent {
  ts: string;
  tenant: string;
  job: string;
  task: string;
  model: string | null;
  inTok: number;
  outTok: number;
  usd: number;
  cacheHit: boolean;
  escalated: boolean;
  outcome: "ok" | "skipped" | "queued" | "degraded";
}

export interface ExecResult<T> {
  value: T;
  usage: Usage;
}

export interface CallOptions<T> {
  tenant: string;
  job: string;
  /** Task class — selects the routing ladder. */
  task: string;
  /** Anything JSON-serializable that identifies the work; hashed for the cache. */
  cacheKey?: unknown;
  /** Cache time-to-live: ms, or "90s" | "30m" | "24h" | "7d". */
  ttl?: number | string;
  /** Expected tokens — used for the pre-flight budget check. */
  estimate?: Usage;
  /** The actual model call. Caller owns the SDK. */
  exec: (model: string) => Promise<ExecResult<T>>;
  /** Return true to escalate one rung up the ladder. */
  escalate?: (result: ExecResult<T>) => boolean | Promise<boolean>;
}

export type CallResult<T> =
  | { ok: true; value: T; model: string; usd: number; cached: boolean; escalated: boolean; degraded: boolean }
  | { ok: false; skipped: true; scope: string }
  | { ok: false; queued: true; token: string; scope: string };

/** Storage adapter — cache entries + append-only usage log. */
export interface Store {
  get(key: string): Promise<{ value: unknown; expiresAt: number } | undefined>;
  set(key: string, value: unknown, expiresAt: number): Promise<void>;
  append(day: string, event: MeterEvent): Promise<void>;
  readDay(day: string): Promise<MeterEvent[]>;
}

export interface CostControlConfig {
  prices: Prices;
  routes: Routes;
  budgets?: Budgets;
  cache?: Store;
  meter: Store;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface Summary {
  calls: number;
  usd: number;
  inTok: number;
  outTok: number;
  cacheHits: number;
  escalations: number;
  byModel: Record<string, { calls: number; usd: number }>;
  byTask: Record<string, { calls: number; usd: number }>;
  byTenant: Record<string, { calls: number; usd: number }>;
}
