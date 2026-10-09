/**
 * Supported flag value types
 */
export type FlagValue = boolean | string | number | Record<string, unknown>;

/**
 * Evaluation context for targeting rules
 */
export interface EvaluationContext {
  /** Unique identifier for the targeting subject (usually user ID) */
  targetingKey?: string;
  /** Additional attributes for targeting */
  [key: string]: FlagValue | undefined;
}

/**
 * Result of a flag evaluation
 */
export interface EvaluationResult<T extends FlagValue = FlagValue> {
  /** The evaluated flag value */
  value: T;
  /**
   * Reason for the evaluation result. The data plane (https://api.flaggr.dev)
   * answers a flag it doesn't have with FLAG_NOT_FOUND, the control plane
   * (https://flaggr.dev) with NOT_FOUND; EXPERIMENT, PREREQUISITE_FAILED and
   * MUTUAL_EXCLUSION come from the control plane's evaluator.
   */
  reason:
    | "STATIC"
    | "DEFAULT"
    | "TARGETING_MATCH"
    | "OVERRIDE"
    | "VARIANT"
    | "SPLIT"
    | "DISABLED"
    | "NOT_FOUND"
    | "FLAG_NOT_FOUND"
    | "EXPERIMENT"
    | "PREREQUISITE_FAILED"
    | "MUTUAL_EXCLUSION"
    | "ERROR";
  /** Variant key if applicable */
  variant?: string;
  /** Error message if evaluation failed */
  errorMessage?: string;
}

/**
 * Flag change event
 */
export interface FlagChangeEvent {
  flagKey: string;
  newValue: FlagValue;
  oldValue?: FlagValue;
}

/**
 * Connection state of the SDK
 */
export enum ConnectionState {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  ERROR = "error",
}

/**
 * How flag updates reach the client.
 *
 * - `stream`: SSE push — `configuration_sync`/`configuration_delta` events
 *   update the local config store; evaluation runs locally in microseconds
 *   with zero per-eval network.
 * - `batch`: periodic batched refresh — one POST covers all watched flags
 *   every `batchIntervalMs`.
 * - `poll`: per-flag requests — each evaluation beyond `cacheTtl` issues a
 *   remote call. Simplest, highest request count.
 */
export type UpdateMode = "stream" | "batch" | "poll";

/** Network activity reported to plugins for instrumentation */
export interface RequestInfo {
  url: string;
  durationMs: number;
  ok: boolean;
  /** Bytes sent in the request body */
  requestBytes: number;
  /** Bytes received (Content-Length when exposed, else 0) */
  responseBytes: number;
}

/**
 * SDK plugin interface for extending functionality
 */
export interface FlaggrPlugin {
  /** Plugin name for identification */
  name: string;
  /**
   * Called when the SDK is initialized, before any other hook. A client
   * created with `{ start: false }` (FlaggrProvider's) initializes in
   * start(): what it evaluated or requested before then reaches the other
   * hooks right after onInit, in order.
   */
  onInit?(client: FlaggrClientInstance): void;
  /** Called before each flag evaluation */
  onEvaluate?(flagKey: string, context?: EvaluationContext): void;
  /** Called after each flag evaluation */
  onEvaluateComplete?(
    flagKey: string,
    result: EvaluationResult,
    durationMs: number
  ): void;
  /** Called when an evaluation error occurs */
  onEvaluateError?(flagKey: string, error: Error, durationMs: number): void;
  /** Called when a flag value changes */
  onFlagChange?(event: FlagChangeEvent): void;
  /** Called when connection state changes */
  onConnectionStateChange?(state: ConnectionState): void;
  /** Called after each SDK network request — for latency/wire instrumentation */
  onRequest?(info: RequestInfo): void;
  /** Called when the SDK is destroyed */
  onDestroy?(): void;
}

/**
 * SDK configuration
 */
export interface FlaggrConfig {
  /**
   * Where the client evaluates flags (default: https://api.flaggr.dev, the
   * hosted data plane). The Flaggr app's routes it also calls
   * (/api/sdk-config, /api/events/outcomes, /api/analytics/sdk-telemetry) go
   * to https://flaggr.dev when apiUrl is the hosted data plane, else to apiUrl.
   */
  apiUrl?: string;
  /** Service identifier */
  serviceId: string;
  /** API token for authentication */
  apiKey?: string;
  /** Target environment */
  environment?: string;
  /** Evaluation context for targeting */
  context?: EvaluationContext;
  /** Plugins to extend SDK functionality */
  plugins?: FlaggrPlugin[];
  /** Cache TTL in milliseconds (default: 10000) */
  cacheTtl?: number;
  /** Enable real-time flag updates via SSE — deprecated alias for `updateMode: "stream"` */
  enableStreaming?: boolean;
  /**
   * How flag updates reach the client (default: `"poll"`, or `"stream"`
   * when `enableStreaming` is set). Switchable at runtime via
   * `setUpdateMode`.
   */
  updateMode?: UpdateMode;
  /** Refresh cadence for `updateMode: "batch"` in ms (default: 2000) */
  batchIntervalMs?: number;
  /**
   * Pre-seeded configuration (a `configuration_sync` payload or flag map).
   * When provided, flags evaluate locally with zero network on first paint.
   */
  bootstrap?: Record<string, unknown>;
  /**
   * Fallback values by flag key, returned instead of the method-level
   * default wherever the client would return that default: the evaluation
   * fails (offline, an HTTP error, a refused key), the flag isn't found, or,
   * for `evaluateSync`, nothing has loaded yet. A flag listed here is still
   * evaluated as usual: its entry never replaces a result.
   */
  defaults?: Record<string, FlagValue>;
  /**
   * Fetch service-level SDK config from the Flaggr app's GET /api/sdk-config on init
   * (https://flaggr.dev when apiUrl is the hosted data plane, https://api.flaggr.dev,
   * which serves only evaluation; otherwise the apiUrl) —
   * environment, updateMode, telemetry, cacheTtl come from Flaggr instead
   * of being repeated in client code. Explicit fields in this config win;
   * remote values fill gaps. Cached in localStorage with stale-while-
   * revalidate so repeat page loads never block on it.
   */
  remoteConfig?: boolean;
  /**
   * Publish the flag values this client resolves to the page, so Flaggr
   * browser analytics (`https://cdn.flaggr.dev/a.js`) tags every event with
   * the variants the page is using. Default: on in a browser page, unless a
   * script tag on the page has `data-expose-flags="false"` when the client
   * is created (with the script-tag bundle, also one that was there when
   * the bundle loaded, even if it's gone since); this option, when set,
   * overrides that attribute. Never runs on a server (DOM shims such as
   * domino, global-jsdom or happy-dom's global registrator included), in a
   * worker, or anywhere else without a working DOM, even when set to `true`.
   *
   * Values are merged into `window.__FLAGGR_FLAGS__` (flag key → value, one
   * entry per flag, the latest resolution wins; keys published by anything
   * else are kept). Each burst of changes is announced once, with a
   * `flaggr:flags-changed` event on `window` whose `detail` is the full
   * map, and nothing is dispatched when no value changed. If other code
   * replaces or deletes the map, each value of the client's that went
   * missing is put back the next time the client evaluates any flag. A key
   * the new map holds with another value is left as it is: reading an
   * unchanged value again isn't a new resolution. When the client publishes
   * before anything else has, it starts from the server-rendered
   * `window.__FLAGGR_BOOTSTRAP__` values, by the same rules as its own.
   *
   * What's published is a copy of the value as resolved, so changes the app
   * makes to the object later never reach the page, even when the value is
   * put back. An object or array value is published as its variant name
   * when the evaluation has one. A value whose JSON is over 1,024
   * characters (UTF-16 code units: 1 KB of ASCII, up to about 3 KB of
   * UTF-8), or that can't be serialized, isn't published, and the older
   * value it replaces is removed. The `_flaggr_analytics` flag is always
   * published in full: its value sets what the analytics script collects.
   *
   * Published: the result of every evaluation (`evaluate`, the typed
   * getters, `evaluateSync`, `evaluateBatch`, cache hits included), and
   * each update the client applies later to a flag the page has evaluated
   * or watches with `onFlagChange` (stream pushes and batch-mode
   * refreshes). After `setContext`, the flags the client published for its
   * own context, and watched ones, are republished for the new context at
   * once when the client can evaluate them locally. The rest are
   * republished at their next evaluation, even if the value didn't change:
   * flags only the data plane can evaluate, and flags the page evaluated
   * with a per-call context. Until then they keep their published value,
   * which isn't put back if other code replaces the map.
   *
   * Taken off the page: a flag that no longer exists, once an evaluation
   * says so (the data plane's FLAG_NOT_FOUND), the stream reports it
   * deleted, or a configuration from the stream no longer has it.
   *
   * Not published, as with Flaggr's OpenFeature web provider: a fallback.
   * That is your `defaultValue` or `defaults` entry when an evaluation
   * fails, the flag isn't found, or nothing has loaded yet. Also not
   * published: a value evaluated for someone else, when the client has a
   * `targetingKey` and a per-call context gives another one, or clears it
   * (`{ targetingKey: undefined }`); and a remote result that arrives after
   * `setContext` for an evaluation called before it (the caller still gets
   * it, but it isn't cached either). A client without a `targetingKey`
   * publishes values evaluated with any per-call `targetingKey`, the latest
   * winning: on pages that evaluate flags for other users (an admin's
   * "preview as customer" list), give the client the page user's
   * `targetingKey` (`FlaggrProvider`'s `config.context`) or set `false`. A
   * published value stays until a newer one replaces it or its flag is
   * deleted; `destroy()` leaves it.
   *
   * Set `false` to keep flag values off the page: any script on the page
   * can read them, and the analytics script sends them with every event.
   * Also worth it when one page runs clients with different contexts.
   */
  exposeFlags?: boolean;
}

/**
 * Outcome event for experiment tracking
 */
export interface OutcomeEvent {
  /** The flag key this outcome is associated with */
  flagKey: string;
  /** Name of the outcome event (e.g., 'purchase', 'signup', 'error') */
  eventName: string;
  /** Optional numeric value (e.g., revenue amount) */
  eventValue?: number;
  /** Optional user identifier (will be SHA-256 hashed server-side) */
  userId?: string;
  /**
   * The targeting key of the evaluation the outcome follows: the event
   * carries the variant this client last evaluated for the flag with this
   * targetingKey. Default: `userId`, then the client's own targetingKey (its
   * `context`). Not sent.
   */
  targetingKey?: string;
  /**
   * The variant the user saw, when the caller knows it (say a server that
   * evaluated the flag elsewhere). Default: the one this client last
   * evaluated for the flag and targetingKey, else "unknown".
   */
  variant?: string;
}

/**
 * Flaggr client instance
 */
export interface FlaggrClientInstance {
  /** Evaluate a boolean flag */
  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: EvaluationContext
  ): Promise<boolean>;
  /** Evaluate a string flag */
  getStringValue(
    flagKey: string,
    defaultValue: string,
    context?: EvaluationContext
  ): Promise<string>;
  /** Evaluate a number flag */
  getNumberValue(
    flagKey: string,
    defaultValue: number,
    context?: EvaluationContext
  ): Promise<number>;
  /** Evaluate an object flag (T may be an interface: any object type) */
  getObjectValue<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): Promise<T>;
  /** Get detailed evaluation result */
  evaluate<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): Promise<EvaluationResult<T>>;
  /**
   * Synchronous evaluation — resolves from the streamed/bootstrap
   * configuration or cache without network. Falls back to `defaultValue`.
   */
  evaluateSync<T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context?: EvaluationContext
  ): EvaluationResult<T>;
  /** Synchronous boolean evaluation — safe in render loops */
  getBooleanValueSync(
    flagKey: string,
    defaultValue: boolean,
    context?: EvaluationContext
  ): boolean;
  /** Update evaluation context */
  setContext(context: EvaluationContext): void;
  /** Switch the update delivery mode at runtime (stream ⇄ batch ⇄ poll) */
  setUpdateMode(mode: UpdateMode): void;
  /** Current update delivery mode */
  getUpdateMode(): UpdateMode;
  /** Subscribe to flag changes */
  onFlagChange(
    flagKey: string,
    listener: (event: FlagChangeEvent) => void
  ): () => void;
  /** Subscribe to connection state changes */
  onConnectionStateChange(
    listener: (state: ConnectionState) => void
  ): () => void;
  /** Get current connection state */
  getConnectionState(): ConnectionState;
  /** Read-only view of the resolved client config (defaults applied) */
  getConfig(): Readonly<FlaggrConfig>;
  /**
   * Clear all persisted SDK state for this service (remote settings +
   * flag snapshots across all environments/scopes). Next load re-fetches
   * everything — use for key rotation or recovering from bad cache state.
   * Optional, so an implementation written for 0.4.0, which didn't have it,
   * still is one: FlaggrClient always has it (`client.clearPersistedConfig?.()`
   * on this type).
   */
  clearPersistedConfig?(): void;
  /**
   * Force refresh all flags: re-evaluate, with the client's own context and
   * in one batched request (flags it holds the configuration of evaluate
   * locally), every flag this client has cached for that context or watches
   * with `onFlagChange`, and notify the listeners of each flag whose value
   * changed. Resolves once that's done. Results cached for per-call
   * contexts are dropped: those go to the network again at their next call,
   * as does a flag the refresh can't resolve (the request fails, or the
   * flag isn't found), which notifies nobody. A flag only cached for
   * per-call contexts, and not watched, isn't evaluated for the client's own
   * context. (A React hook with a per-call context evaluates again, for its
   * context, when its flag's listeners are notified.)
   */
  refresh(): Promise<void>;
  /**
   * Track an outcome event for passive experiment analysis: POSTed to the
   * Flaggr app's /api/events/outcomes with the client's apiKey as a bearer,
   * on a keepalive request (it outlives the page) when the body fits the
   * browser's 64 KiB keepalive budget. Never throws.
   *
   * In a browser the request is sent at once, and a CORS preflight goes
   * first: the returned promise settles after both round trips, so don't
   * await it before navigating away (the keepalive request arrives anyway).
   * When the page is closing, call it from a `visibilitychange` handler
   * (document hidden) rather than `pagehide`: some browsers drop requests
   * started in `pagehide` when a tab is closed.
   */
  trackOutcome(event: OutcomeEvent): Promise<void>;
  /** Destroy the client and clean up resources */
  destroy(): void;
}
