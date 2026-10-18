/**
 * Error tracking for the Flaggr SDK: crashes and errors, with the flag
 * variants that were active when they happened, grouped into issues on
 * Flaggr (the console's Issues page, GET /api/projects/{id}/issues).
 *
 * Usage:
 *   import { createFlaggr, flaggrErrors, captureException } from '@flaggr/sdk'
 *   const client = createFlaggr({
 *     serviceId: 'web-app',
 *     apiKey: 'fgr_...',
 *     plugins: [flaggrErrors({ release: 'web@1.4.2' })],
 *   })
 *   try { risky() } catch (error) { captureException(error, { tags: { step: 'checkout' } }) }
 *
 * Where errors go depends on where the code runs:
 *  - In a browser, to the Flaggr app's POST /api/analytics/sdk-telemetry with
 *    the client's apiKey (the project's SDK key), as flaggrTelemetry's
 *    batches go. Errors are caught from window `error` and
 *    `unhandledrejection`.
 *  - On a server (Node, Bun, Deno), to POST /api/ingest/server-events with a
 *    project API token: `serverToken`, else the FLAGGR_ERRORS_TOKEN
 *    environment variable, else the client's apiKey. That route refuses SDK
 *    keys (they ship inside client bundles), so a server needs a real
 *    project API token; when it's refused, a warning says so once and
 *    nothing more is sent. Uncaught exceptions (and, with Node's default
 *    --unhandled-rejections=throw, unhandled rejections) are caught: the
 *    error is sent, then the process exits with code 1 as it would have,
 *    after at most `shutdownTimeoutMs` (exitOnUncaught: false leaves the
 *    process to your own handler).
 *
 * Every event carries the variants this client evaluated (the last one per
 * flag), the release and environment, the user and tags you set, and the
 * breadcrumbs that led up to it: flag evaluations, console warnings and
 * errors, fetch requests and (in a browser) navigations. Stacks and messages
 * are cut to the ingest's 2,000 characters; the ingest scrubs tokens,
 * addresses and URL credentials before storing them.
 */

import { appBaseUrl } from "./app-url";
import { fetchWithKeepalive } from "./keepalive";
import type { EvaluationResult, FlaggrClientInstance, FlaggrPlugin, RequestInfo } from "./types";

export type ErrorLevel = "fatal" | "error" | "warning";

export interface Breadcrumb {
  /** ms since the epoch */
  timestamp: number;
  /** e.g. "flag", "console", "fetch", "navigation", or your own */
  category: string;
  message: string;
  level?: "info" | "warning" | "error";
  data?: Record<string, unknown>;
}

export interface ErrorUser {
  id: string;
}

/** What captureException adds to one event. */
export interface CaptureContext {
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
  level?: ErrorLevel;
  /** Group this event with others under your own key instead of by its stack. */
  fingerprint?: string;
  /** Whether your code caught it (default true for captureException). */
  handled?: boolean;
  user?: ErrorUser | null;
}

/** One error as it is sent (beforeSend may change or drop it). */
export interface ErrorEvent {
  name: string;
  message: string;
  stack?: string;
  level: ErrorLevel;
  handled: boolean;
  /** ISO time */
  timestamp: string;
  release?: string;
  environment?: string;
  user?: ErrorUser;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  flags: Record<string, string>;
  breadcrumbs: Breadcrumb[];
  fingerprint?: string;
  /** The page (browser) */
  url?: string;
}

export interface ErrorTrackingOptions {
  /** Your app's version, e.g. "web@1.4.2" or a commit SHA: issues show the releases they appear in and regress across. */
  release?: string;
  /** Default: the client's `environment`. */
  environment?: string;
  /** Catch uncaught errors and unhandled rejections (default true). */
  autoCapture?: boolean;
  /** Server only: exit with code 1 after sending an uncaught exception, as Node would have (default true). */
  exitOnUncaught?: boolean;
  /** Server only: how long to wait for the send before exiting (default 2000 ms). */
  shutdownTimeoutMs?: number;
  /** Which breadcrumbs to record (default all), or false for none. */
  breadcrumbs?: false | { flags?: boolean; console?: boolean; fetch?: boolean; navigation?: boolean };
  /** The most breadcrumbs an event carries, newest kept (default 50). */
  maxBreadcrumbs?: number;
  /** Send this share of errors, 0 to 1 (default 1). */
  sampleRate?: number;
  /** Drop errors whose message contains one of these strings or matches one of these patterns. */
  ignoreErrors?: Array<string | RegExp>;
  /** Change an event before it is sent, or return null to drop it. */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null;
  /** Server only: the project API token for /api/ingest/server-events (default FLAGGR_ERRORS_TOKEN, then the client's apiKey). */
  serverToken?: string;
  /**
   * Server only: the Flaggr service id (the service's id, not its slug) to
   * file errors under. Left out by default: an id that isn't one of the
   * token's project's services makes the ingest reject the event.
   */
  serverServiceId?: string;
  /** The Flaggr app's URL, when apiUrl points at a self-hosted data plane (default: derived from apiUrl). */
  appUrl?: string;
  /** ms between sends of queued errors (default 2000). */
  flushIntervalMs?: number;
  /**
   * Browser only: report each session once, with the release and
   * environment, so Flaggr can show each release's crash-free session rate
   * (default true). A session lasts across page loads in a tab until 30
   * minutes without one, as the analytics script's do.
   */
  sessions?: boolean;
  /**
   * Browser only: requests to these origins or URLs (strings match a URL's
   * start, patterns test the whole URL) get a W3C traceparent header, so the
   * service that answers (the Go SDK's errorreport middleware, or any
   * OpenTelemetry service) continues the trace: its errors and spans share the
   * trace id the fetch breadcrumb records. Default: the page's own origin
   * (cross-origin requests would need the header allowed by CORS). The header
   * is sent unsampled: the service decides whether to record the trace. []
   * turns it off.
   */
  tracePropagationTargets?: Array<string | RegExp>;
}

/** The plugin, with the capture API. Install it with createFlaggr({ plugins: [...] }). */
export interface FlaggrErrors extends FlaggrPlugin {
  captureException(error: unknown, context?: CaptureContext): void;
  captureMessage(message: string, context?: CaptureContext): void;
  addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: number }): void;
  setUser(user: ErrorUser | null): void;
  setTag(key: string, value: string | number | boolean): void;
  setTags(tags: Record<string, string | number | boolean>): void;
  /** Send what is queued now; resolves when sent, or after timeoutMs (default 2000). */
  flush(timeoutMs?: number): Promise<void>;
}

/** The ingest's caps (src/lib/db/server-telemetry-writer.ts): a longer field would reject the event. */
const MAX_TEXT = 2000;
const MAX_SHORT = 500;
/** The most errors queued between sends, and sent per minute, so an error loop can't flood the ingest. */
const MAX_QUEUE = 100;
const MAX_PER_MINUTE = 60;

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[flaggr/errors] ${message}`);
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

type NodeProcess = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
  exit(code?: number): never;
  env: Record<string, string | undefined>;
  exitCode?: number;
};

function nodeProcess(): NodeProcess | null {
  const p = (globalThis as { process?: Partial<NodeProcess> }).process;
  return p && typeof p.on === "function" && typeof p.listenerCount === "function" ? (p as NodeProcess) : null;
}

function cut(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/** An Error-like from anything thrown or rejected. */
function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error || (error && typeof error === "object" && "message" in error)) {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof e.name === "string" && e.name ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : String(e.message),
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { name: "Error", message: `Non-Error thrown: ${message}` };
}

/** A URL without its query string or fragment (where tokens and personal data ride). */
function bareUrl(url: string): string {
  return url.replace(/[?#].*$/, "");
}

let current: FlaggrErrors | null = null;

const SESSION_KEY = "flaggr_errors_session";
const SESSION_IDLE_MS = 30 * 60_000;

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The tab's error-tracking session: the stored one while it was active in the
 * last 30 minutes, else a new one. `reported` says whether the session was
 * already sent for release health. Without sessionStorage (blocked, or not a
 * browser) every client is a new session.
 */
function browserSession(now: number): { id: string; startedAt: number; reported: boolean } {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as
      | { id?: unknown; startedAt?: unknown; lastActive?: unknown; reported?: unknown }
      | null;
    if (stored && typeof stored.id === "string" && typeof stored.lastActive === "number" && now - stored.lastActive < SESSION_IDLE_MS) {
      return { id: stored.id, startedAt: Number(stored.startedAt) || now, reported: stored.reported === true };
    }
  } catch {
    /* no sessionStorage */
  }
  return { id: newId(), startedAt: now, reported: false };
}

function saveBrowserSession(session: { id: string; startedAt: number; reported: boolean }, now: number) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, lastActive: now }));
  } catch {
    /* no sessionStorage */
  }
}

/** Whether a flaggrErrors() plugin is installed: flaggrTelemetry then leaves window errors to it. */
export function errorTrackingActive(): boolean {
  return current !== null;
}

/** Report an error through the most recently installed flaggrErrors() plugin (a no-op when none is). */
export function captureException(error: unknown, context?: CaptureContext): void {
  if (current) current.captureException(error, context);
  else warnOnce("captureException() was called before a client with flaggrErrors() was created; the error was not sent");
}

/** Report a message as an error event through the most recently installed flaggrErrors() plugin. */
export function captureMessage(message: string, context?: CaptureContext): void {
  current?.captureMessage(message, context);
}

/** Add a breadcrumb to the most recently installed flaggrErrors() plugin. */
export function addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: number }): void {
  current?.addBreadcrumb(breadcrumb);
}

/** Set (or with null clear) the user the next errors are reported for. */
export function setUser(user: ErrorUser | null): void {
  current?.setUser(user);
}

export function flaggrErrors(options: ErrorTrackingOptions = {}): FlaggrErrors {
  const {
    autoCapture = true,
    exitOnUncaught = true,
    shutdownTimeoutMs = 2000,
    maxBreadcrumbs = 50,
    sampleRate = 1,
    ignoreErrors = [],
    beforeSend,
    flushIntervalMs = 2000,
    sessions: trackSessions = true,
  } = options;
  const crumbs = options.breadcrumbs === false ? null : { flags: true, console: true, fetch: true, navigation: true, ...options.breadcrumbs };

  let client: FlaggrClientInstance | null = null;
  let environment = options.environment;
  let user: ErrorUser | undefined;
  const tags: Record<string, string> = {};
  const flags: Record<string, string> = {};
  const breadcrumbs: Breadcrumb[] = [];
  const queue: ErrorEvent[] = [];
  const seen = new WeakSet<object>();
  const sentAt: number[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let sessionId = "";
  /** Browser: this session, until it has been sent for release health. */
  let session: { id: string; startedAt: number; reported: boolean } | null = null;
  const inFlight = new Set<Promise<unknown>>();
  const teardown: Array<() => void> = [];

  function record(breadcrumb: Breadcrumb) {
    breadcrumbs.push(breadcrumb);
    if (breadcrumbs.length > maxBreadcrumbs) breadcrumbs.splice(0, breadcrumbs.length - maxBreadcrumbs);
  }

  function ignored(message: string): boolean {
    return ignoreErrors.some((pattern) => (typeof pattern === "string" ? message.includes(pattern) : pattern.test(message)));
  }

  function underRate(now: number): boolean {
    while (sentAt.length > 0 && now - sentAt[0] > 60_000) sentAt.shift();
    if (sentAt.length >= MAX_PER_MINUTE) return false;
    sentAt.push(now);
    return true;
  }

  function enqueue(error: unknown, context: CaptureContext, defaults: { handled: boolean; level: ErrorLevel }): void {
    if (stopped || !client) return;
    if (error && typeof error === "object") {
      // One error object reaches a handler more than once (a rethrow, a framework boundary and window.onerror).
      if (seen.has(error)) return;
      seen.add(error);
    }
    const base = normalizeError(error);
    if (ignored(base.message)) return;
    if (sampleRate < 1 && Math.random() >= sampleRate) return;
    const now = Date.now();
    if (!underRate(now)) return;

    const eventTags = { ...tags };
    for (const [key, value] of Object.entries(context.tags ?? {})) eventTags[key] = String(value);
    let event: ErrorEvent | null = {
      name: cut(base.name, MAX_SHORT)!,
      message: cut(base.message, MAX_TEXT)!,
      stack: cut(base.stack, MAX_TEXT),
      level: context.level ?? defaults.level,
      handled: context.handled ?? defaults.handled,
      timestamp: new Date(now).toISOString(),
      release: options.release,
      environment,
      user: context.user === null ? undefined : context.user ?? user,
      tags: eventTags,
      extra: { ...(context.extra ?? {}) },
      flags: { ...flags },
      breadcrumbs: breadcrumbs.slice(),
      fingerprint: context.fingerprint,
      url: isBrowser() ? bareUrl(window.location.href) : undefined,
    };
    if (beforeSend) {
      try {
        event = beforeSend(event);
      } catch {
        /* a throwing beforeSend sends the event as it was */
      }
    }
    if (!event) return;
    if (session) saveBrowserSession(session, now);
    queue.push(event);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    record({ timestamp: now, category: "error", level: "error", message: `${event.name}: ${event.message}`.slice(0, 200) });
  }

  /** The browser batch (POST /api/analytics/sdk-telemetry): the SDK key's project, its Sites' issues. */
  function browserBatch(events: ErrorEvent[], withSession: boolean) {
    return {
      serviceId: client?.getConfig().serviceId,
      sessionId,
      ...(withSession && session
        ? { releaseSessions: [{ sessionId: session.id, release: options.release, environment, startedAt: session.startedAt }] }
        : {}),
      summaries: [],
      vitals: [],
      errors: events.map((e) => ({
        name: e.name,
        message: e.message,
        stack: e.stack,
        level: e.level,
        handled: e.handled,
        fatal: e.level === "fatal",
        timestamp: Date.parse(e.timestamp),
        release: e.release,
        environment: e.environment,
        user: e.user,
        tags: e.tags,
        extra: e.extra,
        flags: e.flags,
        breadcrumbs: e.breadcrumbs,
        fingerprint: e.fingerprint,
        pageUrl: e.url,
      })),
    };
  }

  /** The server batch (POST /api/ingest/server-events): the token's project. */
  function serverBatch(events: ErrorEvent[]) {
    return {
      events: events.map((e) => ({
        kind: "error",
        serviceId: options.serverServiceId,
        environment: cut(e.environment, MAX_SHORT),
        fingerprint: e.fingerprint ? cut(`custom_${e.fingerprint}`, MAX_SHORT) : undefined,
        name: e.name,
        message: e.message,
        stack: e.stack,
        release: cut(e.release, MAX_SHORT),
        timestamp: e.timestamp,
        data: {
          // Extra context first: the fields the issue reads take win over a key of the same name.
          ...e.extra,
          handled: e.handled,
          level: e.level,
          ...(e.user ? { userId: e.user.id } : {}),
          flags: e.flags,
          tags: e.tags,
          breadcrumbs: e.breadcrumbs,
          sdkService: client?.getConfig().serviceId,
        },
      })),
    };
  }

  function appUrl(): string {
    return options.appUrl ? options.appUrl.replace(/\/$/, "") : appBaseUrl(client?.getConfig().apiUrl);
  }

  function serverToken(): string | undefined {
    return options.serverToken ?? nodeProcess()?.env.FLAGGR_ERRORS_TOKEN ?? client?.getConfig().apiKey;
  }

  function onResponse(response: Response, route: string) {
    if (response.status === 401 || response.status === 403) {
      stopped = true;
      warnOnce(
        isBrowser()
          ? `${route} refused the apiKey (${response.status}); no errors are sent from this client`
          : `${route} refused the token (${response.status}): server-side error reporting needs a project API token (serverToken or FLAGGR_ERRORS_TOKEN), not an SDK key; no errors are sent from this process`
      );
    } else if (response.status === 404 || response.status === 405) {
      stopped = true;
      warnOnce(`${appUrl()}${route} doesn't take errors (${response.status}); set flaggrErrors({ appUrl }) to the Flaggr app's URL`);
    }
  }

  function send(): Promise<void> {
    const browser = isBrowser();
    const sessionDue = browser && !!session && !session.reported;
    if (stopped || !client || (queue.length === 0 && !sessionDue)) return Promise.resolve();
    const events = queue.splice(0, MAX_QUEUE);
    if (sessionDue && session) {
      session.reported = true;
      saveBrowserSession(session, Date.now());
    }
    const route = browser ? "/api/analytics/sdk-telemetry" : "/api/ingest/server-events";
    const token = browser ? client.getConfig().apiKey : serverToken();
    if (!token) {
      stopped = true;
      warnOnce(browser ? "flaggrErrors() needs the client's apiKey (the project's SDK key)" : "flaggrErrors() on a server needs a project API token (serverToken or FLAGGR_ERRORS_TOKEN)");
      return Promise.resolve();
    }
    const request = fetchWithKeepalive(`${appUrl()}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(browser ? browserBatch(events, sessionDue) : serverBatch(events)),
    })
      .then((response) => onResponse(response, route))
      .catch(() => {
        /* offline or blocked: these events are lost, as a crash reporter's are */
      });
    inFlight.add(request);
    void request.finally(() => inFlight.delete(request));
    return request;
  }

  async function flush(timeoutMs = 2000): Promise<void> {
    void send();
    const pending = Promise.all([...inFlight]).then(() => undefined);
    await Promise.race([pending, new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      (t as unknown as { unref?: () => void }).unref?.();
    })]);
  }

  function installBrowser() {
    const onError = (event: Event) => {
      const e = event as unknown as { error?: unknown; message?: string; filename?: string; lineno?: number; colno?: number };
      // A resource that failed to load (img, script) has no error: not a crash.
      if (e.error === undefined && !e.message) return;
      enqueue(e.error ?? new Error(e.message), { handled: false }, { handled: false, level: "error" });
    };
    const onRejection = (event: Event) => {
      enqueue((event as unknown as { reason?: unknown }).reason, { handled: false }, { handled: false, level: "error" });
    };
    const onHide = () => void send();
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("pagehide", onHide);
    teardown.push(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("pagehide", onHide);
    });
  }

  function installNode(proc: NodeProcess) {
    const onUncaught = (error: unknown, origin: unknown) => {
      enqueue(error, { handled: false }, { handled: false, level: "fatal" });
      if (!exitOnUncaught) return;
      // With our listener Node no longer prints and exits: do as it would, after the send.
      const others = proc.listenerCount("uncaughtException") - 1;
      void flush(shutdownTimeoutMs).then(() => {
        if (others > 0) return;
        console.error(origin === "unhandledRejection" ? "Unhandled promise rejection:" : "Uncaught exception:", error);
        proc.exit(1);
      });
    };
    proc.on("uncaughtException", onUncaught);
    teardown.push(() => proc.removeListener("uncaughtException", onUncaught));
  }

  function wrapConsole() {
    if (typeof console === "undefined") return;
    for (const level of ["warn", "error"] as const) {
      const original = console[level];
      if (typeof original !== "function") continue;
      let active = true;
      const wrapped = (...args: unknown[]) => {
        if (!active) return original.apply(console, args);
        const message = args
          .map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? `${arg.name}: ${arg.message}` : safeJson(arg)))
          .join(" ")
          .slice(0, 300);
        // Our own warnings stay out of the trail.
        if (!message.startsWith("[flaggr")) record({ timestamp: Date.now(), category: "console", level: level === "warn" ? "warning" : "error", message });
        original.apply(console, args);
      };
      console[level] = wrapped;
      teardown.push(() => {
        // Wrapped again since (another plugin, a logger): pass through instead of unwrapping theirs.
        active = false;
        if (console[level] === wrapped) console[level] = original;
      });
    }
  }

  function wrapFetch() {
    const g = globalThis as { fetch?: typeof fetch };
    const original = g.fetch;
    if (typeof original !== "function") return;
    let active = true;
    const wrapped: typeof fetch = async (input, init) => {
      if (!active) return original(input, init);
      const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const started = Date.now();
      // A traceparent for the service that answers (unsampled: it decides), unless the request has one.
      let traceId: string | undefined;
      if (propagatesTo(url, options.tracePropagationTargets)) {
        const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
        if (!headers.has("traceparent")) {
          traceId = hexId(16);
          headers.set("traceparent", `00-${traceId}-${hexId(8)}-00`);
          init = { ...init, headers };
        }
      }
      const crumb = (data: Record<string, unknown>, level: Breadcrumb["level"]) => {
        // The SDK's own requests (evaluations, these reports) stay out of the trail.
        if (/\/api\/(flags|ofrep|analytics\/sdk-telemetry|ingest\/server-events|sdk-config|connect)\b/.test(url)) return;
        record({
          timestamp: started,
          category: "fetch",
          level,
          message: `${method} ${bareUrl(url)}`,
          data: { ...data, durationMs: Date.now() - started, ...(traceId ? { traceId } : {}) },
        });
      };
      try {
        const response = await original(input, init);
        crumb({ status: response.status }, response.status >= 500 ? "error" : response.status >= 400 ? "warning" : "info");
        return response;
      } catch (error) {
        crumb({ error: normalizeError(error).message.slice(0, 200) }, "error");
        throw error;
      }
    };
    g.fetch = wrapped;
    teardown.push(() => {
      active = false;
      if (g.fetch === wrapped) g.fetch = original;
    });
  }

  function watchNavigation() {
    let last = bareUrl(window.location.href);
    const navigated = () => {
      const to = bareUrl(window.location.href);
      if (to === last) return;
      record({ timestamp: Date.now(), category: "navigation", message: `Navigated to ${to}`, data: { from: last } });
      last = to;
    };
    const { pushState, replaceState } = history;
    history.pushState = function (...args: Parameters<History["pushState"]>) {
      pushState.apply(this, args);
      navigated();
    };
    history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      replaceState.apply(this, args);
      navigated();
    };
    window.addEventListener("popstate", navigated);
    teardown.push(() => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener("popstate", navigated);
    });
  }

  const plugin: FlaggrErrors = {
    name: "flaggr-errors",

    onInit(c) {
      client = c;
      current = plugin;
      environment = options.environment ?? c.getConfig().environment;
      sessionId = newId();
      if (isBrowser()) {
        // Errors carry the tab session's id, so a release's crashed sessions are the ones with an unhandled error.
        const now = Date.now();
        const tab = browserSession(now);
        sessionId = tab.id;
        session = trackSessions ? tab : null;
        saveBrowserSession(trackSessions ? tab : { ...tab, reported: true }, now);
      }
      timer = setInterval(() => void send(), flushIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      if (crumbs?.console) wrapConsole();
      if (crumbs?.fetch) wrapFetch();
      if (isBrowser()) {
        if (crumbs?.navigation) watchNavigation();
        if (autoCapture) installBrowser();
      } else {
        const proc = nodeProcess();
        if (proc && autoCapture) installNode(proc);
      }
    },

    onEvaluateComplete(flagKey: string, result: EvaluationResult) {
      const variant = result.variant ?? String(result.value);
      const changed = flags[flagKey] !== variant;
      flags[flagKey] = variant;
      if (crumbs?.flags && changed) {
        record({ timestamp: Date.now(), category: "flag", message: `${flagKey} = ${variant}`, data: { reason: result.reason } });
      }
    },

    onRequest(info: RequestInfo) {
      if (!info.ok && crumbs?.fetch) {
        record({ timestamp: Date.now(), category: "flaggr", level: "warning", message: `Flag request failed (${info.durationMs.toFixed(0)} ms)` });
      }
    },

    onDestroy() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const undo of teardown.splice(0)) undo();
      void send();
      if (current === plugin) current = null;
    },

    captureException(error, context = {}) {
      enqueue(error, context, { handled: true, level: "error" });
    },

    captureMessage(message, context = {}) {
      const error = new Error(message);
      error.name = "Message";
      enqueue(error, context, { handled: true, level: context.level ?? "warning" });
    },

    addBreadcrumb(breadcrumb) {
      record({ ...breadcrumb, timestamp: breadcrumb.timestamp ?? Date.now() });
    },

    setUser(next) {
      user = next ?? undefined;
    },

    setTag(key, value) {
      tags[key] = String(value);
    },

    setTags(next) {
      for (const [key, value] of Object.entries(next)) tags[key] = String(value);
    },

    flush,
  };

  return plugin;
}

function hexId(bytes: number): string {
  const values = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(values);
  else for (let i = 0; i < bytes; i += 1) values[i] = Math.floor(Math.random() * 256);
  const hex = Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
  return /^0+$/.test(hex) ? hexId(bytes) : hex;
}

/** Whether a request URL gets a traceparent: one of the targets, by default the page's own origin. */
function propagatesTo(url: string, targets: Array<string | RegExp> | undefined): boolean {
  if (!isBrowser()) return false;
  let absolute: URL;
  try {
    absolute = new URL(url, window.location.href);
  } catch {
    return false;
  }
  if (!targets) return absolute.origin === new URL(window.location.href).origin;
  return targets.some((target) => (typeof target === "string" ? absolute.href.startsWith(target) : target.test(absolute.href)));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
