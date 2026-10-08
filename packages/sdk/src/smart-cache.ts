/**
 * Smart cache with stale-while-revalidate and contextual partitioning.
 *
 * Features:
 *  - Fresh / Stale / Expired cache states
 *  - Background revalidation on stale hits
 *  - Contextual cache keys (only relevant context fields matter)
 *  - LRU eviction when maxEntries exceeded
 *  - Cache analytics (hit/miss/stale counters)
 */

import type { FlagValue, EvaluationContext, EvaluationResult } from "./types";

export interface SmartCacheConfig {
  /** How long data is "fresh" — serve without revalidation (ms). Default: 10_000 */
  freshTtl: number;
  /** How long stale data can be served while revalidating (ms). Default: 60_000 */
  staleTtl: number;
  /** Max cache entries — LRU eviction. Default: 500 */
  maxEntries: number;
  /** Enable contextual cache partitioning. Default: true */
  contextPartitioning: boolean;
}

export type CacheStatus = "fresh" | "stale" | "expired" | "miss";

export interface CacheResult<T extends FlagValue = FlagValue> {
  status: CacheStatus;
  value?: EvaluationResult<T>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  staleHits: number;
  evictions: number;
  size: number;
  hitRate: number;
}

interface CacheEntry<T extends FlagValue = FlagValue> {
  value: EvaluationResult<T>;
  freshUntil: number;
  staleUntil: number;
  lastAccessed: number;
}

const DEFAULT_CONFIG: SmartCacheConfig = {
  freshTtl: 10_000,
  staleTtl: 60_000,
  maxEntries: 500,
  contextPartitioning: true,
};

/**
 * djb2 hash for cache key generation.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash);
}

export class SmartCache {
  private entries: Map<string, CacheEntry> = new Map();
  private config: SmartCacheConfig;
  /** Revalidation callbacks registered by consumer */
  private revalidator: ((flagKey: string, context?: EvaluationContext) => Promise<EvaluationResult | null>) | null = null;
  /** Track which keys are being revalidated to avoid duplicate fetches */
  private pendingRevalidations: Set<string> = new Set();

  // Analytics
  private _hits = 0;
  private _misses = 0;
  private _staleHits = 0;
  private _evictions = 0;
  /** Monotonic counter for LRU ordering (Date.now() has insufficient resolution) */
  private _accessCounter = 0;

  /** Mapping from flagKey → set of context properties used in targeting */
  private relevantFields: Map<string, string[]> = new Map();

  constructor(config: Partial<SmartCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the revalidation function called on stale cache hits.
   */
  setRevalidator(fn: (flagKey: string, context?: EvaluationContext) => Promise<EvaluationResult | null>): void {
    this.revalidator = fn;
  }

  /**
   * Register which context fields are relevant for a flag's targeting rules.
   * This enables contextual cache partitioning — only relevant fields
   * contribute to the cache key.
   */
  setRelevantFields(flagKey: string, fields: string[]): void {
    this.relevantFields.set(flagKey, fields);
  }

  /**
   * Generate a cache key incorporating relevant context fields.
   */
  getCacheKey(flagKey: string, context?: EvaluationContext): string {
    if (!this.config.contextPartitioning || !context) {
      return flagKey;
    }

    const fields = this.relevantFields.get(flagKey);
    if (!fields || fields.length === 0) {
      return flagKey;
    }

    // Build a stable string from relevant context fields
    const parts: string[] = [];
    for (const field of fields.sort()) {
      const val = context[field];
      if (val !== undefined) {
        parts.push(`${field}=${String(val)}`);
      }
    }

    if (parts.length === 0) return flagKey;
    return `${flagKey}:${hashString(parts.join("|"))}`;
  }

  /**
   * Get a value from the cache.
   */
  get<T extends FlagValue = FlagValue>(flagKey: string, context?: EvaluationContext): CacheResult<T> {
    const key = this.getCacheKey(flagKey, context);
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this._misses++;
      return { status: "miss" };
    }

    const now = Date.now();

    if (now < entry.freshUntil) {
      this._hits++;
      entry.lastAccessed = ++this._accessCounter;
      return { status: "fresh", value: entry.value };
    }

    if (now < entry.staleUntil) {
      this._staleHits++;
      entry.lastAccessed = ++this._accessCounter;
      // Trigger background revalidation
      this.triggerRevalidation(flagKey, key, context);
      return { status: "stale", value: entry.value };
    }

    // Expired — remove and report miss
    this.entries.delete(key);
    this._misses++;
    return { status: "expired" };
  }

  /**
   * Store a value in the cache.
   */
  set<T extends FlagValue = FlagValue>(
    flagKey: string,
    result: EvaluationResult<T>,
    context?: EvaluationContext
  ): void {
    const key = this.getCacheKey(flagKey, context);
    const now = Date.now();

    // Evict if at capacity
    if (!this.entries.has(key) && this.entries.size >= this.config.maxEntries) {
      this.evictLRU();
    }

    this.entries.set(key, {
      value: result as EvaluationResult,
      freshUntil: now + this.config.freshTtl,
      staleUntil: now + this.config.freshTtl + this.config.staleTtl,
      lastAccessed: ++this._accessCounter,
    });
  }

  /**
   * Invalidate a specific flag's cache entry.
   */
  invalidate(flagKey: string, context?: EvaluationContext): void {
    const key = this.getCacheKey(flagKey, context);
    this.entries.delete(key);
  }

  /**
   * Invalidate all entries for a flag key (across all context partitions).
   */
  invalidateAll(flagKey: string): void {
    const prefix = flagKey + ":";
    for (const key of this.entries.keys()) {
      if (key === flagKey || key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get cache analytics.
   */
  getStats(): CacheStats {
    const total = this._hits + this._misses + this._staleHits;
    return {
      hits: this._hits,
      misses: this._misses,
      staleHits: this._staleHits,
      evictions: this._evictions,
      size: this.entries.size,
      hitRate: total > 0 ? (this._hits + this._staleHits) / total : 0,
    };
  }

  /**
   * Reset analytics counters.
   */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._staleHits = 0;
    this._evictions = 0;
  }

  // ── Private ──

  private triggerRevalidation(flagKey: string, cacheKey: string, context?: EvaluationContext): void {
    if (!this.revalidator || this.pendingRevalidations.has(cacheKey)) return;

    this.pendingRevalidations.add(cacheKey);

    this.revalidator(flagKey, context)
      .then((result) => {
        if (result) {
          this.set(flagKey, result, context);
        }
      })
      .catch(() => {
        // Revalidation failed — stale value continues to serve
      })
      .finally(() => {
        this.pendingRevalidations.delete(cacheKey);
      });
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
      this._evictions++;
    }
  }
}
