import { afterEach, describe, expect, it, vi } from "vitest";
import { FlaggrClient } from "./client";
import type { FlaggrPlugin, RequestInfo } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FlaggrClient", () => {
  it("returns configured defaults without making a remote request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const plugin: FlaggrPlugin = {
      name: "observer",
      onEvaluateComplete: vi.fn(),
    };
    const client = new FlaggrClient({
      serviceId: "web",
      defaults: { "new-nav": true },
      plugins: [plugin],
    });

    await expect(client.getBooleanValue("new-nav", false)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(plugin.onEvaluateComplete).toHaveBeenCalledWith(
      "new-nav",
      { value: true, reason: "DEFAULT" },
      expect.any(Number),
    );
  });

  it("posts authenticated evaluation requests and caches successful results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: "treatment", reason: "TARGETING_MATCH", variant: "b" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "flg_test",
      serviceId: "checkout",
      environment: "production",
      context: { targetingKey: "user-1", plan: "pro" },
    });

    await expect(
      client.getStringValue("checkout-copy", "control", { locale: "en-AU" }),
    ).resolves.toBe("treatment");
    // Same context variant → cache hit, no second fetch
    await expect(
      client.getStringValue("checkout-copy", "control", { locale: "en-AU" }),
    ).resolves.toBe("treatment");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://flaggr.test/api/flags/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer flg_test",
      },
      body: JSON.stringify({
        flagKey: "checkout-copy",
        serviceId: "checkout",
        environment: "production",
        context: { targetingKey: "user-1", plan: "pro", locale: "en-AU" },
        defaultValue: "control",
      }),
    });
  });

  it("clears cached evaluations when context changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: true, reason: "STATIC" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: false, reason: "STATIC" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      context: { targetingKey: "user-1" },
    });

    await expect(client.getBooleanValue("show-banner", false)).resolves.toBe(true);
    client.setContext({ targetingKey: "user-2" });
    await expect(client.getBooleanValue("show-banner", true)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share cached results across different per-call contexts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: "alpha", reason: "TARGETING_MATCH" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: "beta", reason: "TARGETING_MATCH" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
    });

    await expect(
      client.getStringValue("greeting", "x", { targetingKey: "user-a" }),
    ).resolves.toBe("alpha");
    // A different context must not be served user-a's cached result.
    await expect(
      client.getStringValue("greeting", "x", { targetingKey: "user-b" }),
    ).resolves.toBe("beta");
    // And the original context still hits its own cache entry.
    await expect(
      client.getStringValue("greeting", "x", { targetingKey: "user-a" }),
    ).resolves.toBe("alpha");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the provided default and notifies plugins when remote evaluation fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    const plugin: FlaggrPlugin = {
      name: "errors",
      onEvaluateError: vi.fn(),
    };
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "bad",
      serviceId: "web",
      plugins: [plugin],
    });

    const result = await client.evaluate("paywall", false);

    expect(result).toMatchObject({
      value: false,
      reason: "ERROR",
      errorMessage: "Unauthorized: invalid or missing API key",
    });
    expect(plugin.onEvaluateError).toHaveBeenCalledWith(
      "paywall",
      expect.any(Error),
      expect.any(Number),
    );
  });
});

describe("FlaggrClient local evaluation", () => {
  it("evaluates bootstrap configuration locally with zero network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: {
        flags: [
          { key: "hero-banner", type: "boolean", enabled: true, defaultValue: true },
          {
            key: "checkout-copy",
            type: "string",
            enabled: true,
            defaultValue: "control",
            targeting: [
              {
                id: "r1",
                conditions: [{ property: "plan", operator: "equals", value: "pro" }],
                value: "treatment",
                variant: "b",
              },
            ],
          },
        ],
        version: "v1",
      },
      context: { targetingKey: "u1", plan: "pro" },
    });

    expect(client.localFlagCount).toBe(2);
    await expect(client.getBooleanValue("hero-banner", false)).resolves.toBe(true);
    await expect(client.getStringValue("checkout-copy", "x")).resolves.toBe("treatment");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getConfigurationVersion()).toBe("v1");
  });

  it("evaluateSync resolves from configuration without network", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: {
        flags: [{ key: "grid-cell", type: "boolean", enabled: true, defaultValue: true }],
      },
    });

    expect(client.getBooleanValueSync("grid-cell", false)).toBe(true);
    expect(client.getBooleanValueSync("missing", false)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent remote evaluations per flag+context", async () => {
    let resolveFetch: (v: unknown) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web" });
    const p1 = client.getBooleanValue("flag", false, { plan: "pro" });
    const p2 = client.getBooleanValue("flag", false, { plan: "pro" });
    // evaluate() awaits configReady first — the fetch lands a microtask later
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    resolveFetch!({ ok: true, json: async () => ({ value: true, reason: "STATIC" }) });
    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("configuration_sync updates values and notifies only on real changes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const listeners: Array<(e: MessageEvent) => void> = [];
    const mockSource = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((e: MessageEvent) => void),
      onerror: null as null | (() => void),
      addEventListener: (name: string, fn: (e: MessageEvent) => void) => {
        if (name === "configuration_sync") listeners.push(fn);
      },
      close: vi.fn(),
    };
    vi.stubGlobal("EventSource", vi.fn(() => mockSource));

    // Keyless: EventSource. (With an apiKey the client streams over fetch.)
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      enableStreaming: true,
    });
    const changes: string[] = [];
    client.onFlagChange("hero", (e) => changes.push(String(e.newValue)));

    const sync = (enabled: boolean, version: string) =>
      listeners.forEach((fn) =>
        fn({
          data: JSON.stringify({
            type: "configuration_sync",
            version,
            flags: [{ key: "hero", type: "boolean", enabled, defaultValue: enabled }],
          }),
        } as MessageEvent),
      );

    sync(true, "v1");
    expect(client.getBooleanValueSync("hero", false)).toBe(true);
    sync(true, "v2"); // same value — no duplicate notification
    sync(false, "v3");
    expect(client.getBooleanValueSync("hero", true)).toBe(false);
    expect(changes).toEqual(["true", "false"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("configuration_delta applies changed and removed flags incrementally", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const listeners = new Map<string, Array<(e: MessageEvent) => void>>();
    const mockSource = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((e: MessageEvent) => void),
      onerror: null as null | (() => void),
      addEventListener: (name: string, fn: (e: MessageEvent) => void) => {
        const arr = listeners.get(name) ?? [];
        arr.push(fn);
        listeners.set(name, arr);
      },
      close: vi.fn(),
    };
    vi.stubGlobal("EventSource", vi.fn(() => mockSource));

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      enableStreaming: true,
    });
    const changes: string[] = [];
    client.onFlagChange("hero", (e) => changes.push(String(e.newValue)));

    const emit = (name: string, payload: unknown) =>
      listeners.get(name)?.forEach((fn) => fn({ data: JSON.stringify(payload) } as MessageEvent));

    emit("configuration_sync", {
      type: "configuration_sync",
      version: "v1",
      flags: [
        { key: "hero", type: "boolean", enabled: true, defaultValue: true },
        { key: "extra", type: "boolean", enabled: true, defaultValue: true },
        { key: "stable", type: "boolean", enabled: true, defaultValue: true },
      ],
    });
    expect(client.getBooleanValueSync("hero", false)).toBe(true);
    expect(client.getBooleanValueSync("extra", false)).toBe(true);

    emit("configuration_delta", {
      type: "configuration_delta",
      version: "v2",
      flags: [{ key: "hero", type: "boolean", enabled: false, defaultValue: false }],
      removed: ["extra"],
    });

    expect(client.getBooleanValueSync("hero", true)).toBe(false);
    // Untouched flags keep evaluating locally — no re-sync needed.
    expect(client.getBooleanValueSync("stable", false)).toBe(true);
    // Removed flag falls back to the caller default.
    expect(client.getBooleanValueSync("extra", false)).toBe(false);
    expect(changes).toEqual(["true", "false"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("update modes", () => {
  const sseStub = () => {
    const mockSource = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((e: MessageEvent) => void),
      onerror: null as null | (() => void),
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    const ctor = vi.fn(() => mockSource);
    vi.stubGlobal("EventSource", ctor);
    return { mockSource, ctor };
  };

  it("defaults to poll mode — no SSE, no periodic transport", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: true, reason: "STATIC" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ctor } = sseStub();

    const client = new FlaggrClient({ serviceId: "web" });
    expect(client.getUpdateMode()).toBe("poll");
    expect(ctor).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();
    client.destroy();
    vi.useRealTimers();
  });

  it("maps enableStreaming to stream mode for backwards compatibility", () => {
    const { ctor } = sseStub();
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      enableStreaming: true,
    });
    expect(client.getUpdateMode()).toBe("stream");
    expect(ctor).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it("batch mode issues one grouped POST per interval for watched flags", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        flags: [
          { key: "hero", value: true, reason: "STATIC" },
          { key: "promo", value: false, reason: "STATIC" },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      apiKey: "flg_x",
      updateMode: "batch",
      batchIntervalMs: 1000,
    });
    client.onFlagChange("hero", vi.fn());
    client.onFlagChange("promo", vi.fn());

    // Listeners registered after construction — first interval covers both.
    await vi.advanceTimersByTimeAsync(1000);
    const batchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/flags/evaluate/batch"),
    );
    expect(batchCalls).toHaveLength(1);
    const body = JSON.parse(String(batchCalls[0][1]?.body)) as {
      flags: Array<{ key: string }>;
    };
    expect(body.flags.map((f: { key: string }) => f.key).sort()).toEqual([
      "hero",
      "promo",
    ]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/flags/evaluate/batch"),
      ),
    ).toHaveLength(3);

    client.destroy();
    vi.useRealTimers();
  });

  it("stream → batch → poll transitions tear down each transport", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ flags: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { mockSource, ctor } = sseStub();

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      updateMode: "stream",
      batchIntervalMs: 1000,
    });
    expect(ctor).toHaveBeenCalledTimes(1);
    client.onFlagChange("hero", vi.fn());

    client.setUpdateMode("batch");
    expect(mockSource.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    const batchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/flags/evaluate/batch"),
    );
    expect(batchCalls.length).toBeGreaterThanOrEqual(3); // catch-up + 2 ticks

    client.setUpdateMode("poll");
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();

    client.setUpdateMode("stream");
    expect(ctor).toHaveBeenCalledTimes(2);

    client.destroy();
    expect(mockSource.close).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("batch refresh notifies listeners only on observed value changes", async () => {
    vi.useFakeTimers();
    let heroValue = true;
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        flags: [{ key: "hero", value: heroValue, reason: "STATIC" }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      updateMode: "batch",
      batchIntervalMs: 1000,
    });
    const changes: boolean[] = [];
    client.onFlagChange("hero", (e) => changes.push(Boolean(e.newValue)));

    // The catch-up ran at construction before the listener registered, so the
    // first observation lands on the first interval tick.
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1000); // same value — no notification
    expect(changes).toEqual([true]);

    heroValue = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([true, false]);

    client.destroy();
    vi.useRealTimers();
  });

  it("reports request telemetry to plugins via onRequest", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "128" },
      json: async () => ({ value: true, reason: "STATIC" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const requests: RequestInfo[] = [];
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      plugins: [
        {
          name: "telemetry",
          onRequest: (info) => requests.push(info),
        },
      ],
    });

    await client.getBooleanValue("hero", false);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://flaggr.test/api/flags/evaluate");
    expect(requests[0].ok).toBe(true);
    expect(requests[0].responseBytes).toBe(128);
    client.destroy();
  });
});

describe("streaming with an API key", () => {
  /** A 200 text/event-stream response whose body the test writes. */
  const sseResponse = () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    return {
      response,
      send: (text: string) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
  };
  const isStream = (url: unknown) => String(url).includes("/api/flags/stream");
  const isBatch = (url: unknown) => String(url).endsWith("/api/flags/evaluate/batch");

  it("streams over fetch with the key in the Authorization header, never in the URL", async () => {
    const stream = sseResponse();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const eventSource = vi.fn();
    vi.stubGlobal("EventSource", eventSource);

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      environment: "production",
      apiKey: "fgr_secret",
      updateMode: "stream",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(eventSource).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://flaggr.test/api/flags/stream?serviceId=web&environment=production");
    expect(String(url)).not.toContain("fgr_secret");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer fgr_secret", Accept: "text/event-stream" });
    client.destroy();
  });

  it("applies configuration_sync, configuration_delta and flag-update messages", async () => {
    const stream = sseResponse();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      apiKey: "fgr_secret",
      updateMode: "stream",
    });
    const changes: string[] = [];
    client.onFlagChange("hero", (e) => changes.push(String(e.newValue)));

    stream.send(
      'event: configuration_sync\ndata: {"type":"configuration_sync","version":"v1","flags":[' +
        '{"key":"hero","type":"boolean","enabled":true,"defaultValue":true},' +
        '{"key":"extra","type":"boolean","enabled":true,"defaultValue":true}]}\n\n',
    );
    await vi.waitFor(() => expect(client.getBooleanValueSync("hero", false)).toBe(true));
    expect(client.getConfigurationVersion()).toBe("v1");

    stream.send(
      'event: configuration_delta\ndata: {"version":"v2","flags":' +
        '[{"key":"hero","type":"boolean","enabled":false,"defaultValue":false}],"removed":["extra"]}\n\n',
    );
    await vi.waitFor(() => expect(client.getBooleanValueSync("hero", true)).toBe(false));
    expect(client.getBooleanValueSync("extra", false)).toBe(false);

    // Control-plane flag-update with the full flag: applied in place.
    stream.send(
      'data: {"type":"flag-update","flagKey":"hero","eventType":"UPDATED",' +
        '"flag":{"key":"hero","type":"boolean","enabled":true,"defaultValue":true}}\n\n',
    );
    await vi.waitFor(() => expect(client.getBooleanValueSync("hero", false)).toBe(true));
    // Heartbeats and keep-alive comments change nothing.
    stream.send('event: heartbeat\ndata: {"version":"v2"}\n\n:ping\n\n');
    expect(changes).toEqual(["true", "false", "true"]);
    expect(client.getConnectionState()).toBe("connected");
    client.destroy();
  });

  it("reconnects after the stream drops", async () => {
    vi.useFakeTimers();
    const first = sseResponse();
    const second = sseResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    vi.stubGlobal("fetch", fetchMock);
    const states: string[] = [];
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      apiKey: "fgr_secret",
      updateMode: "stream",
    });
    client.onConnectionStateChange((state) => states.push(state));
    await vi.advanceTimersByTimeAsync(0);

    first.send("data: {}\n\n");
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getConnectionState()).toBe("error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ Authorization: "Bearer fgr_secret" });
    expect(client.getConnectionState()).toBe("connected");
    expect(states).toEqual(["error", "connected"]);
    client.destroy();
  });

  it.each([401, 403])("falls back to polling watched flags when the stream answers %i", async (status) => {
    vi.useFakeTimers();
    let heroValue = true;
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (isStream(url)) return new Response(JSON.stringify({ error: "refused" }), { status });
      return {
        ok: true,
        json: async () => ({ flags: [{ key: "hero", value: heroValue, reason: "STATIC" }] }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      apiKey: "fgr_flag_scoped",
      updateMode: "stream",
      batchIntervalMs: 1000,
    });
    const changes: boolean[] = [];
    client.onFlagChange("hero", (e) => changes.push(Boolean(e.newValue)));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getConnectionState()).toBe("error");

    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([true]);
    heroValue = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([true, false]);

    // The refusal is final: the stream is never retried.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.filter(([url]) => isStream(url))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => isBatch(url)).length).toBeGreaterThanOrEqual(3);
    expect(client.getUpdateMode()).toBe("stream");

    // Leaving stream mode stops the fallback.
    client.setUpdateMode("poll");
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();
    client.destroy();
  });

  it("keyless streaming keeps EventSource, with no credential in the URL", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mockSource = {
      onopen: null,
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    const ctor = vi.fn((_url: string) => mockSource);
    vi.stubGlobal("EventSource", ctor);

    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "pixel-grid", updateMode: "stream" });
    expect(ctor).toHaveBeenCalledWith("https://flaggr.test/api/flags/stream?serviceId=pixel-grid");
    expect(fetchMock).not.toHaveBeenCalled();
    client.destroy();
    expect(mockSource.close).toHaveBeenCalled();
  });

  it("destroy() and mode switches close the fetch stream", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => sseResponse().response);
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      apiKey: "fgr_secret",
      updateMode: "stream",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    client.setUpdateMode("poll");
    expect(signal.aborted).toBe(true);

    client.setUpdateMode("stream");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = fetchMock.mock.calls[1][1]?.signal as AbortSignal;
    client.destroy();
    expect(second.aborted).toBe(true);
  });
});

describe("batch evaluation against the data plane", () => {
  /**
   * services/flaggr-api/handler/rest.go (HandleBatchEvaluate), the default
   * apiUrl's batch API: it reads `flagKeys` (rejecting a duplicate key, and
   * evaluating every flag in the service when there are none), and answers
   * with a map of flag key → result. A flag it doesn't have comes back as
   * FLAG_NOT_FOUND with a null value.
   */
  const dataPlane = (valueOf: (flagKey: string) => { value: unknown; variant?: string } | undefined) =>
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const { flagKeys = [] } = JSON.parse(String(init?.body)) as { flagKeys?: string[] };
      if (new Set(flagKeys).size !== flagKeys.length) {
        return { ok: false, status: 400, json: async () => ({ error: "duplicate flagKey" }) } as unknown as Response;
      }
      const flags: Record<string, unknown> = {};
      for (const flagKey of flagKeys) {
        const result = valueOf(flagKey);
        flags[flagKey] = result
          ? { flagKey, ...result, reason: "TARGETING_MATCH", evaluatedAt: "" }
          : { flagKey, value: null, reason: "FLAG_NOT_FOUND", errorCode: "FLAG_NOT_FOUND", evaluatedAt: "" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ flags, total: flagKeys.length, evaluatedAt: "2026-10-08T03:00:00Z" }),
      } as unknown as Response;
    });

  it("evaluateBatch sends flagKeys, once each, and reads the keyed answer", async () => {
    const fetchMock = dataPlane((flagKey) =>
      flagKey === "hero" ? { value: true, variant: "on" } : flagKey === "promo" ? { value: "spring" } : undefined,
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", apiKey: "fgr_x" });

    const results = await client.evaluateBatch([
      { flagKey: "hero", defaultValue: false },
      { flagKey: "promo", defaultValue: "none" },
      { flagKey: "gone", defaultValue: "fallback" },
      { flagKey: "hero", defaultValue: false },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.flagKeys).toEqual(["hero", "promo", "gone"]);
    // The control plane's batch API (apiUrl https://flaggr.dev) reads `flags`.
    expect(body.flags).toEqual([
      { key: "hero", defaultValue: false },
      { key: "promo", defaultValue: "none" },
      { key: "gone", defaultValue: "fallback" },
      { key: "hero", defaultValue: false },
    ]);
    expect(results.get("hero")).toEqual({ value: true, reason: "TARGETING_MATCH", variant: "on" });
    expect(results.get("promo")).toMatchObject({ value: "spring", reason: "TARGETING_MATCH" });
    expect(results.get("gone")).toMatchObject({ value: "fallback", reason: "FLAG_NOT_FOUND" });

    // Cached like any other result.
    await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it("batch mode refreshes watched flags from the keyed answer", async () => {
    vi.useFakeTimers();
    let hero = true;
    vi.stubGlobal("fetch", dataPlane((flagKey) => (flagKey === "hero" ? { value: hero } : undefined)));
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      updateMode: "batch",
      batchIntervalMs: 1000,
    });
    const changes: unknown[] = [];
    client.onFlagChange("hero", (event) => changes.push(event.newValue));

    await vi.advanceTimersByTimeAsync(1000);
    hero = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // unchanged: no notification

    expect(changes).toEqual([true, false]);
    client.destroy();
  });
});
