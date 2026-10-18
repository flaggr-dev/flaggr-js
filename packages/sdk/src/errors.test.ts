import { afterEach, describe, expect, it, vi } from "vitest";
import { captureException, errorTrackingActive, flaggrErrors, type ErrorTrackingOptions } from "./errors";
import { flaggrTelemetry } from "./telemetry";
import type { FlaggrClientInstance } from "./types";

/**
 * flaggrErrors(): a browser's errors go to the app's SDK telemetry ingest
 * with the SDK key; a server's to /api/ingest/server-events with a project
 * API token (SDK keys are refused there). Each event carries the variants
 * the client evaluated, the release and environment, and its breadcrumbs.
 */

const API_URL = "https://flaggr.test";
const KEY = "fgr_sdk_key";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const plugins: Array<{ onDestroy?: () => void }> = [];

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.onDestroy?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fakeClient(apiKey: string | undefined = KEY, environment = "production"): FlaggrClientInstance {
  return { getConfig: () => ({ apiUrl: API_URL, apiKey, serviceId: "web", environment }) } as unknown as FlaggrClientInstance;
}

function okFetch(status = 202) {
  const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => new Response(null, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A browser page: window and document as event targets, a location and a history. */
function stubPage() {
  const win = Object.assign(new EventTarget(), { location: { href: "https://shop.test/cart?coupon=SECRET#top" } });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("history", { pushState: () => {}, replaceState: () => {} });
  return win;
}

function install(options: ErrorTrackingOptions = {}, client = fakeClient()) {
  const plugin = flaggrErrors({ release: "web@1.4.2", ...options });
  plugin.onInit?.(client);
  plugins.push(plugin);
  return plugin;
}

function sentBodies(fetchMock: ReturnType<typeof okFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({ url, headers: init?.headers, body: JSON.parse(init!.body!) }));
}

describe("flaggrErrors in a browser", () => {
  it("reports an uncaught error with its stack, the evaluated variants, release, environment and breadcrumbs, to the SDK telemetry ingest", async () => {
    const win = stubPage();
    const fetchMock = okFetch();
    const plugin = install();
    plugin.onEvaluateComplete?.("new-cart", { value: true, reason: "TARGETING_MATCH", variant: "treatment" }, 1);
    plugin.setUser({ id: "user-7" });
    plugin.setTag("plan", "pro");

    const error = new TypeError("Cannot read properties of undefined (reading 'price')");
    win.dispatchEvent(Object.assign(new Event("error"), { error, message: error.message }));
    await plugin.flush();

    const [sent] = sentBodies(fetchMock);
    expect(sent.url).toBe(`${API_URL}/api/analytics/sdk-telemetry`);
    expect(sent.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(sent.body.serviceId).toBe("web");
    expect(sent.body.errors).toHaveLength(1);
    const [event] = sent.body.errors;
    expect(event).toMatchObject({
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'price')",
      handled: false,
      level: "error",
      release: "web@1.4.2",
      environment: "production",
      user: { id: "user-7" },
      tags: { plan: "pro" },
      flags: { "new-cart": "treatment" },
      // Without its query string and fragment.
      pageUrl: "https://shop.test/cart",
    });
    expect(event.stack).toContain("TypeError");
    expect(event.breadcrumbs).toEqual([
      expect.objectContaining({ category: "flag", message: "new-cart = treatment" }),
    ]);
  });

  it("reports unhandled rejections, and ignores failed resource loads", async () => {
    const win = stubPage();
    const fetchMock = okFetch();
    const plugin = install();
    win.dispatchEvent(new Event("error")); // an <img> that failed: no error, no message
    win.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("fetch failed") }));
    await plugin.flush();
    const errors = sentBodies(fetchMock)[0].body.errors;
    expect(errors.map((e: { message: string }) => e.message)).toEqual(["fetch failed"]);
  });

  it("captureException sends handled errors with their context; the same error object only once", async () => {
    stubPage();
    const fetchMock = okFetch();
    const plugin = install();
    const error = new Error("checkout failed");
    captureException(error, { tags: { step: "pay" }, extra: { orderId: "o-1" }, fingerprint: "checkout-pay" });
    captureException(error);
    plugin.captureMessage("slow checkout", { level: "warning" });
    await plugin.flush();
    const errors = sentBodies(fetchMock)[0].body.errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ handled: true, tags: { step: "pay" }, extra: { orderId: "o-1" }, fingerprint: "checkout-pay" });
    expect(errors[1]).toMatchObject({ name: "Message", message: "slow checkout", level: "warning" });
  });

  it("drops what ignoreErrors, beforeSend or sampleRate say to, and a non-Error throw still reports", async () => {
    stubPage();
    const fetchMock = okFetch();
    const plugin = install({
      ignoreErrors: ["ResizeObserver loop", /^Script error\.?$/],
      beforeSend: (event) => (event.message.includes("secret") ? null : { ...event, tags: { ...event.tags, edited: "yes" } }),
    });
    plugin.captureException(new Error("ResizeObserver loop limit exceeded"));
    plugin.captureException(new Error("Script error."));
    plugin.captureException(new Error("leaked secret"));
    plugin.captureException({ code: 42 });
    await plugin.flush();
    const errors = sentBodies(fetchMock)[0].body.errors;
    expect(errors).toEqual([expect.objectContaining({ message: 'Non-Error thrown: {"code":42}', tags: { edited: "yes" } })]);

    const sampled = install({ sampleRate: 0, sessions: false });
    fetchMock.mockClear();
    sampled.captureException(new Error("never"));
    await sampled.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cuts message and stack to the ingest's 2,000 characters", async () => {
    stubPage();
    const fetchMock = okFetch();
    const plugin = install();
    const error = new Error("x".repeat(5000));
    error.stack = "y".repeat(5000);
    plugin.captureException(error);
    await plugin.flush();
    const [event] = sentBodies(fetchMock)[0].body.errors;
    expect(event.message).toHaveLength(2000);
    expect(event.stack).toHaveLength(2000);
  });

  it("records fetch and console breadcrumbs, but not the SDK's own requests", async () => {
    stubPage();
    const fetchMock = okFetch(200);
    const plugin = install();
    await fetch("https://shop.test/api/cart?token=abc");
    await fetch(`${API_URL}/api/flags/evaluate`);
    console.warn("cart is empty");
    plugin.captureException(new Error("boom"));
    await plugin.flush();
    const report = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/sdk-telemetry"));
    const crumbs = JSON.parse(report![1]!.body!).errors[0].breadcrumbs;
    expect(crumbs.map((c: { category: string; message: string }) => `${c.category}: ${c.message}`)).toEqual([
      "fetch: GET https://shop.test/api/cart",
      "console: cart is empty",
    ]);
  });

  it("stops sending once the ingest refuses the key", async () => {
    stubPage();
    const fetchMock = okFetch(403);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = install();
    plugin.captureException(new Error("one"));
    await plugin.flush();
    plugin.captureException(new Error("two"));
    await plugin.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps flaggrTelemetry from reporting the same window errors", async () => {
    const win = stubPage();
    const fetchMock = okFetch();
    const telemetry = flaggrTelemetry({ vitals: false, beacon: false });
    telemetry.onInit?.(fakeClient());
    const plugin = install();
    expect(errorTrackingActive()).toBe(true);
    win.dispatchEvent(Object.assign(new Event("error"), { error: new Error("once"), message: "once" }));
    await plugin.flush();
    telemetry.onDestroy?.(); // flushes whatever the telemetry plugin logged
    const reported = sentBodies(fetchMock).flatMap((sent) => sent.body.errors ?? []);
    // One report, flaggrErrors' (with its name and stack), none from the telemetry log.
    expect(reported).toEqual([expect.objectContaining({ name: "Error", message: "once" })]);
  });
});

describe("flaggrErrors trace propagation (browser)", () => {
  function headersOf(init: unknown): Headers {
    return new Headers((init as { headers?: HeadersInit } | undefined)?.headers);
  }

  it("adds an unsampled traceparent to same-origin requests and records its trace id on the breadcrumb", async () => {
    stubPage();
    const fetchMock = okFetch(200);
    const plugin = install({ sessions: false });
    await fetch("/api/cart");
    await fetch("https://other.test/api");
    await fetch("/api/pinned", { headers: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" } });

    const sameOrigin = headersOf(fetchMock.mock.calls[0][1]).get("traceparent");
    expect(sameOrigin).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(headersOf(fetchMock.mock.calls[1][1]).get("traceparent")).toBeNull();
    expect(headersOf(fetchMock.mock.calls[2][1]).get("traceparent")).toBe("00-11111111111111111111111111111111-2222222222222222-01");

    plugin.captureException(new Error("after the fetch"));
    await plugin.flush();
    const report = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/sdk-telemetry"));
    const crumb = JSON.parse(report![1]!.body!).errors[0].breadcrumbs.find((c: { message: string }) => c.message === "GET https://shop.test/api/cart" || c.message === "GET /api/cart");
    expect(crumb.data.traceId).toBe(sameOrigin!.split("-")[1]);
  });

  it("propagates only to the targets given, and not at all with []", async () => {
    stubPage();
    const fetchMock = okFetch(200);
    install({ sessions: false, tracePropagationTargets: ["https://api.shop.test/"] });
    await fetch("https://api.shop.test/v1/orders");
    await fetch("/api/cart");
    expect(headersOf(fetchMock.mock.calls[0][1]).get("traceparent")).not.toBeNull();
    expect(headersOf(fetchMock.mock.calls[1][1]).get("traceparent")).toBeNull();
  });
});

describe("flaggrErrors release health sessions (browser)", () => {
  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    return store;
  }

  it("reports the tab's session once, with the release and environment; its errors carry the session id", async () => {
    stubPage();
    stubStorage();
    const fetchMock = okFetch();
    const plugin = install();
    await plugin.flush();
    const [first] = sentBodies(fetchMock);
    expect(first.body.releaseSessions).toEqual([
      { sessionId: expect.any(String), release: "web@1.4.2", environment: "production", startedAt: expect.any(Number) },
    ]);
    expect(first.body.errors).toEqual([]);
    const sessionId = first.body.releaseSessions[0].sessionId;
    expect(first.body.sessionId).toBe(sessionId);

    plugin.captureException(new Error("later"));
    await plugin.flush();
    const second = sentBodies(fetchMock)[1];
    expect(second.body.releaseSessions).toBeUndefined();
    expect(second.body.sessionId).toBe(sessionId);
  });

  it("keeps the session across page loads in the tab, and starts a new one after 30 idle minutes", async () => {
    stubPage();
    const store = stubStorage();
    const fetchMock = okFetch();
    const first = install();
    await first.flush();
    first.onDestroy?.();
    const id = sentBodies(fetchMock)[0].body.releaseSessions[0].sessionId;

    fetchMock.mockClear();
    const reload = install();
    reload.captureException(new Error("x"));
    await reload.flush();
    expect(sentBodies(fetchMock)[0].body.sessionId).toBe(id);
    expect(sentBodies(fetchMock)[0].body.releaseSessions).toBeUndefined();
    reload.onDestroy?.();

    const saved = JSON.parse(store.get("flaggr_errors_session")!);
    store.set("flaggr_errors_session", JSON.stringify({ ...saved, lastActive: Date.now() - 31 * 60_000 }));
    fetchMock.mockClear();
    const later = install();
    await later.flush();
    expect(sentBodies(fetchMock)[0].body.releaseSessions[0].sessionId).not.toBe(id);
  });

  it("sends no session with sessions: false", async () => {
    stubPage();
    stubStorage();
    const fetchMock = okFetch();
    const plugin = install({ sessions: false });
    await plugin.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("flaggrErrors on a server", () => {
  it("sends to /api/ingest/server-events with serverToken, as error events with the context in data", async () => {
    const fetchMock = okFetch();
    const plugin = install({ autoCapture: false, serverToken: "fgr_project_token", serverServiceId: "svc-1" });
    plugin.onEvaluateComplete?.("coupon-engine", { value: "v2", reason: "TARGETING_MATCH", variant: "v2" }, 1);
    plugin.captureException(new Error("payment timeout"), { user: { id: "u-9" }, extra: { orderId: "o-2", handled: "overwritten?" }, fingerprint: "pay" });
    await plugin.flush();

    const [sent] = sentBodies(fetchMock);
    expect(sent.url).toBe(`${API_URL}/api/ingest/server-events`);
    expect(sent.headers).toMatchObject({ Authorization: "Bearer fgr_project_token" });
    expect(sent.body.events).toEqual([
      expect.objectContaining({
        kind: "error",
        serviceId: "svc-1",
        environment: "production",
        release: "web@1.4.2",
        name: "Error",
        message: "payment timeout",
        fingerprint: "custom_pay",
        data: expect.objectContaining({
          handled: true,
          level: "error",
          userId: "u-9",
          orderId: "o-2",
          flags: { "coupon-engine": "v2" },
          sdkService: "web",
        }),
      }),
    ]);
    expect(Date.parse(sent.body.events[0].timestamp)).not.toBeNaN();
  });

  it("takes FLAGGR_ERRORS_TOKEN over the client's apiKey, and says what a server needs when the key is refused", async () => {
    vi.stubEnv("FLAGGR_ERRORS_TOKEN", "fgr_env_token");
    const fetchMock = okFetch(403);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = install({ autoCapture: false });
    plugin.captureException(new Error("x"));
    await plugin.flush();
    expect(sentBodies(fetchMock)[0].headers).toMatchObject({ Authorization: "Bearer fgr_env_token" });
    expect(String(warn.mock.calls[0][0])).toMatch(/project API token/);
  });

  it("on an uncaught exception, sends it as fatal, then exits with code 1 as Node would", async () => {
    const fetchMock = okFetch();
    let listener: ((error: unknown, origin: unknown) => void) | undefined;
    vi.spyOn(process, "on").mockImplementation(((event: string, fn: (error: unknown, origin: unknown) => void) => {
      if (event === "uncaughtException") listener = fn;
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "listenerCount").mockReturnValue(1);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    install({ serverToken: "fgr_project_token" });

    listener!(new Error("crash"), "uncaughtException");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    const [event] = sentBodies(fetchMock)[0].body.events;
    expect(event).toMatchObject({ message: "crash", data: expect.objectContaining({ level: "fatal", handled: false }) });
  });

  it("leaves the process alone with exitOnUncaught: false", async () => {
    okFetch();
    let listener: ((error: unknown, origin: unknown) => void) | undefined;
    vi.spyOn(process, "on").mockImplementation(((event: string, fn: (error: unknown, origin: unknown) => void) => {
      if (event === "uncaughtException") listener = fn;
      return process;
    }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const plugin = install({ serverToken: "t", exitOnUncaught: false });
    listener!(new Error("crash"), "uncaughtException");
    await plugin.flush();
    expect(exit).not.toHaveBeenCalled();
  });
});
