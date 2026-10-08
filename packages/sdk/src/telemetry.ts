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

import type {
  EvaluationResult,
  FlaggrClientInstance,
  FlaggrPlugin,
  RequestInfo,
} from "./types";

export interface TelemetryOptions {
  /** ms between periodic flushes (default 30000) */
  flushIntervalMs?: number;
  /** capture LCP/CLS/FCP/INP/TTFB via PerformanceObserver (default true) */
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
}

/** Why telemetry stopped, already reported by console.warn. */
const warned = new Set<string>();

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
 * keepalive fetch isn't supported. Returns false when neither went out.
 */
function sendOnPageHide(url: string, body: string, onResponse: (response: Response) => void): boolean {
  if (keepaliveFetchSupported()) {
    try {
      fetch(url, { method: "POST", keepalive: true, headers: { "Content-Type": "text/plain" }, body })
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

  /** A refused key (401/403) won't be accepted on a retry: stop sending. */
  function onResponse(response: Response) {
    if (!refused && (response.status === 401 || response.status === 403)) {
      stopSending(`/api/analytics/sdk-telemetry refused the apiKey (${response.status})`);
    }
  }

  function flush(pageHide: boolean) {
    if (!client || refused) return;
    const { apiUrl, apiKey } = client.getConfig();
    if (!apiKey) return; // onInit stopped the plugin
    const { empty, batch } = payload();
    if (empty) return; // nothing accumulated — don't churn requests
    const url = `${apiUrl}/api/analytics/sdk-telemetry`;

    const inBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    if (pageHide && beacon && inBrowser && sendOnPageHide(url, JSON.stringify({ ...batch, apiKey }), onResponse)) {
      return;
    }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(batch),
      keepalive: true,
    })
      .then(onResponse)
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
              const metric =
                entry.entryType === "largest-contentful-paint"
                  ? "lcp"
                  : entry.entryType === "layout-shift"
                    ? "cls"
                    : entry.entryType === "first-contentful-paint"
                      ? "fcp"
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
          for (const type of ["largest-contentful-paint", "layout-shift", "first-contentful-paint", "event", "navigation"]) {
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
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") onHide?.();
      });
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
      vitalsObserver?.disconnect();
      if (onError) window.removeEventListener("error", onError);
      if (onHide) window.removeEventListener("pagehide", onHide);
      flush(true);
    },
  };
}
