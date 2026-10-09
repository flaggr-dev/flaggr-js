/**
 * Opt-in browser telemetry plugin for the Flaggr SDK.
 *
 * Aggregates flag evaluations, Core Web Vitals, and page errors locally and
 * flushes to POST /api/analytics/sdk-telemetry — the same ingest the
 * platform's web provider uses, so CDN/script-tag installs get the same
 * analytics surface (flag↔vital correlation, cache efficiency, error links).
 *
 * The endpoint takes only the project's SDK key (or a project API token):
 * the client's `apiKey`. Without one the plugin sends nothing, and once the
 * endpoint refuses the key (401/403) it stops sending.
 *
 * The endpoint is the Flaggr app's (the control plane's), at the client's
 * apiUrl — except for the hosted data plane, https://api.flaggr.dev (the
 * client's default apiUrl), which serves only evaluation: from there batches
 * go to https://flaggr.dev. A host that answers 404 or 405 serves no
 * telemetry, so the plugin stops sending to it (set `endpoint`).
 *
 * Usage:
 *   import { createFlaggr, flaggrTelemetry } from '@flaggr/sdk'
 *   const client = createFlaggr({
 *     serviceId: 'web-app',
 *     apiKey: 'fgr_...',
 *     plugins: [flaggrTelemetry()],
 *   })
 *
 * Or via the script tag:
 *   <script src=".../browser.global.js" data-service-id="web-app"
 *           data-api-key="fgr_..." data-telemetry defer></script>
 */

import { appBaseUrl } from "./app-url";
import { fetchWithKeepalive, fitsKeepaliveBudget } from "./keepalive";
import type {
  EvaluationResult,
  FlaggrClientInstance,
  FlaggrPlugin,
  RequestInfo,
} from "./types";

export interface TelemetryOptions {
  /** ms between periodic flushes (default 30000) */
  flushIntervalMs?: number;
  /** capture LCP, CLS, FCP, INP and TTFB via PerformanceObserver (default true) */
  vitals?: boolean;
  /** capture window errors correlated with active flag variants (default true) */
  errors?: boolean;
  /**
   * On page hide, send the last batch on a request that outlives the page
   * (default true): a keepalive fetch, else navigator.sendBeacon. Either
   * carries the SDK key in its body, since a header would need a CORS
   * preflight.
   */
  beacon?: boolean;
  /**
   * The URL batches are POSTed to. Default: `${apiUrl}/api/analytics/sdk-telemetry`,
   * or https://flaggr.dev/api/analytics/sdk-telemetry when apiUrl is the hosted
   * data plane (https://api.flaggr.dev), which serves only evaluation. Set it
   * when apiUrl points at a self-hosted data plane: to the same path on the
   * Flaggr app.
   */
  endpoint?: string;
}

/** Why telemetry stopped, already reported by console.warn. */
const warned = new Set<string>();

/** The Flaggr app's route (the hosted data plane has no telemetry endpoint). */
const TELEMETRY_PATH = "/api/analytics/sdk-telemetry";

/**
 * Where a client's batches go (TelemetryOptions.endpoint): the Flaggr app's
 * endpoint for the client's apiUrl (appBaseUrl). An unset apiUrl stands for
 * the client's default, the hosted data plane: the hosted app's endpoint. An
 * empty one (or "/") is the page's own origin, where the client evaluates
 * too: the endpoint's path there.
 */
export function telemetryEndpoint(apiUrl: string | undefined, endpoint?: string): string {
  return endpoint || `${appBaseUrl(apiUrl)}${TELEMETRY_PATH}`;
}

/** Whether fetch() honours `keepalive` (Request#keepalive: Chrome 66, Safari 13, Firefox 133). */
function keepaliveFetchSupported(): boolean {
  return typeof fetch === "function" && typeof Request !== "undefined" && "keepalive" in Request.prototype;
}

/**
 * Send a page-hide batch on a request that outlives the page. Such a request
 * can't carry an Authorization header without a CORS preflight, so `body`
 * holds the key as `apiKey` and goes as text/plain (CORS-safelisted; the
 * endpoint reads the body as JSON whatever its type). Never a key in the URL.
 *
 * A keepalive fetch first: it keeps the page's real Origin, which
 * navigator.sendBeacon may send as "null" under a strict referrer policy
 * (Firefox, WebKit), and the endpoint trusts a batch for rollout RUM checks
 * only from a domain of the project's Sites. navigator.sendBeacon only where
 * keepalive fetch isn't supported. Returns false when neither went out, and
 * for a batch over what's left of the page's 64 KiB keepalive budget, which
 * a beacon (held to the same quota) couldn't carry either: the caller sends
 * that one as a plain request, which arrives unless the page is unloading.
 */
function sendOnPageHide(url: string, body: string, onResponse: (response: Response) => void): boolean {
  if (!fitsKeepaliveBudget(body)) return false;
  if (keepaliveFetchSupported()) {
    try {
      fetchWithKeepalive(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body })
        .then(onResponse)
        .catch(() => {});
      return true;
    } catch {
      /* fall back to sendBeacon */
    }
  }
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      return navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
    } catch {
      /* a refused beacon: the caller sends it with fetch */
    }
  }
  return false;
}

interface FlagAgg {
  evaluations: number;
  cacheHits: number;
  cacheMisses: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  variants: Map<string, number>;
}

interface VitalSample {
  metric: string;
  value: number;
  flags: Record<string, string>;
}

export function flaggrTelemetry(options: TelemetryOptions = {}): FlaggrPlugin {
  const {
    flushIntervalMs = 30_000,
    vitals: captureVitals = true,
    errors: captureErrors = true,
    beacon = true,
    endpoint,
  } = options;

  const flagStats = new Map<string, FlagAgg>();
  const vitalSamples: VitalSample[] = [];
  const errorLog: { message: string; flags: Record<string, string>; ts: number }[] = [];
  const activeFlags: Record<string, string> = {};
  let client: FlaggrClientInstance | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let sessionId = "";
  let vitalsObserver: PerformanceObserver | null = null;
  let onError: ((e: ErrorEvent) => void) | null = null;
  let onHide: (() => void) | null = null;
  /** The document's visibilitychange listener: kept so onDestroy can remove it. */
  let onVisibilityChange: (() => void) | null = null;
  /** No apiKey, or the endpoint refused it (401/403): no more telemetry from this client. */
  let refused = false;
  const requests: { durationMs: number; ok: boolean }[] = [];

  function agg(flagKey: string, result: EvaluationResult, durationMs: number, cached: boolean) {
    const key = flagKey;
    let a = flagStats.get(key);
    if (!a) {
      a = {
        evaluations: 0,
        cacheHits: 0,
        cacheMisses: 0,
        totalDurationMs: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
        variants: new Map(),
      };
      flagStats.set(key, a);
    }
    a.evaluations++;
    if (cached) a.cacheHits++; else a.cacheMisses++;
    a.totalDurationMs += durationMs;
    if (durationMs < a.minDurationMs) a.minDurationMs = durationMs;
    if (durationMs > a.maxDurationMs) a.maxDurationMs = durationMs;
    const variant = result.variant ?? String(result.value);
    a.variants.set(variant, (a.variants.get(variant) ?? 0) + 1);
    activeFlags[flagKey] = variant;
  }

  // Build the flush payload and drain the accumulators — the ingest sums
  // `evaluations` into its own store, so payloads must carry deltas, not
  // session-cumulative totals (otherwise every flush re-counts the same
  // evals and counts inflate geometrically).
  function payload() {
    const summaries = [...flagStats.entries()]
      .filter(([, a]) => a.evaluations > 0) // skip drained entries
      .map(([flagKey, a]) => ({
      flagKey,
      evaluations: a.evaluations,
      cacheHits: a.cacheHits,
      cacheMisses: a.cacheMisses,
        totalDurationMs: a.totalDurationMs,
        minDurationMs: a.minDurationMs === Infinity ? 0 : a.minDurationMs,
        maxDurationMs: a.maxDurationMs,
        variant: [...a.variants.entries()].sort((x, y) => y[1] - x[1])[0]?.[0],
      }));
    // Reset counters — keep the entries so variants maps stay warm.
    for (const a of flagStats.values()) {
      a.evaluations = 0;
      a.cacheHits = 0;
      a.cacheMisses = 0;
      a.totalDurationMs = 0;
      a.minDurationMs = Infinity;
      a.maxDurationMs = 0;
      a.variants.clear();
    }
    const vitals = vitalSamples.splice(0).map((v) => ({
      metric: v.metric,
      value: v.value,
      flags: v.flags,
      timestamp: Date.now(),
    }));
    const errors = errorLog.splice(0).map((e) => ({
      message: e.message,
      flags: e.flags,
      timestamp: new Date(e.ts).toISOString(),
    }));
    return {
      empty: summaries.length === 0 && vitals.length === 0 && errors.length === 0,
      batch: {
        serviceId: client?.getConfig().serviceId,
        sessionId,
        summaries,
        vitals,
        errors,
      },
    };
  }

  function stopSending(reason: string) {
    refused = true;
    if (timer) clearInterval(timer);
    timer = null;
    // Once per reason per page/process: SSR may build a client per request.
    if (!warned.has(reason)) {
      warned.add(reason);
      console.warn(`[flaggr/telemetry] ${reason}: no telemetry is sent from this client`);
    }
  }

  /**
   * A refused key (401/403) won't be accepted on a retry, and a host without
   * the endpoint (404/405: a data plane, say) never will be: stop sending.
   */
  function onResponse(url: string, response: Response) {
    if (refused) return;
    if (response.status === 401 || response.status === 403) {
      stopSending(`/api/analytics/sdk-telemetry refused the apiKey (${response.status})`);
    } else if (response.status === 404 || response.status === 405) {
      stopSending(
        `${url} doesn't serve telemetry (${response.status}); point flaggrTelemetry({ endpoint }) at the Flaggr app's ${TELEMETRY_PATH}`
      );
    }
  }

  function flush(pageHide: boolean) {
    if (!client || refused) return;
    const { apiUrl, apiKey } = client.getConfig();
    if (!apiKey) return; // onInit stopped the plugin
    const { empty, batch } = payload();
    if (empty) return; // nothing accumulated — don't churn requests
    const url = telemetryEndpoint(apiUrl, endpoint);
    const answered = (response: Response) => onResponse(url, response);

    const inBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    if (pageHide && beacon && inBrowser && sendOnPageHide(url, JSON.stringify({ ...batch, apiKey }), answered)) {
      return;
    }
    // Keepalive when the batch fits the page's 64 KiB keepalive budget: a
    // bigger one (many flags, each vital sample tagged with all of them)
    // would fail as a network error. It goes as a plain request instead.
    fetchWithKeepalive(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(batch),
    })
      .then(answered)
      .catch(() => {});
  }

  return {
    name: "flaggr-telemetry",

    onInit(c) {
      client = c;
      // The endpoint refuses batches without the project's SDK key (401).
      if (!c.getConfig().apiKey) {
        stopSending("flaggrTelemetry() needs the client's apiKey (the project's SDK key)");
        return;
      }
      sessionId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Periodic flush is env-agnostic — eval summaries are useful from
      // Node/SSR too. Only the vitals/error/pagehide listeners need a DOM.
      timer = setInterval(() => flush(false), flushIntervalMs);
      // Don't keep a Node/SSR process alive just to flush analytics.
      (timer as unknown as { unref?: () => void }).unref?.();

      if (typeof window === "undefined" || typeof document === "undefined") return;

      if (captureVitals && typeof PerformanceObserver !== "undefined") {
        try {
          vitalsObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              // FCP is a "paint" entry named first-contentful-paint (the
              // other paint entry, first-paint, isn't a Web Vital).
              const metric =
                entry.entryType === "largest-contentful-paint"
                  ? "lcp"
                  : entry.entryType === "layout-shift"
                    ? "cls"
                    : entry.entryType === "paint"
                      ? entry.name === "first-contentful-paint"
                        ? "fcp"
                        : null
                      : entry.entryType === "event"
                        ? "inp"
                        : entry.entryType === "navigation"
                          ? "ttfb"
                          : null;
              if (!metric) continue;
              if (metric === "cls" && (entry as { hadRecentInput?: boolean }).hadRecentInput) continue;
              const value =
                metric === "ttfb"
                  ? (entry as PerformanceNavigationTiming).responseStart
                  : metric === "inp"
                    ? entry.duration
                    : (entry as { value?: number; startTime?: number }).value ??
                      entry.startTime;
              if (vitalSamples.length < 200) {
                vitalSamples.push({ metric, value, flags: { ...activeFlags } });
              }
            }
          });
          for (const type of ["largest-contentful-paint", "layout-shift", "paint", "event", "navigation"]) {
            try {
              vitalsObserver.observe({ type, buffered: true } as PerformanceObserverInit);
            } catch {
              /* unsupported metric type */
            }
          }
        } catch {
          /* PerformanceObserver unavailable */
        }
      }

      if (captureErrors) {
        onError = (e: ErrorEvent) => {
          errorLog.push({ message: e.message ?? "unknown", flags: { ...activeFlags }, ts: Date.now() });
          if (errorLog.length > 100) errorLog.splice(0, errorLog.length - 100);
        };
        window.addEventListener("error", onError);
      }

      onHide = () => flush(true);
      onVisibilityChange = () => {
        if (document.visibilityState === "hidden") onHide?.();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("pagehide", onHide);
    },

    onEvaluateComplete(flagKey: string, result: EvaluationResult, durationMs: number) {
      agg(flagKey, result, durationMs, durationMs < 0.5);
    },

    onEvaluateError(flagKey: string, _error: Error, durationMs: number) {
      const a = flagStats.get(flagKey);
      if (a) {
        a.evaluations++;
        a.cacheMisses++;
        a.totalDurationMs += durationMs;
      }
    },

    onRequest(info: RequestInfo) {
      requests.push({ durationMs: info.durationMs, ok: info.ok });
      if (requests.length > 500) requests.splice(0, requests.length - 500);
    },

    onDestroy() {
      if (timer) clearInterval(timer);
      timer = null;
      vitalsObserver?.disconnect();
      vitalsObserver = null;
      if (onError) window.removeEventListener("error", onError);
      if (onHide) window.removeEventListener("pagehide", onHide);
      if (onVisibilityChange) document.removeEventListener("visibilitychange", onVisibilityChange);
      onError = onHide = onVisibilityChange = null;
      flush(true);
    },
  };
}
