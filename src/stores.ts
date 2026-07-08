import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { MeterEvent, Store } from "./types.js";

/** In-memory store — tests, short-lived processes. */
export function memoryStore(): Store {
  const cache = new Map<string, { value: unknown; expiresAt: number }>();
  const days = new Map<string, MeterEvent[]>();
  return {
    async get(key) {
      return cache.get(key);
    },
    async set(key, value, expiresAt) {
      cache.set(key, { value, expiresAt });
    },
    async append(day, event) {
      const list = days.get(day) ?? [];
      list.push(event);
      days.set(day, list);
    },
    async readDay(day) {
      return days.get(day) ?? [];
    },
  };
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");

/** File-backed store — cache entries as JSON files, usage as JSONL per day. */
export function fileStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const cachePath = (key: string) => join(dir, `cache-${safe(key)}.json`);
  const dayPath = (day: string) => join(dir, `usage-${safe(day)}.jsonl`);
  return {
    async get(key) {
      const p = cachePath(key);
      if (!existsSync(p)) return undefined;
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        unlinkSync(p);
        return undefined;
      }
    },
    async set(key, value, expiresAt) {
      writeFileSync(cachePath(key), JSON.stringify({ value, expiresAt }));
    },
    async append(day, event) {
      appendFileSync(dayPath(day), JSON.stringify(event) + "\n");
    },
    async readDay(day) {
      const p = dayPath(day);
      if (!existsSync(p)) return [];
      return readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as MeterEvent);
    },
  };
}
