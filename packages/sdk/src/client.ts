import type {
  FlaggrConfig,
  FlaggrClientInstance,
  FlaggrPlugin,
  FlagValue,
  EvaluationContext,
  EvaluationResult,
  FlagChangeEvent,
  ConnectionState,
  OutcomeEvent,
  UpdateMode,
} from "./types";
import { ConnectionState as CS } from "./types";
import {
  Evaluator,
  isLocallyEvaluable,
} from "@flaggr/evaluator";
import type { FlagConfig } from "@flaggr/evaluator";
import { openEventStream } from "./event-stream";
import { exposeFlag, forgetFlags, shouldExpose, withdrawFlag } from "./expose-flags";

interface CacheEntry {
  value: FlagValue;
  reason: string;
  variant?: string;
  expiresAt: number;
}

/** One flag's result from either batch API (see fetchBatchChunk). */
interface BatchResult {
  key?: string;
  flagKey?: string;
  value?: FlagValue;
  reason?: string;
  variant?: string;
}

/** FNV-1a 32-bit — stable key component for auth-scoped snapshots. */
function fnv32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** Shape of the data-plane `configuration_sync` SSE payload. */
interface ConfigurationSyncPayload {
  type?: string;
  flags?: FlagConfig[] | Record<string, FlagConfig>;
  version?: string;
}

/**
 * Core Flaggr client implementation.
 *
 * Fast path: when the data plane pushes `configuration_sync` over SSE, flag
 * configs are held in memory and evaluation runs locally in microseconds —
 * zero network per eval. Flags whose operators the Go data plane doesn't
 * implement (exists, cohorts, ...) fall back to remote evaluation with
 * in-flight request deduplication.
 */
export class FlaggrClient implements FlaggrClientInstance {
  private config: Required<
    Pick<FlaggrConfig, "apiUrl" | "serviceId" | "cacheTtl">
  > &
    FlaggrConfig;
  private plugins: FlaggrPlugin[];
  private context: EvaluationContext;
  /** true when this.context has keys — skips spread-merge on the hot path */
  private hasBaseContext = false;
  /** Memoized context serializations — the same object re-evaluates for free */
  private contextKeys = new WeakMap<EvaluationContext, string>();
  private cache: Map<string, CacheEntry> = new Map();
  /** Flag configurations pushed by configuration_sync — enables local eval */
  private flagConfigs: Map<string, FlagConfig> = new Map();
  private configVersion?: string;
  /** In-flight remote evaluations keyed by flag+context — collapses concurrent calls */
  private inflight: Map<string, Promise<EvaluationResult>> = new Map();
  private connectionState: ConnectionState = CS.DISCONNECTED;
  private flagChangeListeners: Map<
    string,
    Set<(event: FlagChangeEvent) => void>
  > = new Map();
  private connectionListeners: Set<(state: ConnectionState) => void> =
    new Set();
  /**
   * The open update stream: fetch with the key in the Authorization header
   * when an apiKey is set, else EventSource.
   */
  private stream: { close(): void } | null = null;
  private destroyed = false;
  /** Settles when remote SDK config has been applied (or skipped/failed) */
  private configReady: Promise<void>;
  private updateMode: UpdateMode;
  /** Auth scope for the persisted flag snapshot — "anon" or key hash. */
  private persistScope: string;
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks the last evaluated variant per flag key for outcome event correlation */
  private lastEvaluatedVariants: Map<string, string> = new Map();
  /** Publish resolved values to the page for browser analytics (`exposeFlags`). */
  private exposeFlags: boolean;
  /**
   * The last value this client queued for the page per flag key (see
   * exposeFlag): undefined once setContext has forgotten it (forgetFlags).
   */
  private exposed: Map<string, unknown> = new Map();
  /** Keys last published from an evaluation with a per-call context. */
  private perCall = new Set<string>();
  /** Bumped by setContext: results that arrive later belong to the old context. */
  private contextVersion = 0;

  constructor(config: FlaggrConfig) {
    this.config = {
      apiUrl: "https://api.flaggr.dev",
      cacheTtl: 10_000,
      enableStreaming: false,
      ...config,
    };
    this.exposeFlags = shouldExpose(config.exposeFlags);
    this.plugins = config.plugins ?? [];
    this.context = config.context ?? {};
    this.hasBaseContext = Object.keys(this.context).length > 0;

    // Seed from a bootstrap configuration so first paint never hits network
    if (config.bootstrap) {
      this.applyConfiguration(config.bootstrap as ConfigurationSyncPayload);
    }

    this.updateMode =
      config.updateMode ?? (config.enableStreaming ? "stream" : "poll");

    // Notify plugins of initialization
    for (const plugin of this.plugins) {
      plugin.onInit?.(this);
    }

    // Remote config fetch — fills unset fields from GET /api/sdk-config
    // before the first remote eval; localStorage SWR keeps repeat loads free.
    this.persistScope = this.config.apiKey
      ? `k${fnv32(this.config.apiKey)}`
      : "anon";

    this.configReady = this.config.remoteConfig
      ? this.loadRemoteConfig(config)
      : Promise.resolve();

    this.applyUpdateMode(this.updateMode);

    this.setConnectionState(CS.CONNECTED);
  }

  /**
   * Pull service-level SDK settings from the platform and apply them as
   * defaults for fields the caller left unset. Persisted in localStorage
   * (60s fresh window, stale-while-revalidate after) so page reloads apply
   * instantly and revalidate in the background.
   */
  private async loadRemoteConfig(explicit: FlaggrConfig): Promise<void> {
    const cfgKey = `flaggr:cfg:${this.config.serviceId}`;
    const scope = this.persistScope;
    let storedBv: string | undefined;
    const applyRemote = (cfg: {
      defaultEnvironment?: string;
      environment?: string;
      bootstrap?: ConfigurationSyncPayload["flags"];
      bootstrapVersion?: string;
      sdk?: { updateMode?: UpdateMode; telemetry?: boolean; cacheTtlMs?: number; batchIntervalMs?: number };
    }) => {
      // Bootstrap flag configs → local eval with zero extra round trips.
      // Skip the re-apply entirely when the persisted snapshot already
      // carries this exact content version.
      if (cfg.bootstrap && cfg.bootstrapVersion !== storedBv) {
        this.applyConfiguration({ flags: cfg.bootstrap }, { persist: false });
        this.persistFlagSnapshot(
          cfg.environment ?? this.config.environment,
          scope,
          cfg.bootstrapVersion
        );
        storedBv = cfg.bootstrapVersion;
      }
      if (explicit.environment === undefined && cfg.defaultEnvironment) {
        this.config.environment = cfg.defaultEnvironment;
      }
      const sdk = cfg.sdk;
      if (!sdk) return;
      if (explicit.updateMode === undefined && sdk.updateMode) {
        this.updateMode = sdk.updateMode;
        this.applyUpdateMode(sdk.updateMode);
      }
      if (explicit.cacheTtl === undefined && sdk.cacheTtlMs) {
        this.config.cacheTtl = sdk.cacheTtlMs;
      }
      if (explicit.batchIntervalMs === undefined && sdk.batchIntervalMs) {
        this.config.batchIntervalMs = sdk.batchIntervalMs;
      }
      // Remote telemetry opt-in — attach the plugin lazily if the service
      // config asks for it and the caller didn't already provide one.
      if (sdk.telemetry && !this.plugins.some((p) => p.name === "flaggr-telemetry")) {
        void import("./telemetry")
          .then(({ flaggrTelemetry }) => {
            const plugin = flaggrTelemetry();
            this.plugins.push(plugin);
            plugin.onInit?.(this);
          })
          .catch(() => {});
      }
    };

    // Persisted flag snapshot first — flag configs no longer live in the
    // settings blob, so this must apply before the fresh-cfg early return.
    const snap = this.readFlagSnapshot(this.config.environment, scope);
    if (snap) {
      storedBv = snap.bv;
      // Baseline content — always applied; the bv-check in applyRemote is
      // only for deciding whether a *network* response differs from this.
      this.applyConfiguration({ flags: snap.flags }, { persist: false });
      if (explicit.environment === undefined && snap.env) {
        this.config.environment = snap.env;
      }
    }

    // SWR: apply cached settings, then revalidate in background.
    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(cfgKey);
        if (raw) {
          const { ts, cfg } = JSON.parse(raw) as { ts: number; cfg: Parameters<typeof applyRemote>[0] };
          applyRemote(cfg);
          if (Date.now() - ts < 60_000) return; // fresh — done
        }
      } catch {
        /* localStorage unavailable/corrupt — fall through to fetch */
      }
    }

    try {
      const params = new URLSearchParams({ serviceId: this.config.serviceId, bootstrap: "1" });
      if (this.config.environment) params.set("environment", this.config.environment);
      const headers: Record<string, string> = {};
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
      const res = await fetch(
        `${this.config.apiUrl}/api/sdk-config?${params}`,
        { headers }
      );
      if (!res.ok) return;
      const cfg = (await res.json()) as Parameters<typeof applyRemote>[0];
      applyRemote(cfg);
      if (typeof localStorage !== "undefined") {
        try {
          // Settings only — the (potentially multi-MB) bootstrap payload
          // lives in its own snapshot record, never in this blob.
          const { bootstrap: _drop, ...settings } = cfg;
          void _drop;
          localStorage.setItem(cfgKey, JSON.stringify({ ts: Date.now(), cfg: settings }));
        } catch {}
      }
    } catch {
      /* offline / unreachable — operate on explicit config */
    }
  }

  /** Persisted snapshot record — schema version busts on SDK upgrades. */
  private static readonly SNAPSHOT_SCHEMA = 1;
  /** Absolute staleness ceiling — snapshots older than this are dropped. */
  private static readonly SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  /** localStorage quota is ~5MB shared; refuse writes near it. */
  private static readonly SNAPSHOT_MAX_BYTES = 4_000_000;

  /**
   * Write the current flag configs as a persisted snapshot keyed by
   * service+environment+auth-scope. Best-effort: quota failure evicts the
   * oldest flaggr snapshot entries and retries once, then gives up silently.
   */
  private persistFlagSnapshot(
    env: string | undefined,
    scope: string,
    bootstrapVersion?: string
  ): void {
    if (typeof localStorage === "undefined" || this.flagConfigs.size === 0) return;
    const key = `flaggr:flags:${this.config.serviceId}:${env ?? "production"}:${scope}`;
    const record = {
      v: FlaggrClient.SNAPSHOT_SCHEMA,
      ts: Date.now(),
      bv: bootstrapVersion,
      flags: [...this.flagConfigs.values()],
    };
    let json: string;
    try {
      json = JSON.stringify(record);
    } catch {
      return; // unserializable flag content — skip persist
    }
    if (json.length > FlaggrClient.SNAPSHOT_MAX_BYTES) return;
    try {
      localStorage.setItem(key, json);
      return;
    } catch {
      /* quota — evict oldest flaggr snapshots, retry once */
    }
    try {
      const victims: { k: string; ts: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("flaggr:flags:") || k === key) continue;
        try {
          const rec = JSON.parse(localStorage.getItem(k) ?? "{}");
          victims.push({ k, ts: typeof rec.ts === "number" ? rec.ts : 0 });
        } catch {
          victims.push({ k, ts: 0 }); // corrupt — evict first
        }
      }
      victims.sort((a, b) => a.ts - b.ts);
      for (const victim of victims.slice(0, 5)) localStorage.removeItem(victim.k);
      localStorage.setItem(key, json);
    } catch {
      /* still over quota — non-persistent mode, evals unaffected */
    }
  }

  /**
   * Read a persisted flag snapshot. Validates schema version, auth scope,
   * age, and shape — anything unexpected is ignored and removed.
   * When `env` is unset, the newest snapshot for this service+scope wins.
   */
  private readFlagSnapshot(
    env: string | undefined,
    scope: string
  ): { env: string; bv?: string; flags: FlagConfig[] } | null {
    if (typeof localStorage === "undefined") return null;
    const prefix = `flaggr:flags:${this.config.serviceId}:`;
    let best: { env: string; bv?: string; flags: FlagConfig[]; ts: number } | null = null;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(prefix) || !k.endsWith(`:${scope}`)) continue;
        const kEnv = k.slice(prefix.length, k.length - scope.length - 1);
        if (env !== undefined && kEnv !== env) continue;
        let rec: { v?: number; ts?: number; bv?: string; flags?: unknown };
        try {
          rec = JSON.parse(localStorage.getItem(k) ?? "") as typeof rec;
        } catch {
          localStorage.removeItem(k); // corrupt JSON — drop and rescan index
          i--;
          continue;
        }
        if (
          rec.v !== FlaggrClient.SNAPSHOT_SCHEMA ||
          typeof rec.ts !== "number" ||
          !Array.isArray(rec.flags) ||
          Date.now() - rec.ts > FlaggrClient.SNAPSHOT_MAX_AGE_MS
        ) {
          localStorage.removeItem(k); // stale/wrong-schema — clean it
          i--;
          continue;
        }
        if (!best || rec.ts > best.ts) {
          best = { env: kEnv, bv: rec.bv, flags: rec.flags as FlagConfig[], ts: rec.ts };
        }
      }
    } catch {
      return null;
    }
    return best;
  }

  /**
   * Clear all persisted SDK state for this service — remote settings, flag
   * snapshots (all environments + scopes), forcing a fresh fetch next load.
   * Use when rotating keys or recovering from unexpected cached state.
   */
  clearPersistedConfig(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(`flaggr:cfg:${this.config.serviceId}`);
      const prefix = `flaggr:flags:${this.config.serviceId}:`;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) localStorage.removeItem(k);
      }
    } catch {
      /* storage unavailable */
    }
  }

  /**
   * Switch update delivery at runtime — stream (SSE push), batch (periodic
   * batched refresh), or poll (per-flag requests). Tears down the previous
   * transport before starting the new one.
   */
  setUpdateMode(mode: UpdateMode): void {
    if (this.destroyed || mode === this.updateMode) return;
    this.updateMode = mode;
    this.applyUpdateMode(mode);
  }

  getUpdateMode(): UpdateMode {
    return this.updateMode;
  }

  getConfig(): Readonly<FlaggrConfig> {
    return this.config;
  }

  private applyUpdateMode(mode: UpdateMode): void {
    // Tear down whichever transport was active.
    this.stream?.close();
    this.stream = null;
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }

    if (mode === "stream") {
      this.connectSSE();
    } else if (mode === "batch") {
      const interval = this.config.batchIntervalMs ?? 2000;
      this.batchTimer = setInterval(() => {
        void this.refreshWatchedFlags();
      }, interval);
      // Catch up immediately on switch instead of waiting a full tick.
      void this.refreshWatchedFlags();
    }
  }

  /**
   * Batch-mode refresh: one POST covers every flag the app actually uses —
   * watched via listeners or already cached — instead of a request per flag.
   * Watched cache entries are dropped first so the batch revalidates rather
   * than short-circuiting on the TTL; listeners fire on observed changes.
   */
  private async refreshWatchedFlags(): Promise<void> {
    const keys = new Set<string>();
    for (const flagKey of this.flagChangeListeners.keys()) keys.add(flagKey);
    const oldValues = new Map<string, FlagValue>();
    for (const [cacheKey, entry] of this.cache) {
      const pipe = cacheKey.indexOf("|");
      const base = pipe === -1 ? cacheKey : cacheKey.slice(0, pipe);
      keys.add(base);
      if (!oldValues.has(base)) oldValues.set(base, entry.value);
    }
    if (keys.size === 0) return;
    for (const cacheKey of [...this.cache.keys()]) {
      const pipe = cacheKey.indexOf("|");
      const base = pipe === -1 ? cacheKey : cacheKey.slice(0, pipe);
      if (keys.has(base)) this.cache.delete(cacheKey);
    }
    const requests = [...keys].map((flagKey) => ({
      flagKey,
      defaultValue:
        (this.flagConfigs.get(flagKey)?.defaultValue as FlagValue | undefined) ??
        false,
    }));
    const results = await this.evaluateBatch(requests);
    for (const [flagKey, result] of results) {
      const oldValue = oldValues.get(flagKey);
      if (oldValue !== undefined &&
          JSON.stringify(oldValue) === JSON.stringify(result.value)) {
        continue;
      }
      const listeners = this.flagChangeListeners.get(flagKey);
      if (!listeners) continue;
      const changeEvent: FlagChangeEvent = {
        flagKey,
        newValue: result.value,
        oldValue,
      };
      for (const listener of listeners) {
        listener(changeEvent);
      }
      for (const plugin of this.plugins) {
        plugin.onFlagChange?.(changeEvent);
      }
    }
  }

  async getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: EvaluationContext
  ): Promise<boolean> {
    const result = await this.evaluate<boolean>(flagKey, defaultValue, context);
    return result.value;
  }

  async getStringValue(
    flagKey: string,
    defaultValue: string,
    context?: EvaluationContext
  ): Promise<string> {
    const result = await this.evaluate<string>(flagKey, defaultValue, context);
    return result.value;
  }

  async getNumberValue(
    flagKey: string,
    defaultValue: number,
    context?: EvaluationContext
  ): Promise<number> {
    const result = await this.evaluate<number>(flagKey, defaultValue, context);
    return result.value;
  }

  async getObjectValue<T extends Record<string, unknown>>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): Promise<T> {
    const result = await this.evaluate<T>(
      flagKey,
      defaultValue as T & FlagValue,
      context
    );
    return result.value;
  }

  /**
   * Synchronous boolean evaluation — resolves from cache or the streamed
   * configuration without touching the network. Returns `defaultValue` when
   * neither is available. Safe to call in render loops.
   */
  getBooleanValueSync(
    flagKey: string,
    defaultValue: boolean,
    context?: EvaluationContext
  ): boolean {
    const result = this.evaluateSync<boolean>(flagKey, defaultValue, context);
    return result.value;
  }

  /**
   * Synchronous evaluation — local-only fast path. Returns the streamed or
   * cached value; falls back to `defaultValue` when neither is available
   * (caller can then use the async API to fetch remotely).
   */
  evaluateSync<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): EvaluationResult<T> {
    const mergedContext = !context
      ? this.context
      : this.hasBaseContext
        ? { ...this.context, ...context }
        : context;
    const plugins = this.plugins;
    const timed = plugins.length > 0;
    const start = timed ? performance.now() : 0;
    const local = this.tryLocalEval<T>(flagKey, mergedContext);
    const cached = local ? null : this.getCached(flagKey, context);
    const result: EvaluationResult<T> = local
      ? local
      : cached
        ? {
            value: cached.value as T,
            reason: cached.reason as EvaluationResult["reason"],
            variant: cached.variant,
          }
        : { value: defaultValue, reason: "DEFAULT" };
    // The defaultValue fallback (nothing resolved yet) is never published.
    if (local || cached) this.expose(flagKey, result, context);
    if (timed) {
      const d = performance.now() - start;
      for (const p of plugins) p.onEvaluateComplete?.(flagKey, result, d);
    }
    return result;
  }

  async evaluate<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): Promise<EvaluationResult<T>> {
    // Lazily merged — only materialize when something actually needs the
    // combined context (plugin hooks, local eval, remote eval). Cache hits
    // key off the raw context, so a hot-path hit allocates nothing.
    let mergedContext: EvaluationContext | undefined;
    const mergeContext = () =>
      (mergedContext ??= !context
        ? this.context
        : this.hasBaseContext
          ? { ...this.context, ...context }
          : context);
    const start = performance.now();

    // Notify plugins: before evaluation
    if (this.plugins.length) {
      const merged = mergeContext();
      for (const plugin of this.plugins) {
        plugin.onEvaluate?.(flagKey, merged);
      }
    }

    try {
      // Check cache
      const cached = this.getCached(flagKey, context);
      if (cached) {
        const duration = performance.now() - start;
        const result: EvaluationResult<T> = {
          value: cached.value as T,
          reason: cached.reason as EvaluationResult["reason"],
          variant: cached.variant,
        };
        this.expose(flagKey, result, context);
        for (const plugin of this.plugins) {
          plugin.onEvaluateComplete?.(flagKey, result, duration);
        }
        return result;
      }

      // Local evaluation from the streamed/bootstrap configuration — the
      // hot path: microseconds, no network, no await-worthy work.
      const local = this.tryLocalEval<T>(flagKey, mergeContext());
      if (local) {
        this.setCache(flagKey, local, context);
        this.trackVariant(flagKey, local);
        this.expose(flagKey, local, context);
        const duration = performance.now() - start;
        for (const plugin of this.plugins) {
          plugin.onEvaluateComplete?.(flagKey, local, duration);
        }
        return local;
      }

      // Check defaults
      if (this.config.defaults?.[flagKey] !== undefined) {
        const result: EvaluationResult<T> = {
          value: this.config.defaults[flagKey] as T,
          reason: "DEFAULT",
        };
        const duration = performance.now() - start;
        for (const plugin of this.plugins) {
          plugin.onEvaluateComplete?.(flagKey, result, duration);
        }
        return result;
      }

      // Remote evaluation — deduplicated so concurrent calls share one fetch.
      // Wait for remote config if it's mid-flight (bounded: fetch resolves or
      // fails quickly; the local/cached paths above never touch this).
      const version = this.contextVersion;
      await this.configReady;
      const result = await this.remoteEvaluateDeduped<T>(
        flagKey,
        defaultValue,
        mergeContext()
      );
      const duration = performance.now() - start;

      // A result for the context before a setContext reaches the caller,
      // but isn't cached, tracked or published as the new context's.
      if (version === this.contextVersion) {
        this.setCache(flagKey, result, context);
        // Track variant for outcome correlation
        this.trackVariant(flagKey, result);
        this.expose(flagKey, result, context);
      }

      // Notify plugins: after evaluation
      for (const plugin of this.plugins) {
        plugin.onEvaluateComplete?.(flagKey, result, duration);
      }

      return result;
    } catch (error) {
      const duration = performance.now() - start;

      // Notify plugins: error
      for (const plugin of this.plugins) {
        plugin.onEvaluateError?.(
          flagKey,
          error instanceof Error ? error : new Error(String(error)),
          duration
        );
      }

      return {
        value: defaultValue,
        reason: "ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Evaluate many flags with at most one network roundtrip. Flags resolvable
   * from cache or the streamed configuration never hit the network; the
   * remote-only remainder is posted to /api/flags/evaluate/batch in chunks
   * of 100 (the endpoint's per-request cap).
   */
  async evaluateBatch(
    requests: Array<{ flagKey: string; defaultValue: FlagValue }>,
    context?: EvaluationContext
  ): Promise<Map<string, EvaluationResult>> {
    // Lazy merge — skipped entirely when every flag hits cache.
    let mergedContext: EvaluationContext | undefined;
    const mergeContext = () =>
      (mergedContext ??= !context
        ? this.context
        : this.hasBaseContext
          ? { ...this.context, ...context }
          : context);
    const version = this.contextVersion;
    const results = new Map<string, EvaluationResult>();
    const remoteNeeded: Array<{ flagKey: string; defaultValue: FlagValue }> = [];

    for (const { flagKey, defaultValue } of requests) {
      const cached = this.getCached(flagKey, context);
      if (cached) {
        this.expose(flagKey, cached, context);
        results.set(flagKey, {
          value: cached.value,
          reason: cached.reason as EvaluationResult["reason"],
          variant: cached.variant,
        });
        continue;
      }
      const local = this.tryLocalEval(flagKey, mergeContext());
      if (local) {
        this.setCache(flagKey, local, context);
        this.trackVariant(flagKey, local);
        this.expose(flagKey, local, context);
        results.set(flagKey, local);
        continue;
      }
      remoteNeeded.push({ flagKey, defaultValue });
    }

    await this.configReady;

    // Chunk concurrency: bounded so a 4k-flag bootstrap doesn't fire 41
    // requests at once — 4 in flight, each up to 100 flags.
    const CHUNK_CONCURRENCY = 4;
    const chunks = [];
    for (let i = 0; i < remoteNeeded.length; i += 100) {
      chunks.push(remoteNeeded.slice(i, i + 100));
    }
    for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
      await Promise.all(chunks.slice(i, i + CHUNK_CONCURRENCY).map((chunk) => this.fetchBatchChunk(chunk, mergeContext(), context, results, version)));
    }

    return results;
  }

  private async fetchBatchChunk(
    chunk: Array<{ flagKey: string; defaultValue: FlagValue }>,
    mergedContext: EvaluationContext,
    context: EvaluationContext | undefined,
    results: Map<string, EvaluationResult>,
    /** contextVersion when the batch started (see evaluate's remote path). */
    version: number
  ): Promise<void> {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.config.apiKey) {
          headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }
        const response = await this.trackedFetch(`${this.config.apiUrl}/api/flags/evaluate/batch`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            serviceId: this.config.serviceId,
            environment: this.config.environment,
            context: mergedContext,
            // Both batch APIs' requests in one body, each ignoring the
            // other's field: the data plane (the default apiUrl) reads
            // flagKeys, and rejects a duplicate key; the control plane
            // reads flags.
            flagKeys: [...new Set(chunk.map((f) => f.flagKey))],
            flags: chunk.map((f) => ({ key: f.flagKey, defaultValue: f.defaultValue })),
          }),
        });
        if (!response.ok) {
          throw new Error(`Batch evaluation failed: HTTP ${response.status}`);
        }
        // The data plane answers with a map of flag key → result, the
        // control plane with a list of results: Object.values reads both.
        const data = (await response.json()) as {
          flags?: BatchResult[] | Record<string, BatchResult>;
        };
        const returned = new Map(Object.values(data.flags ?? {}).map((f) => [f.key ?? f.flagKey, f]));
        for (const { flagKey, defaultValue } of chunk) {
          const remote = returned.get(flagKey);
          const result: EvaluationResult = remote
            ? {
                value: (remote.value ?? defaultValue) as FlagValue,
                reason: (remote.reason as EvaluationResult["reason"]) ?? "STATIC",
                variant: remote.variant,
              }
            : { value: defaultValue, reason: "ERROR", errorMessage: "Flag missing from batch response" };
          if (version === this.contextVersion) {
            this.setCache(flagKey, result, context);
            this.trackVariant(flagKey, result);
            this.expose(flagKey, result, context);
          }
          results.set(flagKey, result);
        }
      } catch (error) {
        for (const { flagKey, defaultValue } of chunk) {
          results.set(flagKey, {
            value: defaultValue,
            reason: "ERROR",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
  }

  setContext(context: EvaluationContext): void {
    this.context = context;
    this.contextVersion++;
    this.hasBaseContext = Object.keys(context).length > 0;
    // Invalidate cache on context change
    this.cache.clear();
    // The flags the page uses (watched, or published by this client) may
    // resolve differently under the new context. What this client published
    // is forgotten (its keys are kept, see forgetFlags), so each flag's next
    // evaluation is published again, even when its value didn't change.
    // Local-eval flags get that evaluation now: republished, and their
    // listeners hear the new value. Not a flag the page published with a
    // per-call context (and doesn't watch): the base context alone isn't
    // what the page evaluates it with.
    forgetFlags(this.exposed);
    for (const [flagKey, flag] of this.flagConfigs) {
      const listeners = this.flagChangeListeners.get(flagKey);
      if (
        (!listeners && (!this.exposed.has(flagKey) || this.perCall.has(flagKey))) ||
        !isLocallyEvaluable(flag)
      ) continue;
      const next = Evaluator.evaluate(flag, context);
      this.expose(flagKey, next); // in use, so no `pushed` check needed
      // No previous value is tracked post-clear; notify with the new value.
      const changeEvent: FlagChangeEvent = { flagKey, newValue: next.value };
      for (const listener of listeners ?? []) {
        listener(changeEvent);
      }
    }
  }

  onFlagChange(
    flagKey: string,
    listener: (event: FlagChangeEvent) => void
  ): () => void {
    if (!this.flagChangeListeners.has(flagKey)) {
      this.flagChangeListeners.set(flagKey, new Set());
    }
    this.flagChangeListeners.get(flagKey)!.add(listener);

    return () => {
      this.flagChangeListeners.get(flagKey)?.delete(listener);
    };
  }

  onConnectionStateChange(
    listener: (state: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  async refresh(): Promise<void> {
    this.cache.clear();
  }

  /** Current configuration version reported by the stream, if connected. */
  getConfigurationVersion(): string | undefined {
    return this.configVersion;
  }

  /** Number of flag configurations held for local evaluation. */
  get localFlagCount(): number {
    return this.flagConfigs.size;
  }

  async trackOutcome(event: OutcomeEvent): Promise<void> {
    const variant =
      this.lastEvaluatedVariants.get(event.flagKey) || "unknown";
    const body = JSON.stringify({
      flagKey: event.flagKey,
      variant,
      eventName: event.eventName,
      eventValue: event.eventValue,
      userId: event.userId,
      serviceId: this.config.serviceId,
      environment: this.config.environment || "production",
      projectId: "",
    });

    try {
      // sendBeacon never blocks the page and survives unload
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const sent = navigator.sendBeacon(
          `${this.config.apiUrl}/api/events/outcomes`,
          new Blob([body], { type: "application/json" })
        );
        if (sent) return;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      await fetch(`${this.config.apiUrl}/api/events/outcomes`, {
        method: "POST",
        headers,
        body,
        keepalive: true,
      });
    } catch {
      // Outcome tracking is best-effort; never throw
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stream?.close();
    this.stream = null;
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    this.cache.clear();
    this.flagConfigs.clear();
    this.flagChangeListeners.clear();
    this.connectionListeners.clear();

    for (const plugin of this.plugins) {
      plugin.onDestroy?.();
    }
  }

  // --- Private methods ---

  /**
   * Evaluate locally against the streamed configuration. Returns null when
   * no config is held or the flag uses operators only the data plane
   * implements.
   */
  private tryLocalEval<T extends FlagValue>(
    flagKey: string,
    context?: EvaluationContext
  ): EvaluationResult<T> | null {
    const flag = this.flagConfigs.get(flagKey);
    if (!flag || !isLocallyEvaluable(flag)) return null;
    const merged = !context ? this.context
      : this.hasBaseContext ? { ...this.context, ...context }
      : context;
    const result = Evaluator.evaluate(flag, merged);
    return {
      value: result.value as T,
      reason: result.reason as EvaluationResult["reason"],
      variant: result.variant,
    };
  }

  /**
   * Fetch wrapper reporting request timing + wire size to `onRequest`
   * plugins — powers latency/network instrumentation without globals.
   */
  private async trackedFetch(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const start = performance.now();
    const requestBytes =
      typeof init.body === "string" ? init.body.length : 0;
    try {
      const response = await fetch(url, init);
      const responseBytes = response.headers?.get
        ? Number(response.headers.get("content-length") ?? 0)
        : 0;
      for (const plugin of this.plugins) {
        plugin.onRequest?.({
          url,
          durationMs: Math.round(performance.now() - start),
          ok: response.ok,
          requestBytes,
          responseBytes: Number.isFinite(responseBytes) ? responseBytes : 0,
        });
      }
      return response;
    } catch (error) {
      for (const plugin of this.plugins) {
        plugin.onRequest?.({
          url,
          durationMs: Math.round(performance.now() - start),
          ok: false,
          requestBytes,
          responseBytes: 0,
        });
      }
      throw error;
    }
  }

  private trackVariant(flagKey: string, result: EvaluationResult): void {
    const v = result.variant ?? String(result.value);
    if (this.lastEvaluatedVariants.get(flagKey) !== v) {
      this.lastEvaluatedVariants.set(flagKey, v);
    }
  }

  /**
   * Publish a value Flaggr resolved to the page for browser analytics (see
   * `FlaggrConfig.exposeFlags`). Skipped: results for someone else, when the
   * client has a targetingKey and a per-call `context` gives another one, or
   * clears it; and results that only carry the caller's fallback (reason
   * ERROR). A flag that doesn't exist (NOT_FOUND, FLAG_NOT_FOUND) is taken
   * off the page. `pushed` values (stream, context change) count only for
   * flags the page already uses: published before, or watched by a listener.
   */
  private expose(
    flagKey: string,
    result: { value: FlagValue; reason: string; variant?: string },
    context?: EvaluationContext | null,
    pushed?: boolean
  ): void {
    const own = this.context.targetingKey;
    if (
      !this.exposeFlags ||
      (own && (context && "targetingKey" in context ? context.targetingKey : own) !== own)
    ) return;
    if (/NOT_FOUND/.test(result.reason)) {
      // Deleted, or never existed: the page gets the fallback from now on.
      withdrawFlag(this.exposed, flagKey);
    } else if (
      !/ERROR/.test(result.reason) &&
      (!pushed || this.exposed.has(flagKey) || this.flagChangeListeners.has(flagKey))
    ) {
      exposeFlag(this.exposed, flagKey, result.value, result.variant);
      // setContext re-evaluates only flags published for the client's own context.
      if (context) this.perCall.add(flagKey);
      else this.perCall.delete(flagKey);
    }
  }

  private remoteEvaluateDeduped<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext
  ): Promise<EvaluationResult<T>> {
    // Key includes the context — different targeting inputs must not share
    // a response. WeakMap-memoized so the same context object is free.
    const dedupeKey = this.cacheKeyFor(flagKey, context);
    const pending = this.inflight.get(dedupeKey);
    if (pending) {
      return pending as Promise<EvaluationResult<T>>;
    }
    const request = this.remoteEvaluate<T>(flagKey, defaultValue, context)
      .finally(() => {
        this.inflight.delete(dedupeKey);
      });
    this.inflight.set(dedupeKey, request as Promise<EvaluationResult>);
    return request;
  }

  private async remoteEvaluate<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext
  ): Promise<EvaluationResult<T>> {
    const url = `${this.config.apiUrl}/api/flags/evaluate`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const response = await this.trackedFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        flagKey,
        serviceId: this.config.serviceId,
        environment: this.config.environment,
        context,
        defaultValue,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Unauthorized: invalid or missing API key");
      }
      throw new Error(`Evaluation failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    return {
      value: (data.value ?? defaultValue) as T,
      reason: data.reason ?? "STATIC",
      variant: data.variant,
    };
  }

  /**
   * Cache key including a per-call context fingerprint when one is supplied.
   * Without it, a result evaluated for context A would be served to context
   * B. The base context (`setContext`) doesn't need keying — it clears the
   * whole cache on change.
   */
  private cacheKeyFor(flagKey: string, context?: EvaluationContext): string {
    if (!context) return flagKey;
    let k = this.contextKeys.get(context);
    if (k === undefined) {
      k = `|${JSON.stringify(context)}`;
      this.contextKeys.set(context, k);
    }
    return flagKey + k;
  }

  /** Remove a flag's cached entries across all context variants. */
  private deleteFlagCacheEntries(flagKey: string): void {
    this.cache.delete(flagKey);
    const prefix = `${flagKey}|`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private getCached(flagKey: string, context?: EvaluationContext): CacheEntry | null {
    const key = this.cacheKeyFor(flagKey, context);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  private setCache(flagKey: string, result: EvaluationResult, context?: EvaluationContext): void {
    this.cache.set(this.cacheKeyFor(flagKey, context), {
      value: result.value,
      reason: result.reason,
      variant: result.variant,
      expiresAt: Date.now() + this.config.cacheTtl,
    });
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;

    for (const listener of this.connectionListeners) {
      listener(state);
    }
    for (const plugin of this.plugins) {
      plugin.onConnectionStateChange?.(state);
    }
  }

  /**
   * Replace the held configuration and notify listeners of value changes.
   * Accepts the data-plane wire shape (`flags` array) or a keyed record.
   */
  private applyConfiguration(
    payload: ConfigurationSyncPayload,
    opts: { persist?: boolean } = {}
  ): void {
    if (!payload || payload.flags == null) return;

    const next = new Map<string, FlagConfig>();
    const incoming = Array.isArray(payload.flags)
      ? payload.flags
      : Object.values(payload.flags);
    for (const flag of incoming) {
      if (flag && typeof flag.key === "string") {
        next.set(flag.key, flag);
      }
    }
    if (payload.version) this.configVersion = payload.version;
    // A published flag the previous configuration had and this one doesn't
    // was deleted (say while the stream was down): off the page.
    for (const flagKey of this.exposed.keys()) {
      if (this.flagConfigs.has(flagKey) && !next.has(flagKey)) withdrawFlag(this.exposed, flagKey);
    }
    this.flagConfigs = next;
    if (opts.persist !== false && this.config.remoteConfig) {
      this.persistFlagSnapshot(this.config.environment, this.persistScope, this.configVersion);
    }

    // Re-evaluate flags that have listeners or cached values — fire only on
    // real value changes, not on every sync.
    for (const [flagKey, flag] of next) {
      this.refreshCachedFlag(flagKey, flag);
    }

    // Flags removed from the configuration must not serve stale values.
    // Context-variant keys are `flagKey|{...}` — compare on the base key.
    for (const cacheKey of [...this.cache.keys()]) {
      const pipeIndex = cacheKey.indexOf("|");
      const baseKey = pipeIndex === -1 ? cacheKey : cacheKey.slice(0, pipeIndex);
      if (!next.has(baseKey)) {
        this.cache.delete(cacheKey);
      }
    }
  }

  /**
   * Merge a `configuration_delta` into the held configuration: changed flags
   * replace their entries, removed keys are dropped entirely. Cheaper than a
   * full sync — the wire payload only carries what changed.
   */
  private applyConfigurationDelta(payload: {
    flags?: FlagConfig[];
    removed?: string[];
    version?: string;
  }): void {
    if (payload.version) this.configVersion = payload.version;
    for (const flag of payload.flags ?? []) {
      if (flag && typeof flag.key === "string") {
        this.flagConfigs.set(flag.key, flag);
        this.refreshCachedFlag(flag.key, flag);
      }
    }
    for (const flagKey of payload.removed ?? []) {
      this.flagConfigs.delete(flagKey);
      this.deleteFlagCacheEntries(flagKey);
      withdrawFlag(this.exposed, flagKey);
    }
    if (this.config.remoteConfig) {
      this.persistFlagSnapshot(this.config.environment, this.persistScope, this.configVersion);
    }
  }

  /**
   * Re-evaluate one flag against its new config and notify listeners/plugins
   * only when the resolved value actually changed.
   */
  private refreshCachedFlag(flagKey: string, flag: FlagConfig): void {
    const hasListeners = this.flagChangeListeners.has(flagKey);
    const cached = this.cache.get(flagKey);
    if (!hasListeners && !cached) return;
    if (!isLocallyEvaluable(flag)) {
      // Remote-only flag: drop all cached values so next eval refetches.
      this.deleteFlagCacheEntries(flagKey);
      return;
    }
    const evaluated = Evaluator.evaluate(flag, this.context);
    const changed =
      !cached || JSON.stringify(cached.value) !== JSON.stringify(evaluated.value);
    // Config changed — context-variant entries are stale.
    this.deleteFlagCacheEntries(flagKey);
    this.setCache(flagKey, {
      value: evaluated.value,
      reason: evaluated.reason,
      variant: evaluated.variant,
    });
    this.expose(flagKey, evaluated, null, true);
    if (changed && hasListeners) {
      const changeEvent: FlagChangeEvent = {
        flagKey,
        newValue: evaluated.value,
        oldValue: cached?.value,
      };
      for (const listener of this.flagChangeListeners.get(flagKey)!) {
        listener(changeEvent);
      }
      for (const plugin of this.plugins) {
        plugin.onFlagChange?.(changeEvent);
      }
    }
  }

  private connectSSE(): void {
    if (this.destroyed) return;

    const params = new URLSearchParams({
      serviceId: this.config.serviceId,
    });
    if (this.config.environment) {
      params.set("environment", this.config.environment);
    }
    const url = `${this.config.apiUrl}/api/flags/stream?${params}`;

    if (this.config.apiKey) {
      // The key goes in the Authorization header, never in the URL, where
      // request logs keep it. EventSource can't send headers (and the data
      // plane reads only the Authorization header), so stream over fetch.
      const stream = openEventStream({
        url,
        headers: () => ({ Authorization: `Bearer ${this.config.apiKey}` }),
        onOpen: () => this.setConnectionState(CS.CONNECTED),
        onEvent: (event) => this.handleStreamEvent(event.type, event.data),
        onError: (error) => {
          if (this.stream !== stream) return;
          this.setConnectionState(CS.ERROR);
          if (error.willRetry) return;
          // Refused (401/403), or this runtime can't stream: reconnecting
          // won't help — refresh watched flags by polling instead.
          this.stream = null;
          this.startPollingFallback();
        },
      });
      this.stream = stream;
      return;
    }

    // Keyless streams (e.g. public demo services) keep EventSource.
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(url);
    this.stream = source;

    source.onopen = () => {
      this.setConnectionState(CS.CONNECTED);
    };

    // The data plane emits named events; onmessage never fires for those.
    source.addEventListener("configuration_sync", (event) => {
      this.handleStreamEvent("configuration_sync", (event as MessageEvent).data);
    });
    // Incremental updates — carries only changed/removed flags.
    source.addEventListener("configuration_delta", (event) => {
      this.handleStreamEvent("configuration_delta", (event as MessageEvent).data);
    });
    // Legacy/heartbeat events and control-plane flag-update messages arrive
    // as unnamed events on onmessage.
    source.onmessage = (event) => {
      this.handleStreamEvent("message", event.data);
    };

    source.onerror = () => {
      this.setConnectionState(CS.ERROR);
      // EventSource auto-reconnects
    };
  }

  /**
   * Stream fallback: the stream was refused or can't run, so refresh watched
   * flags on the batch cadence. A mode switch or destroy() stops it.
   */
  private startPollingFallback(): void {
    if (this.destroyed || this.batchTimer) return;
    const interval = this.config.batchIntervalMs ?? 2000;
    this.batchTimer = setInterval(() => {
      void this.refreshWatchedFlags();
    }, interval);
    void this.refreshWatchedFlags();
  }

  /**
   * One stream event, from either transport: configuration_sync and
   * configuration_delta (data plane), unnamed messages (control-plane
   * flag-update / legacy value pushes). Other named events (heartbeat) carry
   * nothing to apply.
   */
  private handleStreamEvent(type: string, data: string): void {
    try {
      if (type === "configuration_sync") {
        this.applyConfiguration(JSON.parse(data) as ConfigurationSyncPayload);
      } else if (type === "configuration_delta") {
        this.applyConfigurationDelta(JSON.parse(data));
      } else if (type === "message") {
        this.handleStreamMessage(JSON.parse(data));
      }
    } catch {
      // Ignore parse errors from SSE
    }
  }

  private handleStreamMessage(data: {
    type?: string;
    flagKey?: string;
    flag?: unknown;
    eventType?: string;
    value?: FlagValue;
    reason?: string;
    variant?: string;
  }): void {
    if (data.type === "flag-update" && data.flagKey) {
      if (data.flag && data.eventType !== "DELETED") {
        // Control plane forwarded the full config — update the local
        // store in place so local eval keeps working; listeners fire
        // only on real value changes.
        const flag = data.flag as FlagConfig;
        this.flagConfigs.set(data.flagKey, flag);
        this.refreshCachedFlag(data.flagKey, flag);
        if (this.config.remoteConfig) {
          this.persistFlagSnapshot(this.config.environment, this.persistScope, this.configVersion);
        }
      } else {
        // No config payload (or a deletion): drop stale state so the
        // next eval refetches remotely.
        this.deleteFlagCacheEntries(data.flagKey);
        this.flagConfigs.delete(data.flagKey);
        // A deleted flag comes off the page. Any other change leaves the
        // value: the page shows it until it evaluates the flag again.
        if (data.eventType === "DELETED") withdrawFlag(this.exposed, data.flagKey);
        const listeners = this.flagChangeListeners.get(data.flagKey);
        if (listeners) {
          const changeEvent: FlagChangeEvent = { flagKey: data.flagKey, newValue: data.value as FlagValue };
          for (const listener of listeners) {
            listener(changeEvent);
          }
        }
        for (const plugin of this.plugins) {
          plugin.onFlagChange?.({ flagKey: data.flagKey, newValue: data.value as FlagValue });
        }
      }
    } else if (data.flagKey) {
      const changeEvent: FlagChangeEvent = {
        flagKey: data.flagKey,
        newValue: data.value as FlagValue,
        oldValue: this.cache.get(data.flagKey)?.value,
      };

      // Update cache
      const result: EvaluationResult = {
        value: data.value as FlagValue,
        reason: (data.reason as EvaluationResult["reason"]) ?? "STATIC",
        variant: data.variant,
      };
      this.setCache(data.flagKey, result);
      this.expose(data.flagKey, result, null, true);

      // Notify listeners
      const listeners = this.flagChangeListeners.get(data.flagKey);
      if (listeners) {
        for (const listener of listeners) {
          listener(changeEvent);
        }
      }

      // Notify plugins
      for (const plugin of this.plugins) {
        plugin.onFlagChange?.(changeEvent);
      }
    }
  }
}
