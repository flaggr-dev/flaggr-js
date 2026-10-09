import { afterEach, describe, expect, it, vi } from "vitest";
import { FlaggrClient } from "./client";
import type { EvaluationResult, FlaggrClientInstance, FlaggrPlugin, RequestInfo } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FlaggrClient", () => {
  describe("defaults: fallback values, not answers", () => {
    it("evaluates a flag listed in defaults remotely in poll mode", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: false, reason: "TARGETING_MATCH", variant: "off" }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const plugin: FlaggrPlugin = { name: "observer", onEvaluateComplete: vi.fn() };
      const client = new FlaggrClient({
        apiUrl: "https://flaggr.test",
        serviceId: "web",
        defaults: { "new-nav": true },
        plugins: [plugin],
      });

      await expect(client.getBooleanValue("new-nav", false)).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://flaggr.test/api/flags/evaluate");
      // The entry is the request's fallback (what the control plane answers
      // NOT_FOUND with), not the caller's default.
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ flagKey: "new-nav", defaultValue: true });
      expect(plugin.onEvaluateComplete).toHaveBeenCalledWith(
        "new-nav",
        { value: false, reason: "TARGETING_MATCH", variant: "off" },
        expect.any(Number),
      );
      client.destroy();
    });

    it("stands in for the caller's default when the evaluation fails or the flag isn't found", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        // services/flaggr-api: 200, FLAG_NOT_FOUND and no value.
        .mockResolvedValueOnce({ ok: true, json: async () => ({ reason: "FLAG_NOT_FOUND", errorCode: "FLAG_NOT_FOUND" }) });
      vi.stubGlobal("fetch", fetchMock);
      const plugin: FlaggrPlugin = { name: "errors", onEvaluateError: vi.fn() };
      const client = new FlaggrClient({
        apiUrl: "https://flaggr.test",
        serviceId: "web",
        defaults: { "new-nav": true, "rate-limit": 100 },
        plugins: [plugin],
      });

      await expect(client.evaluate("new-nav", false)).resolves.toMatchObject({
        value: true,
        reason: "ERROR",
        errorMessage: "Failed to fetch",
      });
      expect(plugin.onEvaluateError).toHaveBeenCalledTimes(1);
      await expect(client.evaluate("rate-limit", 5)).resolves.toMatchObject({ value: 100, reason: "FLAG_NOT_FOUND" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      client.destroy();
    });

    it("is what evaluateSync returns before anything has loaded", () => {
      vi.stubGlobal("fetch", vi.fn());
      const client = new FlaggrClient({ serviceId: "web", defaults: { "new-nav": true } });

      expect(client.evaluateSync("new-nav", false)).toEqual({ value: true, reason: "DEFAULT" });
      expect(client.getBooleanValueSync("new-nav", false)).toBe(true);
      expect(client.evaluateSync("other", false)).toEqual({ value: false, reason: "DEFAULT" });
      client.destroy();
    });

    it("stands in for the caller's default in a failed batch", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", defaults: { "new-nav": true } });

      const results = await client.evaluateBatch([
        { flagKey: "new-nav", defaultValue: false },
        { flagKey: "other", defaultValue: "x" },
      ]);
      expect(results.get("new-nav")).toMatchObject({ value: true, reason: "ERROR" });
      expect(results.get("other")).toMatchObject({ value: "x", reason: "ERROR" });
      client.destroy();
    });
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
    vi.stubGlobal("EventSource", vi.fn(function () { return mockSource; }));

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
    vi.stubGlobal("EventSource", vi.fn(function () { return mockSource; }));

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
    const ctor = vi.fn(function () { return mockSource; });
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
    const ctor = vi.fn(function (_url: string) { return mockSource; });
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

/** A 200 JSON response. */
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const isOutcome = (url: unknown) => String(url).endsWith("/api/events/outcomes");

describe("trackOutcome", () => {
  /** The bodies of the outcome requests, parsed. */
  const outcomeBodies = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls
      .filter(([url]) => isOutcome(url))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

  it("posts with the key as a bearer on a keepalive fetch, never navigator.sendBeacon", async () => {
    // /api/events/outcomes refuses a request without Authorization (401), and
    // Chromium refuses an application/json beacon: a beacon never arrived.
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "web",
      environment: "staging",
    });

    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", eventValue: 49.99, userId: "u1" });

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://flaggr.test/api/events/outcomes");
    expect(init).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: "Bearer fgr_key" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      flagKey: "checkout",
      variant: "unknown",
      eventName: "purchase",
      eventValue: 49.99,
      userId: "u1",
      serviceId: "web",
      environment: "staging",
      projectId: "",
    });
    client.destroy();
  });

  it("sends the hosted data plane's outcomes to the Flaggr app, which stores them", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiKey: "fgr_key", serviceId: "web" }); // apiUrl: https://api.flaggr.dev

    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://flaggr.dev/api/events/outcomes"]);
    client.destroy();
  });

  it("sends a body over the 64 KiB keepalive budget as a plain fetch", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web" });

    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", userId: "u".repeat(70 * 1024) });

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ keepalive: false, headers: { Authorization: "Bearer fgr_key" } });
    client.destroy();
  });

  it("never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web" });
    await expect(client.trackOutcome({ flagKey: "checkout", eventName: "purchase" })).resolves.toBeUndefined();
    client.destroy();
  });

  it("attributes each outcome to the variant evaluated for its own user, on a server evaluating for many", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (isOutcome(url)) return jsonResponse({ accepted: 1 });
      const { context } = JSON.parse(String(init?.body)) as { context: { targetingKey?: string } };
      const variant = context.targetingKey === "u1" ? "a" : "b";
      return jsonResponse({ value: variant, variant, reason: "TARGETING_MATCH" });
    });
    vi.stubGlobal("fetch", fetchMock);
    // One client, a per-call context per request.
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "api" });
    await client.getStringValue("checkout", "control", { targetingKey: "u1" });
    await client.getStringValue("checkout", "control", { targetingKey: "u2" });

    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", userId: "u1" });
    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", targetingKey: "u2", userId: "customer-2" });
    // Never evaluated for u3: not u2's variant.
    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", userId: "u3" });
    // A caller that knows the variant says so.
    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", userId: "u3", variant: "c" });

    expect(outcomeBodies(fetchMock).map((body) => [body.variant, body.userId])).toEqual([
      ["a", "u1"],
      ["b", "customer-2"],
      ["unknown", "u3"],
      ["c", "u3"],
    ]);
    // The targeting key only picks the variant: it isn't sent.
    expect(outcomeBodies(fetchMock).every((body) => !("targetingKey" in body))).toBe(true);
    client.destroy();
  });

  it("falls back to the client's own targetingKey in a browser", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      isOutcome(url) ? jsonResponse({ accepted: 1 }) : jsonResponse({ value: true, variant: "on", reason: "TARGETING_MATCH" })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "web",
      context: { targetingKey: "visitor-1" },
    });
    await client.getBooleanValue("checkout", false);

    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase" });
    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", userId: "customer-42" });
    await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", targetingKey: "someone-else" });

    expect(outcomeBodies(fetchMock).map((body) => body.variant)).toEqual(["on", "on", "unknown"]);
    client.destroy();
  });

  it("remembers at most 10,000 flag and targeting key pairs, dropping the least recently evaluated", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "api",
      // Every read evaluates (locally) again, so each one counts as recent.
      cacheTtl: -1,
      bootstrap: { flags: [{ key: "checkout", type: "string", enabled: true, defaultValue: "control" }] },
    });
    const evaluateFor = (targetingKey: string) => client.getStringValue("checkout", "x", { targetingKey });
    for (let i = 0; i < 10_000; i++) await evaluateFor(`u${i}`);
    await evaluateFor("u0"); // the most recent again
    await evaluateFor("u10000"); // one too many: u1 is dropped

    for (const targetingKey of ["u0", "u1", "u2", "u10000"]) {
      await client.trackOutcome({ flagKey: "checkout", eventName: "purchase", targetingKey });
    }
    expect(outcomeBodies(fetchMock).map((body) => body.variant)).toEqual(["control", "unknown", "control", "control"]);
    client.destroy();
  });
});

describe("keyless stream", () => {
  interface FakeSource {
    url: string;
    readyState: number;
    onopen: null | (() => void);
    onmessage: null | ((e: MessageEvent) => void);
    onerror: null | (() => void);
    addEventListener: (...args: unknown[]) => void;
    close: () => void;
  }
  /** EventSource, as browsers have it: readyState CLOSED (2) once refused or closed. */
  const eventSources = () => {
    const sources: FakeSource[] = [];
    vi.stubGlobal(
      "EventSource",
      vi.fn(function (url: string) {
        const source: FakeSource = {
          url,
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          addEventListener: vi.fn(),
          close: vi.fn(() => {
            source.readyState = 2;
          }),
        };
        sources.push(source);
        return source;
      })
    );
    return sources;
  };
  /** A control-plane batch answer: hero is on. */
  const batchFetch = () =>
    vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ flags: [{ key: "hero", value: true, reason: "STATIC" }], total: 1 })
    );
  const batchCalls = (fetchMock: ReturnType<typeof batchFetch>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/flags/evaluate/batch")).length;

  it("polls once EventSource is refused for good (the data plane's 401 to a request without a key)", async () => {
    vi.useFakeTimers();
    const fetchMock = batchFetch();
    vi.stubGlobal("fetch", fetchMock);
    const sources = eventSources();
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "demo",
      updateMode: "stream",
      batchIntervalMs: 1000,
    });
    const states: string[] = [];
    client.onConnectionStateChange((state) => states.push(state));
    const changes: unknown[] = [];
    client.onFlagChange("hero", (event) => changes.push(event.newValue));

    // A refusal: EventSource fires error with readyState CLOSED and won't reconnect.
    sources[0].readyState = 2;
    sources[0].onerror?.();
    expect(states).toEqual(["error"]);
    await vi.advanceTimersByTimeAsync(0); // the fallback's first refresh
    expect(batchCalls(fetchMock)).toBe(1);
    expect(changes).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batchCalls(fetchMock)).toBe(2);

    client.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(batchCalls(fetchMock)).toBe(2);
    expect(sources).toHaveLength(1);
  });

  it("leaves a dropped connection to EventSource's own reconnect", async () => {
    vi.useFakeTimers();
    const fetchMock = batchFetch();
    vi.stubGlobal("fetch", fetchMock);
    const sources = eventSources();
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "demo", updateMode: "stream" });
    client.onFlagChange("hero", () => {});

    sources[0].readyState = 0; // CONNECTING: it retries by itself
    sources[0].onerror?.();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.getConnectionState()).toBe("error");
    expect(batchCalls(fetchMock)).toBe(0);
    expect(sources[0].close).not.toHaveBeenCalled();
    client.destroy();
  });

  it("polls in a runtime without EventSource", async () => {
    vi.useFakeTimers();
    const fetchMock = batchFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", undefined);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "demo",
      updateMode: "stream",
      batchIntervalMs: 1000,
    });
    const changes: unknown[] = [];
    client.onFlagChange("hero", (event) => changes.push(event.newValue));

    await vi.advanceTimersByTimeAsync(1000);
    expect(batchCalls(fetchMock)).toBe(1);
    expect(changes).toEqual([true]);
    client.destroy();
  });
});

describe("refresh()", () => {
  /** Control plane: a value for each flag, from `values`; a batch answer lists them. */
  const controlPlane = (values: Record<string, unknown>) =>
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { flagKey?: string; flags?: Array<{ key: string }> };
      if (String(url).endsWith("/batch")) {
        return jsonResponse({ flags: body.flags!.map(({ key }) => ({ key, value: values[key], reason: "STATIC" })) });
      }
      return jsonResponse({ value: values[body.flagKey!], reason: "STATIC" });
    });

  it("re-evaluates the flags the client evaluated, in one batch, and notifies listeners of changes", async () => {
    const values: Record<string, unknown> = { promo: "spring", hero: true };
    const fetchMock = controlPlane(values);
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web" });
    await expect(client.getStringValue("promo", "none")).resolves.toBe("spring");
    await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
    const changes: unknown[] = [];
    client.onFlagChange("promo", (event) => changes.push([event.oldValue, event.newValue]));
    client.onFlagChange("hero", (event) => changes.push([event.oldValue, event.newValue]));

    values.promo = "summer";
    await client.refresh();

    expect(changes).toEqual([["spring", "summer"]]);
    expect(fetchMock).toHaveBeenCalledTimes(3); // two evaluations, one batch
    // The refreshed values are cached.
    await expect(client.getStringValue("promo", "none")).resolves.toBe("summer");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await client.refresh(); // nothing changed: nobody notified
    expect(changes).toHaveLength(1);
    client.destroy();
  });

  it("batch mode: a refresh that fails or can't find the flag neither caches nor announces its fallback", async () => {
    vi.useFakeTimers();
    let answer: "spring" | "offline" | "gone" = "spring";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (answer === "offline") throw new TypeError("Failed to fetch");
        const body = JSON.parse(String(init?.body)) as { flagKey?: string; flagKeys?: string[] };
        // services/flaggr-api: 200, FLAG_NOT_FOUND and a null value for a flag it doesn't have.
        const result = (flagKey: string) =>
          answer === "gone"
            ? { flagKey, value: null, reason: "FLAG_NOT_FOUND", errorCode: "FLAG_NOT_FOUND" }
            : { flagKey, value: "spring", reason: "STATIC" };
        if (String(url).endsWith("/batch")) {
          return jsonResponse({ flags: Object.fromEntries(body.flagKeys!.map((key) => [key, result(key)])) });
        }
        return jsonResponse(result(body.flagKey!));
      })
    );
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      serviceId: "web",
      updateMode: "batch",
      batchIntervalMs: 1000,
    });
    await expect(client.getStringValue("promo", "none")).resolves.toBe("spring");
    const changes: unknown[] = [];
    client.onFlagChange("promo", (event) => changes.push(event.newValue));

    answer = "offline";
    await vi.advanceTimersByTimeAsync(1000);
    answer = "gone";
    await vi.advanceTimersByTimeAsync(1000);

    // The refreshes only had their own fallback (`false`) for promo: not a value.
    expect(changes).toEqual([]);
    // Nothing of it was cached: the read asks again, with its own default.
    await expect(client.getStringValue("promo", "none")).resolves.toBe("none");
    client.destroy();
  });
});

describe("start: false and the client lifecycle", () => {
  it("creates a client with no side effects until start()", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const plugin: FlaggrPlugin = { name: "probe", onInit: vi.fn(), onDestroy: vi.fn() };
    const client = new FlaggrClient(
      {
        apiUrl: "https://flaggr.test",
        serviceId: "web",
        updateMode: "batch",
        batchIntervalMs: 1000,
        remoteConfig: true,
        plugins: [plugin],
      },
      { start: false }
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(plugin.onInit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.getConnectionState()).toBe("disconnected");

    client.start();
    client.start(); // once only
    expect(plugin.onInit).toHaveBeenCalledTimes(1);
    expect(plugin.onInit).toHaveBeenCalledWith(client);
    expect(fetchMock.mock.calls.map(([url]) => String(url).split("?")[0])).toEqual([
      "https://flaggr.test/api/sdk-config",
    ]);
    expect(vi.getTimerCount()).toBe(1); // the batch timer
    expect(client.getConnectionState()).toBe("connected");

    client.destroy();
    expect(plugin.onDestroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a client destroyed before start() never calls its plugins, and its waiting evaluations go ahead", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ value: true, reason: "STATIC" }));
    vi.stubGlobal("fetch", fetchMock);
    const plugin: FlaggrPlugin = { name: "probe", onInit: vi.fn(), onDestroy: vi.fn() };
    const client = new FlaggrClient(
      { apiUrl: "https://flaggr.test", serviceId: "web", remoteConfig: true, plugins: [plugin] },
      { start: false }
    );

    const pending = client.getBooleanValue("hero", false); // waits for the remote config
    client.destroy();
    await expect(pending).resolves.toBe(true);
    client.start(); // after destroy(): nothing
    expect(plugin.onInit).not.toHaveBeenCalled();
    expect(plugin.onDestroy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["https://flaggr.test/api/flags/evaluate"]);
  });

  it("starts nothing when the remote config arrives after destroy()", async () => {
    vi.useFakeTimers();
    let answer!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL) =>
        String(url).includes("/api/sdk-config")
          ? new Promise<Response>((resolve) => (answer = resolve))
          : Promise.resolve(jsonResponse({ flags: [] }))
      )
    );
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web", remoteConfig: true });
    await vi.advanceTimersByTimeAsync(0);

    client.destroy();
    answer(jsonResponse({ sdk: { updateMode: "batch", telemetry: true } }));
    await vi.advanceTimersByTimeAsync(10_000);

    // No batch timer, no telemetry plugin (its flush timer).
    expect(vi.getTimerCount()).toBe(0);
    expect(client.getUpdateMode()).toBe("poll");
  });

  it("destroy() runs once", () => {
    const plugin: FlaggrPlugin = { name: "probe", onDestroy: vi.fn() };
    const client = new FlaggrClient({ serviceId: "web", plugins: [plugin] });
    client.destroy();
    client.destroy();
    expect(plugin.onDestroy).toHaveBeenCalledTimes(1);
  });

  it("persists a bootstrap snapshot under the client's auth scope", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {}))); // the remote config never answers
    const client = new FlaggrClient({
      serviceId: "web",
      apiKey: "fgr_key",
      remoteConfig: true,
      bootstrap: { flags: [{ key: "hero", type: "boolean", enabled: true, defaultValue: true }] },
    });

    // The key's scope, which a later load (readFlagSnapshot) looks for.
    expect([...store.keys()].filter((key) => key.startsWith("flaggr:flags:"))).toEqual([
      expect.stringMatching(/^flaggr:flags:web:production:k[0-9a-f]+$/),
    ]);
    client.destroy();
  });
});

describe("public types", () => {
  it("getObjectValue takes an interface", async () => {
    interface Banner {
      text: string;
      dismissible: boolean;
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ value: { text: "Sale", dismissible: false }, reason: "STATIC" })));
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web" });
    const fallback: Banner = { text: "Welcome", dismissible: true };

    const banner: Banner = await client.getObjectValue<Banner>("banner", fallback);
    const instance: FlaggrClientInstance = client;
    const again: Banner = await instance.getObjectValue("banner", fallback);

    expect([banner, again]).toEqual([
      { text: "Sale", dismissible: false },
      { text: "Sale", dismissible: false },
    ]);
    client.destroy();
  });

  it("EvaluationResult.reason has the reasons both planes answer with", () => {
    // src/lib/evaluator.ts (control plane) and services/flaggr-api (data plane).
    const reasons: Array<EvaluationResult["reason"]> = [
      "FLAG_NOT_FOUND",
      "EXPERIMENT",
      "PREREQUISITE_FAILED",
      "MUTUAL_EXCLUSION",
    ];
    expect(reasons).toHaveLength(4);
  });
});

/** A 200 text/event-stream response whose body the test writes (the keyed stream). */
function eventStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  return {
    response,
    sync: (flags: unknown[]) =>
      controller.enqueue(
        encoder.encode(`event: configuration_sync\ndata: ${JSON.stringify({ type: "configuration_sync", flags })}\n\n`)
      ),
    message: (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)),
  };
}

/** The variants of the outcome requests a fetch mock saw, in order. */
const outcomeVariants = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls
    .filter(([url]) => isOutcome(url))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { variant: string }).variant);

describe("trackOutcome attribution", () => {
  it("never gives an outcome the variant of an anonymous per-call evaluation (a server's anonymous request)", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (isOutcome(url)) return jsonResponse({ accepted: 1 });
      const { context } = JSON.parse(String(init?.body)) as { context: { targetingKey?: string } };
      return context.targetingKey === "bob"
        ? jsonResponse({ value: "B", variant: "B", reason: "TARGETING_MATCH" })
        : jsonResponse({ value: "anon-variant", variant: "anon-variant", reason: "TARGETING_MATCH" });
    });
    vi.stubGlobal("fetch", fetchMock);
    // A server's client: no context of its own, a per-call one per request.
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "api" });
    await expect(client.getStringValue("checkout", "control", { country: "AU" })).resolves.toBe("anon-variant");
    await expect(client.getStringValue("checkout", "control", { targetingKey: "bob" })).resolves.toBe("B");

    await client.trackOutcome({ flagKey: "checkout", eventName: "buy", userId: "carol" }); // never evaluated
    await client.trackOutcome({ flagKey: "checkout", eventName: "buy" });
    await client.trackOutcome({ flagKey: "checkout", eventName: "buy", userId: "bob" });

    expect(outcomeVariants(fetchMock)).toEqual(["unknown", "unknown", "B"]);
    client.destroy();
  });

  it("still attributes a keyless client's own-context evaluations, with or without a userId", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      isOutcome(url) ? jsonResponse({ accepted: 1 }) : jsonResponse({ value: true, variant: "on", reason: "STATIC" })
    );
    vi.stubGlobal("fetch", fetchMock);
    // A browser page's client without a targetingKey: the same context for all it evaluates.
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web" });
    await client.getBooleanValue("checkout", false);
    await client.getBooleanValue("checkout", false, {}); // an empty per-call context is the client's own

    await client.trackOutcome({ flagKey: "checkout", eventName: "buy" });
    await client.trackOutcome({ flagKey: "checkout", eventName: "buy", userId: "customer-42" });

    expect(outcomeVariants(fetchMock)).toEqual(["on", "on"]);
    client.destroy();
  });

  it("attributes the outcomes of users evaluated through evaluateBatch to their own variants", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (isOutcome(url)) return jsonResponse({ accepted: 1 });
      const body = JSON.parse(String(init?.body)) as { context: { targetingKey?: string }; flagKeys: string[] };
      const variant = body.context.targetingKey === "alice" ? "A" : "B";
      return jsonResponse({
        flags: Object.fromEntries(body.flagKeys.map((flagKey) => [flagKey, { flagKey, value: variant, variant, reason: "SPLIT" }])),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "api" });
    await client.evaluateBatch([{ flagKey: "checkout", defaultValue: "control" }], { targetingKey: "alice" });
    await client.evaluateBatch([{ flagKey: "checkout", defaultValue: "control" }], { targetingKey: "bob" });

    await client.trackOutcome({ flagKey: "checkout", eventName: "buy", userId: "alice" });
    await client.trackOutcome({ flagKey: "checkout", eventName: "buy", userId: "bob" });

    expect(outcomeVariants(fetchMock)).toEqual(["A", "B"]);
    client.destroy();
  });

  it("follows a live update: the variant a stream sync gives the client's own context", async () => {
    const stream = eventStream();
    const fetchMock = vi.fn(async (url: string | URL) =>
      isOutcome(url) ? jsonResponse({ accepted: 1 }) : stream.response
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "web",
      updateMode: "stream",
      context: { targetingKey: "v1" },
    });
    const copy = (value: string) => ({ key: "copy", type: "string", enabled: true, defaultValue: value });
    const seen: unknown[] = [];
    client.onFlagChange("copy", (event) => seen.push(event.newValue));
    stream.sync([copy("old")]);
    await vi.waitFor(() => expect(client.localFlagCount).toBe(1));
    await expect(client.getStringValue("copy", "none")).resolves.toBe("old");

    stream.sync([copy("new")]);
    await vi.waitFor(() => expect(seen).toContain("new"));
    await client.trackOutcome({ flagKey: "copy", eventName: "buy" });

    expect(outcomeVariants(fetchMock)).toEqual(["new"]);
    client.destroy();
  });

  it("follows a value pushed by the control plane's legacy stream message", async () => {
    const stream = eventStream();
    const fetchMock = vi.fn(async (url: string | URL) =>
      isOutcome(url) ? jsonResponse({ accepted: 1 }) : stream.response
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "web",
      updateMode: "stream",
      bootstrap: { flags: [{ key: "copy", type: "string", enabled: true, defaultValue: "old" }] },
    });
    await expect(client.getStringValue("copy", "none")).resolves.toBe("old");

    const seen: unknown[] = [];
    client.onFlagChange("copy", (event) => seen.push(event.newValue));
    stream.message({ flagKey: "copy", value: "pushed", variant: "treatment", reason: "TARGETING_MATCH" });
    await vi.waitFor(() => expect(seen).toEqual(["pushed"]));
    await client.trackOutcome({ flagKey: "copy", eventName: "buy" });

    expect(outcomeVariants(fetchMock)).toEqual(["treatment"]);
    client.destroy();
  });

  it("follows setContext: the variant a watched flag now has for the new user", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "web",
      context: { targetingKey: "u1" },
      bootstrap: {
        flags: [
          {
            key: "plan",
            type: "string",
            enabled: true,
            defaultValue: "basic",
            overrides: [{ identifiers: ["u2"], value: "pro" }],
          },
        ],
      },
    });
    const seen: unknown[] = [];
    client.onFlagChange("plan", (event) => seen.push(event.newValue)); // a hook watching it
    await expect(client.getStringValue("plan", "none")).resolves.toBe("basic");

    client.setContext({ targetingKey: "u2" });
    expect(seen).toEqual(["pro"]);
    await client.trackOutcome({ flagKey: "plan", eventName: "upgrade" });

    expect(outcomeVariants(fetchMock)).toEqual(["pro"]);
    client.destroy();
  });
});

describe("trackOutcome and live updates of flags the app only watches", () => {
  it("doesn't give an outcome the variant a stream sync gives the client's own context, for a flag the app evaluated only per call", async () => {
    const stream = eventStream();
    const fetchMock = vi.fn(async (url: string | URL) =>
      isOutcome(url) ? jsonResponse({ accepted: 1 }) : stream.response
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web", updateMode: "stream" });
    const copy = (fallback: string) => ({
      key: "copy",
      type: "string",
      enabled: true,
      defaultValue: fallback,
      targeting: [{ id: "r1", conditions: [{ property: "plan", operator: "equals", value: "pro" }], value: "pro-copy" }],
    });
    stream.sync([copy("standard")]);
    await vi.waitFor(() => expect(client.localFlagCount).toBe(1));
    // A hook with a per-call context: it watches the flag and evaluates it for that context.
    const heard: unknown[] = [];
    client.onFlagChange("copy", (event) => heard.push(event.newValue));
    await expect(client.getStringValue("copy", "none", { plan: "pro" })).resolves.toBe("pro-copy");

    stream.sync([copy("standard-2")]); // the client's own context now gets standard-2
    await vi.waitFor(() => expect(heard).toEqual(["standard-2"]));
    await client.trackOutcome({ flagKey: "copy", eventName: "buy" });

    // Not standard-2: nobody was shown that. The per-call evaluation had no targeting key.
    expect(outcomeVariants(fetchMock)).toEqual(["unknown"]);
    client.destroy();
  });

  it("doesn't give an outcome the variant a refresh gives the client's own context, for a flag the app evaluated only per call", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (isOutcome(url)) return jsonResponse({ accepted: 1 });
      const body = JSON.parse(String(init?.body)) as { context?: { targetingKey?: string }; flags?: Array<{ key: string }> };
      const value = body.context?.targetingKey === "admin-preview" ? "beta" : "stable";
      if (String(url).endsWith("/batch")) return jsonResponse({ flags: body.flags!.map(({ key }) => ({ key, value, reason: "STATIC" })) });
      return jsonResponse({ value, reason: "STATIC" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web", context: { targetingKey: "me" } });
    client.onFlagChange("layout", () => {});
    await client.getStringValue("layout", "none", { targetingKey: "admin-preview" });

    await client.refresh(); // evaluates layout for "me" (stable): the listener may be the client's own
    await client.trackOutcome({ flagKey: "layout", eventName: "buy" });
    await client.trackOutcome({ flagKey: "layout", eventName: "buy", targetingKey: "admin-preview" });

    expect(outcomeVariants(fetchMock)).toEqual(["unknown", "beta"]);
    client.destroy();
  });
});

describe("live updates and what the app evaluated per call", () => {
  it("doesn't give an outcome the client's own variant after setContext or a pushed value, for a flag evaluated only per call", async () => {
    const stream = eventStream();
    const fetchMock = vi.fn(async (url: string | URL) =>
      isOutcome(url) ? jsonResponse({ accepted: 1 }) : stream.response
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "web",
      updateMode: "stream",
      context: { targetingKey: "me" },
      bootstrap: { flags: [{ key: "plan", type: "string", enabled: true, defaultValue: "basic", overrides: [{ identifiers: ["other"], value: "pro" }] }] },
    });
    const heard: unknown[] = [];
    client.onFlagChange("plan", (event) => heard.push(event.newValue));
    // Only evaluated for someone else.
    await expect(client.getStringValue("plan", "none", { targetingKey: "other" })).resolves.toBe("pro");

    client.setContext({ targetingKey: "me-2" });
    stream.message({ flagKey: "plan", value: "pushed", variant: "pushed-variant" });
    await vi.waitFor(() => expect(heard).toEqual(["basic", "pushed"]));
    await client.trackOutcome({ flagKey: "plan", eventName: "upgrade" });

    expect(outcomeVariants(fetchMock)).toEqual(["unknown"]);
    client.destroy();
  });

  it("drops what's cached for per-call contexts when the stream pushes a flag's new value", async () => {
    const stream = eventStream();
    let copy = "old";
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("/api/flags/stream") ? stream.response : jsonResponse({ value: copy, reason: "STATIC" })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web", updateMode: "stream" });
    await expect(client.getStringValue("copy", "none", { targetingKey: "u1" })).resolves.toBe("old");
    const heard: unknown[] = [];
    client.onFlagChange("copy", (event) => heard.push(event.newValue));

    copy = "new";
    stream.message({ flagKey: "copy", value: "new", reason: "STATIC" });
    await vi.waitFor(() => expect(heard).toEqual(["new"]));

    // Not the stale per-call entry: evaluated again.
    await expect(client.getStringValue("copy", "none", { targetingKey: "u1" })).resolves.toBe("new");
    client.destroy();
  });
});

describe("refresh() and per-call contexts", () => {
  /** Answers `beta` to the targeting key admin-preview, else `stable`; a batch answer lists them. */
  const preview = () =>
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        flagKey?: string;
        flags?: Array<{ key: string }>;
        context?: { targetingKey?: string };
      };
      const value = body.context?.targetingKey === "admin-preview" ? "beta" : "stable";
      if (String(url).endsWith("/batch")) {
        return jsonResponse({ flags: body.flags!.map(({ key }) => ({ key, value, reason: "TARGETING_MATCH" })) });
      }
      return jsonResponse({ value, reason: "TARGETING_MATCH" });
    });
  const batches = (fetchMock: ReturnType<typeof preview>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/batch")).length;

  it("doesn't evaluate a flag cached only for a per-call context with the client's own: it drops the entry", async () => {
    const fetchMock = preview();
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", context: { targetingKey: "me" } });
    await expect(client.getStringValue("layout", "none", { targetingKey: "admin-preview" })).resolves.toBe("beta");

    await client.refresh();
    expect(batches(fetchMock)).toBe(0);
    // The per-call entry is gone: the next read asks again.
    await expect(client.getStringValue("layout", "none", { targetingKey: "admin-preview" })).resolves.toBe("beta");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it("compares with the client's own context's entry only: a per-call value is never a change event's oldValue", async () => {
    const fetchMock = preview();
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", context: { targetingKey: "me" } });
    await client.getStringValue("layout", "none", { targetingKey: "admin-preview" }); // beta, per call
    const events: Array<[unknown, unknown]> = [];
    client.onFlagChange("layout", (event) => events.push([event.oldValue, event.newValue]));

    await client.refresh();
    // Nothing was cached for the client's own context: nothing to compare with.
    expect(events).toEqual([[undefined, "stable"]]);

    // Now both are cached, the per-call one first: still compared with the own one.
    await client.getStringValue("layout", "none", { targetingKey: "admin-preview" });
    await client.refresh();
    expect(events).toHaveLength(1);
    client.destroy();
  });
});

describe("plugins and start()", () => {
  /** A plugin that records the hooks it hears, in order. */
  const recorder = () => {
    const calls: string[] = [];
    const plugin: FlaggrPlugin = {
      name: "recorder",
      onInit: () => void calls.push("onInit"),
      onEvaluate: (flagKey) => void calls.push(`onEvaluate:${flagKey}`),
      onEvaluateComplete: (flagKey, result) => void calls.push(`onEvaluateComplete:${flagKey}:${String(result.value)}`),
      onRequest: (info) => void calls.push(`onRequest:${info.url}`),
      onDestroy: () => void calls.push("onDestroy"),
    };
    return { calls, plugin };
  };

  it("delivers what a client did before start() after its plugins' onInit, in order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ value: true, reason: "STATIC" })));
    const { calls, plugin } = recorder();
    const client = new FlaggrClient(
      {
        apiUrl: "https://flaggr.test",
        serviceId: "web",
        plugins: [plugin],
        bootstrap: { flags: [{ key: "hero", type: "boolean", enabled: true, defaultValue: true }] },
      },
      { start: false }
    );
    // FlaggrProvider: a hook evaluates while rendering, then in its effect, both before start().
    client.evaluateSync("hero", false);
    await client.evaluate("promo", false);
    expect(calls).toEqual([]);

    client.start();
    expect(calls).toEqual([
      "onInit",
      "onEvaluateComplete:hero:true",
      "onEvaluate:promo",
      "onRequest:https://flaggr.test/api/flags/evaluate",
      "onEvaluateComplete:promo:true",
    ]);
    client.evaluateSync("hero", false);
    expect(calls.at(-1)).toBe("onEvaluateComplete:hero:true");
    client.destroy();
    expect(calls.at(-1)).toBe("onDestroy");
  });

  it("calls no hook of a plugin whose client is destroyed before start()", () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    const { calls, plugin } = recorder();
    const client = new FlaggrClient({ serviceId: "web", plugins: [plugin] }, { start: false });
    client.evaluateSync("hero", false);
    client.destroy();
    client.start();
    expect(calls).toEqual([]);
  });

  it("opens no transport for setUpdateMode before start(): start() opens the mode's", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ flags: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web" }, { start: false });
    client.onFlagChange("hero", () => {});

    client.setUpdateMode("batch");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    client.start();
    expect(vi.getTimerCount()).toBe(1); // the batch timer
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // its first refresh
    client.destroy();
  });
});

describe("remote config intervals", () => {
  const batchCalls = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/flags/evaluate/batch")).length;

  it("runs the first batch timer at the remote batchIntervalMs that comes with the remote updateMode", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).includes("/api/sdk-config")
        ? jsonResponse({ sdk: { updateMode: "batch", batchIntervalMs: 50 } })
        : jsonResponse({ flags: [{ key: "hero", value: true, reason: "STATIC" }] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", remoteConfig: true });
    client.onFlagChange("hero", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getUpdateMode()).toBe("batch");
    const first = batchCalls(fetchMock); // the switch's catch-up refresh

    await vi.advanceTimersByTimeAsync(200);
    expect(batchCalls(fetchMock) - first).toBe(4);
    client.destroy();
  });

  it("moves a running batch timer to a remote batchIntervalMs that comes alone", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).includes("/api/sdk-config")
        ? jsonResponse({ sdk: { batchIntervalMs: 50 } })
        : jsonResponse({ flags: [{ key: "hero", value: true, reason: "STATIC" }] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", updateMode: "batch", remoteConfig: true });
    client.onFlagChange("hero", () => {});
    await vi.advanceTimersByTimeAsync(0);
    const first = batchCalls(fetchMock);

    await vi.advanceTimersByTimeAsync(200);
    expect(batchCalls(fetchMock) - first).toBe(4);
    client.destroy();
  });
});

describe("the stream's polling fallback, refused", () => {
  const isBatch = (url: unknown) => String(url).endsWith("/api/flags/evaluate/batch");

  it("stops once a batch is refused: the keyless page against a data plane that wants a key", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const sources: Array<{ readyState: number; onerror: null | (() => void); close: () => void }> = [];
    vi.stubGlobal(
      "EventSource",
      vi.fn(function () {
        const source = { readyState: 0, onopen: null, onmessage: null, onerror: null, addEventListener: vi.fn(), close: vi.fn() };
        sources.push(source);
        return source;
      })
    );
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "demo", updateMode: "stream", batchIntervalMs: 500 });
    client.onFlagChange("hero", () => {});

    sources[0].readyState = 2; // refused
    sources[0].onerror?.();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock.mock.calls.filter(([url]) => isBatch(url))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.getConnectionState()).toBe("error");
    client.destroy();
  });

  it.each([401, 403])("stops when the keyed stream's fallback batch answers %i", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "refused" }), { status })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_revoked",
      serviceId: "web",
      updateMode: "stream",
      batchIntervalMs: 500,
    });
    client.onFlagChange("hero", () => {});
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock.mock.calls.filter(([url]) => isBatch(url))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    client.destroy();
  });

  it("keeps polling through a server error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).includes("/api/flags/stream")
        ? new Response("", { status: 401 })
        : new Response(JSON.stringify({ error: "boom" }), { status: 503 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: "https://flaggr.test",
      apiKey: "fgr_key",
      serviceId: "web",
      updateMode: "stream",
      batchIntervalMs: 500,
    });
    client.onFlagChange("hero", () => {});
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock.mock.calls.filter(([url]) => isBatch(url)).length).toBeGreaterThanOrEqual(4);
    client.destroy();
  });

  it("leaves batch mode, which the app chose, polling through a refused batch (as 0.4.0 did)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", updateMode: "batch", batchIntervalMs: 500 });
    client.onFlagChange("hero", () => {});
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock.mock.calls.filter(([url]) => isBatch(url)).length).toBeGreaterThanOrEqual(4);
    client.destroy();
  });

  it("ignores an error from an EventSource it has already replaced", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ flags: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const sources: Array<{ readyState: number; onerror: null | (() => void); close: () => void }> = [];
    vi.stubGlobal(
      "EventSource",
      vi.fn(function () {
        const source = { readyState: 0, onopen: null, onmessage: null, onerror: null, addEventListener: vi.fn(), close: vi.fn() };
        sources.push(source);
        return source;
      })
    );
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "demo", updateMode: "stream", batchIntervalMs: 500 });
    client.onFlagChange("hero", () => {});
    client.setUpdateMode("poll");

    // The closed source's late error: not the client's stream any more.
    sources[0].readyState = 2;
    sources[0].onerror?.();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getConnectionState()).not.toBe("error");
    client.destroy();
  });
});

describe("FlaggrClientInstance compatibility", () => {
  it("takes a hand-written implementation of 0.4.0's members (clearPersistedConfig is optional)", async () => {
    // Type-checked by typecheck.test.ts: 0.4.0's interface had no clearPersistedConfig.
    const result = { value: false, reason: "STATIC" as const };
    const instance: FlaggrClientInstance = {
      getBooleanValue: async () => false,
      getStringValue: async () => "",
      getNumberValue: async () => 0,
      getObjectValue: async <T extends object>(_flagKey: string, defaultValue: T) => defaultValue,
      evaluate: async () => result as never,
      evaluateSync: () => result as never,
      getBooleanValueSync: () => false,
      setContext: () => {},
      setUpdateMode: () => {},
      getUpdateMode: () => "poll",
      onFlagChange: () => () => {},
      onConnectionStateChange: () => () => {},
      getConnectionState: () => "disconnected" as never,
      getConfig: () => ({ serviceId: "web" }),
      refresh: async () => {},
      trackOutcome: async () => {},
      destroy: () => {},
    };
    expect(instance.clearPersistedConfig).toBeUndefined();
    // The class has it.
    const client: FlaggrClientInstance = new FlaggrClient({ serviceId: "web" });
    expect(typeof client.clearPersistedConfig).toBe("function");
    client.clearPersistedConfig?.();
    client.destroy();
  });
});
