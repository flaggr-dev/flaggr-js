import { afterEach, describe, expect, it, vi } from "vitest";
import { flaggrTelemetry, telemetryEndpoint, type TelemetryOptions } from "./telemetry";
import type { FlaggrClientInstance } from "./types";

/**
 * POST /api/analytics/sdk-telemetry takes only the project's SDK key: as a
 * bearer header, or — from a request that outlives the page, which can't
 * carry one without a CORS preflight — as `apiKey` in the body.
 */

const API_URL = "https://flaggr.test";
const KEY = "fgr_sdk_key";
const ENDPOINT = `${API_URL}/api/analytics/sdk-telemetry`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeClient(apiKey: string | undefined, apiUrl = API_URL): FlaggrClientInstance {
  return {
    getConfig: () => ({ apiUrl, apiKey, serviceId: "web" }),
  } as unknown as FlaggrClientInstance;
}

/** A browser page: window and document as event targets, and the given navigator. */
function stubPage(nav: Record<string, unknown>) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", nav);
  return { win, doc };
}

/** The plugin, initialised (null: a client without an apiKey), with one evaluation accumulated. */
function installed(apiKey: string | null = KEY, options: TelemetryOptions = {}, apiUrl = API_URL) {
  const plugin = flaggrTelemetry({ vitals: false, errors: false, ...options });
  plugin.onInit?.(fakeClient(apiKey ?? undefined, apiUrl));
  plugin.onEvaluateComplete?.("new-nav", { value: true, reason: "STATIC", variant: "on" }, 2);
  return plugin;
}

type FetchInit = { method?: string; keepalive?: boolean; headers?: Record<string, string>; body?: string };

function okFetch() {
  const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("flaggrTelemetry page-hide flush", () => {
  it.each(["pagehide", "visibilitychange"])(
    "sends the %s batch as a keepalive text/plain fetch with the key in the body, never a header or the URL",
    (event) => {
      const sendBeacon = vi.fn(() => true);
      const { win, doc } = stubPage({ sendBeacon });
      const fetchMock = okFetch();
      installed();

      if (event === "pagehide") {
        win.dispatchEvent(new Event("pagehide"));
      } else {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      }

      // keepalive fetch wins over sendBeacon: it keeps the page's real Origin.
      expect(sendBeacon).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(ENDPOINT);
      expect(init).toMatchObject({ method: "POST", keepalive: true });
      // text/plain is CORS-safelisted: no preflight for a request that outlives the page.
      expect(init?.headers).toEqual({ "Content-Type": "text/plain" });
      const body = JSON.parse(init!.body!);
      expect(body).toMatchObject({ apiKey: KEY, serviceId: "web" });
      expect(body.summaries).toEqual([expect.objectContaining({ flagKey: "new-nav", evaluations: 1 })]);
    }
  );

  it("falls back to navigator.sendBeacon (text/plain, key in the body) where fetch has no keepalive", async () => {
    const sendBeacon = vi.fn((_url: string, _data?: unknown) => true);
    const { win } = stubPage({ sendBeacon });
    vi.stubGlobal("Request", undefined); // no Request#keepalive (Firefox before 133)
    const fetchMock = okFetch();
    installed();

    win.dispatchEvent(new Event("pagehide"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("text/plain");
    expect(JSON.parse(await (blob as Blob).text())).toMatchObject({ apiKey: KEY, serviceId: "web" });
  });

  it("sends the batch with fetch when sendBeacon throws, so the drained batch isn't lost", () => {
    const sendBeacon = vi.fn(() => {
      throw new TypeError("Illegal invocation");
    });
    stubPage({ sendBeacon });
    vi.stubGlobal("Request", undefined);
    const fetchMock = okFetch();
    const plugin = installed();

    expect(() => plugin.onDestroy?.()).not.toThrow();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(init!.body!).summaries).toHaveLength(1);
  });

  it.each([401, 403])(
    "stops sending when the page-hide request is refused with %i and the tab lives on",
    async (status) => {
      vi.useFakeTimers();
      const { doc } = stubPage({ sendBeacon: vi.fn(() => true) });
      const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const plugin = installed(KEY, { flushIntervalMs: 1000 });

      // A tab switch: the page is hidden, not unloaded.
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ keepalive: true, headers: { "Content-Type": "text/plain" } });
      await vi.advanceTimersByTimeAsync(0); // the refusal arrives

      doc.visibilityState = "visible";
      plugin.onEvaluateComplete?.("new-nav", { value: false, reason: "STATIC", variant: "off" }, 1);
      await vi.advanceTimersByTimeAsync(5000);
      plugin.onDestroy?.();

      // A refused key won't be accepted on a retry.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("with beacon: false, sends the page-hide batch as a regular request with the bearer header", () => {
    const sendBeacon = vi.fn(() => true);
    const { win } = stubPage({ sendBeacon });
    const fetchMock = okFetch();
    installed(KEY, { beacon: false });

    win.dispatchEvent(new Event("pagehide"));

    expect(sendBeacon).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(init!.body!)).not.toHaveProperty("apiKey");
  });
});

describe("flaggrTelemetry periodic flush", () => {
  it("sends the key as a bearer header and keeps it out of the body", async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    const plugin = installed(KEY, { flushIntervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(init!.body!)).not.toHaveProperty("apiKey");
    plugin.onDestroy?.();
  });

  it("sends nothing without an apiKey: the endpoint would refuse every batch", async () => {
    vi.useFakeTimers();
    const sendBeacon = vi.fn(() => true);
    const { win } = stubPage({ sendBeacon });
    const fetchMock = okFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = installed(null, { flushIntervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(5000);
    win.dispatchEvent(new Event("pagehide"));
    plugin.onDestroy?.();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("apiKey"));
  });

  it.each([401, 403])("stops sending once the endpoint refuses the key with %i", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => new Response(null, { status }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = installed(KEY, { flushIntervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    plugin.onEvaluateComplete?.("new-nav", { value: false, reason: "STATIC", variant: "off" }, 1);
    await vi.advanceTimersByTimeAsync(5000);
    plugin.onDestroy?.();

    // A refused key won't be accepted on a retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([404, 405])(
    "stops sending once the host answers %i (it serves no telemetry) and says to set endpoint",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const plugin = installed(KEY, { flushIntervalMs: 1000 }, "https://flaggr-api.internal.example");

      await vi.advanceTimersByTimeAsync(1000);
      plugin.onEvaluateComplete?.("new-nav", { value: false, reason: "STATIC", variant: "off" }, 1);
      await vi.advanceTimersByTimeAsync(5000);
      plugin.onDestroy?.();

      // The batch would never be stored there: no request every flushIntervalMs for the page's lifetime.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("endpoint"));
    }
  );

  it("keeps sending after a server error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin = installed(KEY, { flushIntervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    plugin.onEvaluateComplete?.("new-nav", { value: false, reason: "STATIC", variant: "off" }, 1);
    await vi.advanceTimersByTimeAsync(1000);
    plugin.onDestroy?.();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The hosted data plane (https://api.flaggr.dev, the client's default apiUrl)
 * serves only evaluation: POST /api/analytics/sdk-telemetry is the Flaggr
 * app's. A batch posted next to that apiUrl gets a 404, forever.
 */
describe("flaggrTelemetry endpoint", () => {
  it("sends the hosted data plane's batches to the Flaggr app", async () => {
    vi.useFakeTimers();
    const sendBeacon = vi.fn(() => true);
    const { win } = stubPage({ sendBeacon });
    const fetchMock = okFetch();
    const plugin = installed(KEY, { flushIntervalMs: 1000 }, "https://api.flaggr.dev");

    await vi.advanceTimersByTimeAsync(1000);
    plugin.onEvaluateComplete?.("new-nav", { value: false, reason: "STATIC", variant: "off" }, 1);
    win.dispatchEvent(new Event("pagehide"));
    plugin.onDestroy?.();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://flaggr.dev/api/analytics/sdk-telemetry",
      "https://flaggr.dev/api/analytics/sdk-telemetry",
    ]);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("sends batches to the endpoint option when it is set", async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    const plugin = installed(
      KEY,
      { flushIntervalMs: 1000, endpoint: "https://flags.example.com/api/analytics/sdk-telemetry" },
      "https://flags-data.example.com"
    );

    await vi.advanceTimersByTimeAsync(1000);
    plugin.onDestroy?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://flags.example.com/api/analytics/sdk-telemetry");
  });

  it.each([
    ["https://api.flaggr.dev", "https://flaggr.dev/api/analytics/sdk-telemetry"],
    ["https://api.flaggr.dev/", "https://flaggr.dev/api/analytics/sdk-telemetry"],
    ["https://API.flaggr.dev:8443", "https://flaggr.dev/api/analytics/sdk-telemetry"],
    ["https://flaggr.dev", "https://flaggr.dev/api/analytics/sdk-telemetry"],
    ["http://localhost:3000/", "http://localhost:3000/api/analytics/sdk-telemetry"],
    ["https://flags.example.com", "https://flags.example.com/api/analytics/sdk-telemetry"],
  ])("apiUrl %s posts to %s", (apiUrl, expected) => {
    expect(telemetryEndpoint(apiUrl)).toBe(expected);
  });

  it("posts to the page's own origin when apiUrl is empty, where the client evaluates too", async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    // `apiUrl: ""`: the client evaluates at the page's own /api/flags/evaluate (a same-origin proxy).
    const plugin = installed(KEY, { flushIntervalMs: 1000 }, "");

    await vi.advanceTimersByTimeAsync(1000);
    plugin.onDestroy?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/analytics/sdk-telemetry");
  });

  it("posts to the Flaggr app when apiUrl is unset (the client's default is the hosted data plane)", () => {
    expect(telemetryEndpoint(undefined)).toBe("https://flaggr.dev/api/analytics/sdk-telemetry");
  });
});

describe("flaggrTelemetry Web Vitals", () => {
  /**
   * PerformanceObserver as browsers have it: observe() ignores an entry type
   * it doesn't support (there is no "first-contentful-paint" type: FCP is a
   * "paint" entry with that name), and an observer gets only the entries of
   * the types it observes.
   */
  class FakeObserver {
    static instances: FakeObserver[] = [];
    static readonly supported = ["largest-contentful-paint", "layout-shift", "paint", "event", "navigation"];
    readonly types = new Set<string>();
    constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {
      FakeObserver.instances.push(this);
    }
    /** Entries recorded before any observer was created (FCP usually is, before the SDK loads). */
    static earlier: Array<{ entryType: string; name: string; startTime: number; duration?: number }> = [];
    observe({ type, buffered }: { type: string; buffered?: boolean }) {
      if (!FakeObserver.supported.includes(type)) return;
      this.types.add(type);
      // Only a buffered observer gets the entries from before it observed.
      if (buffered) {
        const earlier = FakeObserver.earlier.filter((entry) => entry.entryType === type);
        if (earlier.length) queueMicrotask(() => this.callback({ getEntries: () => earlier }));
      }
    }
    disconnect() {
      this.types.clear();
    }
    deliver(entries: Array<{ entryType: string; name: string; startTime: number; duration?: number }>) {
      const observed = entries.filter((entry) => this.types.has(entry.entryType));
      if (observed.length) this.callback({ getEntries: () => observed });
    }
  }

  it("reports FCP from the first-contentful-paint paint entry", async () => {
    vi.useFakeTimers();
    stubPage({});
    FakeObserver.instances = [];
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    const fetchMock = okFetch();
    const plugin = flaggrTelemetry({ errors: false, flushIntervalMs: 1000 });
    plugin.onInit?.(fakeClient(KEY));
    plugin.onEvaluateComplete?.("new-nav", { value: true, reason: "STATIC", variant: "on" }, 2);

    FakeObserver.instances[0].deliver([
      { entryType: "paint", name: "first-paint", startTime: 90 },
      { entryType: "paint", name: "first-contentful-paint", startTime: 123.5 },
      { entryType: "largest-contentful-paint", name: "", startTime: 400 },
    ]);
    await vi.advanceTimersByTimeAsync(1000);

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body!) as {
      vitals: Array<{ metric: string; value: number; flags: Record<string, string> }>;
    };
    expect(body.vitals.map(({ metric, value, flags }) => [metric, value, flags])).toEqual([
      ["fcp", 123.5, { "new-nav": "on" }],
      ["lcp", 400, { "new-nav": "on" }],
    ]);
    plugin.onDestroy?.();
  });

  it("reports the FCP the page painted before the plugin started: it observes paint entries buffered", async () => {
    vi.useFakeTimers();
    stubPage({});
    FakeObserver.instances = [];
    FakeObserver.earlier = [
      { entryType: "paint", name: "first-paint", startTime: 80 },
      { entryType: "paint", name: "first-contentful-paint", startTime: 95 },
    ];
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    const fetchMock = okFetch();
    const plugin = flaggrTelemetry({ errors: false, flushIntervalMs: 1000 });
    plugin.onEvaluateComplete?.("new-nav", { value: true, reason: "STATIC", variant: "on" }, 2);
    plugin.onInit?.(fakeClient(KEY));
    await vi.advanceTimersByTimeAsync(1000);

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body!) as { vitals: Array<{ metric: string; value: number }> };
    expect(body.vitals.map(({ metric, value }) => [metric, value])).toEqual([["fcp", 95]]);
    FakeObserver.earlier = [];
    plugin.onDestroy?.();
  });
});

describe("flaggrTelemetry onDestroy", () => {
  it("removes the listeners it added to the page", () => {
    const { win, doc } = stubPage({ sendBeacon: vi.fn(() => true) });
    okFetch();
    const added = [vi.spyOn(win, "addEventListener"), vi.spyOn(doc, "addEventListener")];
    const removed = [vi.spyOn(win, "removeEventListener"), vi.spyOn(doc, "removeEventListener")];
    const plugin = flaggrTelemetry({ vitals: false });
    plugin.onInit?.(fakeClient(KEY));
    const listeners = added.map((spy) => spy.mock.calls.map(([type, listener]) => [type, listener]));
    expect(listeners.map((calls) => calls.map(([type]) => type))).toEqual([["error", "pagehide"], ["visibilitychange"]]);

    plugin.onDestroy?.();

    // Each one, by the function it was added with.
    expect(removed.map((spy) => spy.mock.calls.map(([type, listener]) => [type, listener]))).toEqual(listeners);
  });

  it("removes its visibilitychange listener: a hidden page doesn't flush a destroyed plugin", () => {
    const { doc } = stubPage({ sendBeacon: vi.fn(() => true) });
    const fetchMock = okFetch();
    const plugin = installed();
    plugin.onDestroy?.(); // flushes the accumulated evaluation
    expect(fetchMock).toHaveBeenCalledTimes(1);

    plugin.onEvaluateComplete?.("new-nav", { value: true, reason: "STATIC", variant: "on" }, 2);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("flaggrTelemetry and the 64 KiB keepalive budget", () => {
  /** Accumulate enough flags for a batch well over 64 KiB. */
  const bigBatch = (plugin: ReturnType<typeof installed>) => {
    for (let i = 0; i < 800; i++) {
      plugin.onEvaluateComplete?.(`flag-${i}-${"x".repeat(60)}`, { value: true, reason: "STATIC", variant: "on" }, 1);
    }
  };

  it("sends a periodic batch over the budget as a plain request: a keepalive one would fail", async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    const plugin = installed(KEY, { flushIntervalMs: 1000 });
    bigBatch(plugin);

    await vi.advanceTimersByTimeAsync(1000);

    const [, init] = fetchMock.mock.calls[0];
    expect(init!.body!.length).toBeGreaterThan(64 * 1024);
    expect(init).toMatchObject({ keepalive: false, headers: { Authorization: `Bearer ${KEY}` } });
    plugin.onDestroy?.();
  });

  it("keeps a periodic batch within the budget on a keepalive request", async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    const plugin = installed(KEY, { flushIntervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ keepalive: true, headers: { Authorization: `Bearer ${KEY}` } });
    plugin.onDestroy?.();
  });

  it("sends a page-hide batch over the budget as a plain request with the bearer header, not a beacon", () => {
    const sendBeacon = vi.fn(() => true);
    const { win } = stubPage({ sendBeacon });
    const fetchMock = okFetch();
    const plugin = installed();
    bigBatch(plugin);

    win.dispatchEvent(new Event("pagehide"));

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({
      keepalive: false,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    });
    expect(JSON.parse(init!.body!).apiKey).toBeUndefined();
  });
});
