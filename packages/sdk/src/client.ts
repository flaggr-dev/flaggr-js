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
import { appBaseUrl } from "./app-url";
import { openEventStream } from "./event-stream";
import { exposeFlag, forgetFlags, shouldExpose, withdrawFlag } from "./expose-flags";
import { postWithKeepalive } from "./keepalive";

/**
 * The most (flag, targetingKey) variants a client keeps for trackOutcome. A
 * server evaluating flags for many users would otherwise grow the map without
 * bound; past this, the least recently evaluated pair is dropped.
 */
const MAX_TRACKED_VARIANTS = 10_000;

/** lastEvaluatedVariants key: a flag and the targeting key it was evaluated for ("" for none). */
function variantKey(flagKey: string, targetingKey: unknown): string {
  return `${flagKey}\u0000${targetingKey === undefined || targetingKey === null ? "" : String(targetingKey)}`;
}

/** Whether a per-call context sets anything: `{}` evaluates as the client's own context. */
function hasKeys(context: EvaluationContext | undefined): context is EvaluationContext {
  if (!context) return false;
  for (const key in context) {
    if (Object.prototype.hasOwnProperty.call(context, key)) return true;
  }
  return false;
}

/** The plugin hooks the client calls as it evaluates, requests and updates (not onInit, onDestroy). */
type PluginEvent =
  | "onEvaluate"
  | "onEvaluateComplete"
  | "onEvaluateError"
  | "onFlagChange"
  | "onConnectionStateChange"
  | "onRequest";

/**
 * The most plugin hook calls a client created with `{ start: false }` holds
 * for start() (see callPlugins); past this, later ones are dropped.
 */
const MAX_PENDING_PLUGIN_CALLS = 1_000;

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
  /** start() has run: plugins initialised, remote config and update delivery begun. */
  private started = false;
  /** The config as the caller gave it: its fields win over remote config. */
  private explicitConfig: FlaggrConfig;
  /** Settles when remote SDK config has been applied (or skipped/failed) */
  private configReady: Promise<void>;
  /** Settles configReady of a client created with `{ start: false }` once start() (or destroy()) runs. */
  private releaseConfigReady?: () => void;
  private updateMode: UpdateMode;
  /** Auth scope for the persisted flag snapshot — "anon" or key hash. */
  private persistScope: string;
  /** Refreshes watched flags every batchIntervalMs: batch mode's, or the stream's polling fallback. */
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  /** batchTimer is the stream's polling fallback (startPollingFallback), not batch mode's. */
  private pollingFallback = false;
  /**
   * Plugin hook calls made before start(), delivered once start() has called
   * the plugins' onInit (see callPlugins).
   */
  private pendingPluginCalls: Array<[PluginEvent, unknown[]]> = [];
  /**
   * The last evaluated variant per flag and targeting key (variantKey), for
   * outcome event correlation; at most MAX_TRACKED_VARIANTS, oldest first.
   */
  private lastEvaluatedVariants: Map<string, string> = new Map();
  /**
   * Flags the app evaluated with the client's own context (no per-call
   * context). A live update of such a flag (stream sync, batch refresh,
   * setContext, a pushed value) changes what the app shows, so its variant is
   * tracked for trackOutcome. Not a flag only watched, say by a hook with a
   * per-call context: its value for the client's own context is nobody's.
   */
  private ownEvaluated = new Set<string>();
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

  /**
   * @param options.start `false` creates the client without side effects:
   * no plugin `onInit`, remote config fetch, stream or timer until
   * `start()`. FlaggrProvider does this so a render React discards (Strict
   * Mode renders twice; a server render never commits) leaves nothing
   * running. Default: start now.
   */
  constructor(config: FlaggrConfig, options: { start?: boolean } = {}) {
    this.config = {
      apiUrl: "https://api.flaggr.dev",
      cacheTtl: 10_000,
      enableStreaming: false,
      ...config,
    };
    this.explicitConfig = config;
    this.exposeFlags = shouldExpose(config.exposeFlags);
    this.plugins = config.plugins ?? [];
    this.context = config.context ?? {};
    this.hasBaseContext = Object.keys(this.context).length > 0;
    // Auth scope of the persisted flag snapshot: set before the bootstrap
    // below, which persists one when remoteConfig is on.
    this.persistScope = this.config.apiKey
      ? `k${fnv32(this.config.apiKey)}`
      : "anon";

    // Seed from a bootstrap configuration so first paint never hits network
    if (config.bootstrap) {
      this.applyConfiguration(config.bootstrap as ConfigurationSyncPayload);
    }

    this.updateMode =
      config.updateMode ?? (config.enableStreaming ? "stream" : "poll");

    if (options.start === false) {
      // A remote evaluation waits for start(), which fetches the remote config.
      this.configReady = this.config.remoteConfig
        ? new Promise<void>((resolve) => (this.releaseConfigReady = resolve))
        : Promise.resolve();
      return;
    }
    this.configReady = Promise.resolve();
    this.start();
  }

  /**
   * Start a client created with `{ start: false }`: initialise its plugins,
   * fetch the remote config (`remoteConfig`) and open its update delivery
   * (the stream, or the batch timer). Runs once; does nothing after
   * destroy(). A client created without that option starts in its
   * constructor.
   */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;

    // Notify plugins of initialization
    for (const plugin of this.plugins) {
      plugin.onInit?.(this);
    }
    // Then what the client did before start(): FlaggrProvider's children
    // evaluate while rendering and in their effects, which run before the
    // provider's effect starts its client. A plugin hears nothing before its
    // onInit, as with a client that starts in its constructor.
    const pending = this.pendingPluginCalls;
    this.pendingPluginCalls = [];
    for (const [hook, args] of pending) this.deliverPluginCall(hook, args);

    // Remote config fetch — fills unset fields from GET /api/sdk-config
    // before the first remote eval; localStorage SWR keeps repeat loads free.
    if (this.config.remoteConfig) {
      const loaded = this.loadRemoteConfig(this.explicitConfig);
      this.configReady = loaded;
      const release = this.releaseConfigReady;
      this.releaseConfigReady = undefined;
      if (release) loaded.then(release, release);
    }

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
      // Destroyed while the config was on its way (FlaggrProvider under
      // React Strict Mode destroys its first client at once): starting a
      // transport or a plugin now would leave it running for good.
      if (this.destroyed) return;
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
      if (explicit.cacheTtl === undefined && sdk.cacheTtlMs) {
        this.config.cacheTtl = sdk.cacheTtlMs;
      }
      // Before the update mode below: its batch timer runs at this interval.
      let newInterval = false;
      if (
        explicit.batchIntervalMs === undefined &&
        sdk.batchIntervalMs &&
        sdk.batchIntervalMs !== this.config.batchIntervalMs
      ) {
        this.config.batchIntervalMs = sdk.batchIntervalMs;
        newInterval = true;
      }
      if (explicit.updateMode === undefined && sdk.updateMode) {
        this.updateMode = sdk.updateMode;
        this.applyUpdateMode(sdk.updateMode);
      } else if (newInterval && this.batchTimer) {
        // Only the interval changed: the running timer (batch mode's, or
        // the stream's polling fallback) takes it up.
        this.scheduleBatchTimer();
      }
      // Remote telemetry opt-in — attach the plugin lazily if the service
      // config asks for it and the caller didn't already provide one.
      if (sdk.telemetry && !this.plugins.some((p) => p.name === "flaggr-telemetry")) {
        void import("./telemetry")
          .then(({ flaggrTelemetry }) => {
            if (this.destroyed) return;
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
        `${appBaseUrl(this.config.apiUrl)}/api/sdk-config?${params}`,
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
    // Not started yet: start() opens this mode's transport.
    if (this.started) this.applyUpdateMode(mode);
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
    this.stopBatchTimer();
    // A destroyed client opens nothing (remote config can name a mode after destroy()).
    if (this.destroyed) return;

    if (mode === "stream") {
      this.connectSSE();
    } else if (mode === "batch") {
      this.scheduleBatchTimer();
      // Catch up immediately on switch instead of waiting a full tick.
      void this.refreshWatchedFlags();
    }
  }

  /** (Re)start batchTimer at the current batchIntervalMs (default 2000). */
  private scheduleBatchTimer(): void {
    if (this.batchTimer) clearInterval(this.batchTimer);
    this.batchTimer = setInterval(() => {
      void this.refreshWatchedFlags();
    }, this.config.batchIntervalMs ?? 2000);
  }

  private stopBatchTimer(): void {
    if (this.batchTimer) clearInterval(this.batchTimer);
    this.batchTimer = null;
    this.pollingFallback = false;
  }

  /**
   * Batch-mode refresh (and refresh()): one POST covers every flag the app
   * actually uses — watched via listeners or cached for the client's own
   * context — instead of a request per flag, evaluated with the client's own
   * context. Their cache entries are dropped first so the batch revalidates
   * rather than short-circuiting on the TTL; listeners fire on observed
   * changes. A result without a value of its own (ERROR: the request failed
   * or the answer left the flag out; NOT_FOUND, FLAG_NOT_FOUND) is neither
   * cached nor announced.
   *
   * Results cached for per-call contexts are dropped, and go to the network
   * again at their next call. A flag cached only for per-call contexts, and
   * not watched, isn't evaluated: its value for the client's own context is
   * nobody's to announce or publish (as with setContext).
   */
  private async refreshWatchedFlags(): Promise<void> {
    const keys = new Set<string>(this.flagChangeListeners.keys());
    // What the listeners last heard: the entry for the client's own context,
    // which the refresh evaluates with. Never a per-call context's value.
    const oldValues = new Map<string, FlagValue>();
    for (const [cacheKey, entry] of this.cache) {
      if (cacheKey.includes("|")) continue; // a per-call context's
      keys.add(cacheKey);
      oldValues.set(cacheKey, entry.value);
    }
    for (const cacheKey of [...this.cache.keys()]) {
      if (cacheKey.includes("|") || keys.has(cacheKey)) this.cache.delete(cacheKey);
    }
    if (keys.size === 0) return;
    const requests = [...keys].map((flagKey) => ({
      flagKey,
      defaultValue:
        (this.flagConfigs.get(flagKey)?.defaultValue as FlagValue | undefined) ??
        false,
    }));
    const results = await this.evaluateMany(requests, undefined, true);
    for (const [flagKey, result] of results) {
      if (result.reason === "ERROR" || /NOT_FOUND/.test(result.reason)) {
        // No value of its own: only the default this refresh asked with (it
        // doesn't know the callers'). Not served from the cache — the next
        // evaluation asks again, with its own default — nor announced.
        this.cache.delete(flagKey);
        continue;
      }
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
      this.callPlugins("onFlagChange", changeEvent);
    }
  }

  /**
   * Call a plugin hook on every plugin. Before start() (a client created
   * with `{ start: false }`), the call waits for start() to call the
   * plugins' onInit, then comes in order with the others; a client
   * destroyed before start() never calls its plugins.
   */
  private callPlugins<K extends PluginEvent>(
    hook: K,
    ...args: Parameters<NonNullable<FlaggrPlugin[K]>>
  ): void {
    if (this.plugins.length === 0) return;
    if (this.started) {
      this.deliverPluginCall(hook, args);
    } else if (!this.destroyed && this.pendingPluginCalls.length < MAX_PENDING_PLUGIN_CALLS) {
      this.pendingPluginCalls.push([hook, args]);
    }
  }

  private deliverPluginCall(hook: PluginEvent, args: unknown[]): void {
    for (const plugin of this.plugins) {
      (plugin[hook] as ((...hookArgs: unknown[]) => void) | undefined)?.apply(plugin, args);
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

  async getObjectValue<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): Promise<T> {
    const result = await this.evaluate<T & FlagValue>(
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
   * The value an evaluation falls back to: the flag's `defaults` entry when
   * the config has one, else the caller's `defaultValue`.
   */
  private fallbackFor<T extends FlagValue>(flagKey: string, defaultValue: T): T {
    const entry = this.config.defaults?.[flagKey];
    return entry !== undefined ? (entry as T) : defaultValue;
  }

  /**
   * Synchronous evaluation — local-only fast path. Returns the streamed or
   * cached value; falls back to the flag's `defaults` entry, else
   * `defaultValue`, when neither is available (caller can then use the
   * async API to fetch remotely).
   */
  evaluateSync<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): EvaluationResult<T> {
    if (!hasKeys(context)) this.ownEvaluated.add(flagKey);
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
        : { value: this.fallbackFor(flagKey, defaultValue), reason: "DEFAULT" };
    // The fallback (nothing resolved yet) is never published.
    if (local || cached) this.expose(flagKey, result, context);
    if (timed) {
      this.callPlugins("onEvaluateComplete", flagKey, result, performance.now() - start);
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
    if (!hasKeys(context)) this.ownEvaluated.add(flagKey);

    // Notify plugins: before evaluation
    if (this.plugins.length) {
      this.callPlugins("onEvaluate", flagKey, mergeContext());
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
        this.callPlugins("onEvaluateComplete", flagKey, result, duration);
        return result;
      }

      // Local evaluation from the streamed/bootstrap configuration — the
      // hot path: microseconds, no network, no await-worthy work.
      const local = this.tryLocalEval<T>(flagKey, mergeContext());
      if (local) {
        this.setCache(flagKey, local, context);
        this.trackVariant(flagKey, local, context);
        this.expose(flagKey, local, context);
        const duration = performance.now() - start;
        this.callPlugins("onEvaluateComplete", flagKey, local, duration);
        return local;
      }

      // Remote evaluation — deduplicated so concurrent calls share one fetch.
      // Wait for remote config if it's mid-flight (bounded: fetch resolves or
      // fails quickly; the local/cached paths above never touch this). A
      // `defaults` entry is only the fallback: the flag is evaluated all the
      // same, and the entry stands in for defaultValue (not found, failure).
      const version = this.contextVersion;
      await this.configReady;
      const result = await this.remoteEvaluateDeduped<T>(
        flagKey,
        this.fallbackFor(flagKey, defaultValue),
        mergeContext()
      );
      const duration = performance.now() - start;

      // A result for the context before a setContext reaches the caller,
      // but isn't cached, tracked or published as the new context's.
      if (version === this.contextVersion) {
        this.setCache(flagKey, result, context);
        // Track variant for outcome correlation
        this.trackVariant(flagKey, result, context);
        this.expose(flagKey, result, context);
      }

      // Notify plugins: after evaluation
      this.callPlugins("onEvaluateComplete", flagKey, result, duration);

      return result;
    } catch (error) {
      const duration = performance.now() - start;

      // Notify plugins: error
      this.callPlugins(
        "onEvaluateError",
        flagKey,
        error instanceof Error ? error : new Error(String(error)),
        duration
      );

      return {
        value: this.fallbackFor(flagKey, defaultValue),
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
    if (!hasKeys(context)) {
      for (const { flagKey } of requests) this.ownEvaluated.add(flagKey);
    }
    return this.evaluateMany(requests, context, false);
  }

  /**
   * evaluateBatch, and refreshWatchedFlags' batch (`refresh`): a refresh
   * tracks the variants (trackVariant) only of the flags the app evaluated
   * with the client's own context (ownEvaluated).
   */
  private async evaluateMany(
    requests: Array<{ flagKey: string; defaultValue: FlagValue }>,
    context: EvaluationContext | undefined,
    refresh: boolean
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
        if (!refresh || this.ownEvaluated.has(flagKey)) this.trackVariant(flagKey, local, context);
        this.expose(flagKey, local, context);
        results.set(flagKey, local);
        continue;
      }
      // A `defaults` entry stands in for defaultValue, as in evaluate().
      remoteNeeded.push({ flagKey, defaultValue: this.fallbackFor(flagKey, defaultValue) });
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
      await Promise.all(chunks.slice(i, i + CHUNK_CONCURRENCY).map((chunk) => this.fetchBatchChunk(chunk, mergeContext(), context, results, version, refresh)));
    }

    return results;
  }

  private async fetchBatchChunk(
    chunk: Array<{ flagKey: string; defaultValue: FlagValue }>,
    mergedContext: EvaluationContext,
    context: EvaluationContext | undefined,
    results: Map<string, EvaluationResult>,
    /** contextVersion when the batch started (see evaluate's remote path). */
    version: number,
    /** refreshWatchedFlags' batch (see evaluateMany). */
    refresh: boolean
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
          if (response.status === 401 || response.status === 403) this.batchRefused();
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
            if (!refresh || this.ownEvaluated.has(flagKey)) this.trackVariant(flagKey, result, context);
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
      // The value the app now shows for this flag: what an outcome goes to.
      if (this.ownEvaluated.has(flagKey)) this.trackVariant(flagKey, next as EvaluationResult);
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

  /**
   * Re-evaluate everything cached or watched, in one batch, and notify the
   * listeners of what changed (see FlaggrClientInstance.refresh).
   */
  async refresh(): Promise<void> {
    if (this.destroyed) return;
    await this.refreshWatchedFlags();
  }

  /** Current configuration version reported by the stream, if connected. */
  getConfigurationVersion(): string | undefined {
    return this.configVersion;
  }

  /** Number of flag configurations held for local evaluation. */
  get localFlagCount(): number {
    return this.flagConfigs.size;
  }

  /**
   * POST the outcome to the Flaggr app's /api/events/outcomes, which stores
   * outcomes (appBaseUrl: https://flaggr.dev when apiUrl is the hosted data
   * plane), with the apiKey as a bearer: the route refuses a request without
   * one (401). Never navigator.sendBeacon, which can't carry that header: a
   * keepalive fetch, which outlives the page as a beacon does (a pagehide
   * handler can track an outcome), when the body fits the page's 64 KiB
   * keepalive budget (one event takes a few hundred bytes), else a plain
   * fetch.
   */
  async trackOutcome(event: OutcomeEvent): Promise<void> {
    try {
      const body = JSON.stringify({
        flagKey: event.flagKey,
        variant: this.outcomeVariant(event),
        eventName: event.eventName,
        eventValue: event.eventValue,
        userId: event.userId,
        serviceId: this.config.serviceId,
        environment: this.config.environment || "production",
        projectId: "",
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      await postWithKeepalive(`${appBaseUrl(this.config.apiUrl)}/api/events/outcomes`, headers, body);
    } catch {
      // Outcome tracking is best-effort; never throw
    }
  }

  /**
   * The variant an outcome is attributed to: the event's own, else the one
   * last evaluated for the flag and the event's targetingKey — by default its
   * userId, then the client's own targetingKey (or, for a client without
   * one, its own context: see trackVariant) — else "unknown". Never the
   * variant evaluated for someone else.
   */
  private outcomeVariant(event: OutcomeEvent): string {
    if (event.variant) return event.variant;
    const keys: unknown[] =
      event.targetingKey !== undefined
        ? [event.targetingKey]
        : event.userId !== undefined
          ? [event.userId, this.context.targetingKey]
          : [this.context.targetingKey];
    for (const targetingKey of keys) {
      const variant = this.lastEvaluatedVariants.get(variantKey(event.flagKey, targetingKey));
      if (variant !== undefined) return variant;
    }
    return "unknown";
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Evaluations waiting for a start() that never came go ahead.
    this.releaseConfigReady?.();
    this.releaseConfigReady = undefined;
    this.stream?.close();
    this.stream = null;
    this.stopBatchTimer();
    this.cache.clear();
    this.flagConfigs.clear();
    this.flagChangeListeners.clear();
    this.connectionListeners.clear();
    this.ownEvaluated.clear();

    // A client that never started never called its plugins' onInit, nor
    // any other hook of theirs.
    this.pendingPluginCalls = [];
    if (!this.started) return;
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
      this.callPlugins("onRequest", {
        url,
        durationMs: Math.round(performance.now() - start),
        ok: response.ok,
        requestBytes,
        responseBytes: Number.isFinite(responseBytes) ? responseBytes : 0,
      });
      return response;
    } catch (error) {
      this.callPlugins("onRequest", {
        url,
        durationMs: Math.round(performance.now() - start),
        ok: false,
        requestBytes,
        responseBytes: 0,
      });
      throw error;
    }
  }

  /**
   * Remember the variant an evaluation gave, for trackOutcome: per flag and
   * targeting key, so a server evaluating for many users attributes each
   * outcome to its own user's variant. `context` is the evaluation's per-call
   * context, if it had one; the targeting key is the one it was evaluated
   * with (the per-call context's, else the client's own).
   *
   * An evaluation without a targeting key is kept under "" only when it used
   * the client's own context, which is the same for everything the client
   * evaluates. One whose per-call context leaves it without a targeting key
   * (say a server evaluating an anonymous request) isn't kept: it's no one's
   * in particular, so an outcome falling back to the client's own context
   * mustn't get it. The map keeps the MAX_TRACKED_VARIANTS most recently
   * evaluated pairs.
   */
  private trackVariant(flagKey: string, result: EvaluationResult, context?: EvaluationContext): void {
    const perCall = hasKeys(context);
    const targetingKey =
      perCall && "targetingKey" in context ? context.targetingKey : this.context.targetingKey;
    if (perCall && (targetingKey === undefined || targetingKey === null || targetingKey === "")) return;
    const v = result.variant ?? String(result.value);
    const key = variantKey(flagKey, targetingKey);
    const variants = this.lastEvaluatedVariants;
    // Re-inserted, so the most recently evaluated pairs are the last dropped.
    variants.delete(key);
    variants.set(key, v);
    if (variants.size > MAX_TRACKED_VARIANTS) {
      const oldest = variants.keys().next().value;
      if (oldest !== undefined) variants.delete(oldest);
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
    this.callPlugins("onConnectionStateChange", state);
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
    // Config changed: what's cached for any context, per-call ones included,
    // is stale. A remote-only flag is refetched by its next evaluation.
    this.deleteFlagCacheEntries(flagKey);
    if (!isLocallyEvaluable(flag)) return;
    const evaluated = Evaluator.evaluate(flag, this.context);
    const changed =
      !cached || JSON.stringify(cached.value) !== JSON.stringify(evaluated.value);
    const result: EvaluationResult = {
      value: evaluated.value,
      reason: evaluated.reason as EvaluationResult["reason"],
      variant: evaluated.variant,
    };
    this.setCache(flagKey, result);
    // What the app now shows for this flag: what an outcome goes to.
    if (this.ownEvaluated.has(flagKey)) this.trackVariant(flagKey, result);
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
      this.callPlugins("onFlagChange", changeEvent);
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

    // Keyless streams (e.g. public demo services) keep EventSource. A runtime
    // without it can't stream: poll, as the keyed path does.
    if (typeof EventSource === "undefined") {
      this.startPollingFallback();
      return;
    }
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
      if (this.stream !== source) return;
      this.setConnectionState(CS.ERROR);
      // EventSource reconnects by itself after a network error (readyState
      // CONNECTING). A refusal — any answer but a 200 text/event-stream, such
      // as the data plane's 401 to a request without a key — closes it for
      // good (readyState CLOSED): poll instead, as the keyed path does.
      if (source.readyState !== 2 /* EventSource.CLOSED */) return;
      source.close();
      this.stream = null;
      this.startPollingFallback();
    };
  }

  /**
   * Stream fallback: the stream was refused or can't run, so refresh watched
   * flags on the batch cadence. A mode switch or destroy() stops it, as does
   * a refused batch (batchRefused).
   */
  private startPollingFallback(): void {
    if (this.destroyed || this.batchTimer) return;
    this.scheduleBatchTimer();
    this.pollingFallback = true;
    void this.refreshWatchedFlags();
  }

  /**
   * A batch request was refused (401/403). A refused key (or a request
   * without one, which the data plane refuses) won't be accepted on a retry:
   * the stream's polling fallback stops, rather than sending a request that
   * fails every batchIntervalMs for as long as the page is open. The client
   * stays in the ERROR state its stream left it in.
   */
  private batchRefused(): void {
    if (this.pollingFallback) this.stopBatchTimer();
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
        this.callPlugins("onFlagChange", { flagKey: data.flagKey, newValue: data.value as FlagValue });
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
      // The flag changed: what's cached for per-call contexts is stale too.
      this.deleteFlagCacheEntries(data.flagKey);
      this.setCache(data.flagKey, result);
      // The value pushed for the client's own context: what an outcome goes to.
      if (data.value !== undefined && this.ownEvaluated.has(data.flagKey)) {
        this.trackVariant(data.flagKey, result);
      }
      this.expose(data.flagKey, result, null, true);

      // Notify listeners
      const listeners = this.flagChangeListeners.get(data.flagKey);
      if (listeners) {
        for (const listener of listeners) {
          listener(changeEvent);
        }
      }

      // Notify plugins
      this.callPlugins("onFlagChange", changeEvent);
    }
  }
}
