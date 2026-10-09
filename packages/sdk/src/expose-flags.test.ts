// @vitest-environment jsdom

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlaggrClient } from "./client";

type FlagMap = Record<string, unknown>;
type PageWindow = Window & {
  __FLAGGR_FLAGS__?: FlagMap;
  __FLAGGR_BOOTSTRAP__?: Record<string, { value: unknown }>;
};
const page = window as PageWindow;
const API = "https://flaggr.test";

/** The `detail` of every `flaggr:flags-changed` event dispatched in a test. */
let events: FlagMap[];
const record = (event: Event) => events.push((event as CustomEvent<FlagMap>).detail);

/** Let the publish microtask and any pending promise chains run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

/** A flag configuration as the data plane streams or bootstraps it. */
const flag = (key: string, defaultValue: unknown, extra: Record<string, unknown> = {}) => ({
  key,
  type: typeof defaultValue === "object" ? "object" : typeof defaultValue,
  enabled: true,
  defaultValue,
  ...extra,
});

/** Serves "pro" on the pro plan. */
const proPlan = [{ id: "r1", conditions: [{ property: "plan", operator: "equals", value: "pro" }], value: "pro" }];
/** "pro" for the pro plan, "standard" otherwise: evaluated locally. */
const planBanner = () => flag("plan-banner", "standard", { targeting: proPlan });

/** One variant at 100%: what a user with a targetingKey gets. */
const variant = (name: string, value: unknown) => ({ variants: [{ name, value, weight: 100 }] });

/** Keyless stream: EventSource, driven by the test. */
function streamStub() {
  const named = new Map<string, (event: MessageEvent) => void>();
  const source = {
    onopen: null as null | (() => void),
    onmessage: null as null | ((event: MessageEvent) => void),
    onerror: null as null | (() => void),
    addEventListener: (name: string, fn: (event: MessageEvent) => void) => named.set(name, fn),
    close: vi.fn(),
  };
  vi.stubGlobal("EventSource", vi.fn(function () { return source; }));
  return {
    /** A named data-plane event (configuration_sync, configuration_delta). */
    emit: (name: string, payload: unknown) =>
      named.get(name)?.({ data: JSON.stringify(payload) } as MessageEvent),
    /** An unnamed message (control-plane flag-update, legacy value push). */
    message: (payload: unknown) => source.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent),
  };
}

beforeEach(() => {
  delete page.__FLAGGR_FLAGS__;
  delete page.__FLAGGR_BOOTSTRAP__;
  events = [];
  window.addEventListener("flaggr:flags-changed", record);
});

afterEach(() => {
  window.removeEventListener("flaggr:flags-changed", record);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exposeFlags: publishing resolved values for browser analytics", () => {
  it("publishes values from local, remote and bulk evaluation, for all four flag types", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/flags/evaluate/batch")) {
        const { flags } = JSON.parse(String(init?.body)) as { flags: Array<{ key: string }> };
        return json({ flags: flags.map(({ key }) => ({ key, value: 7, reason: "STATIC" })) });
      }
      return json({ value: "treatment", reason: "TARGETING_MATCH", variant: "b" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      bootstrap: { flags: [flag("hero", true), flag("layout", { columns: 3 }), flag("tier", "gold")] },
    });

    expect(client.getBooleanValueSync("hero", false)).toBe(true); // sync, local
    await expect(client.getObjectValue("layout", {})).resolves.toEqual({ columns: 3 }); // local
    await expect(client.getStringValue("checkout-copy", "control")).resolves.toBe("treatment"); // remote
    const bulk = await client.evaluateBatch([
      { flagKey: "max-items", defaultValue: 0 }, // bulk, remote
      { flagKey: "tier", defaultValue: "basic" }, // bulk, local
    ]);
    expect([bulk.get("max-items")?.value, bulk.get("tier")?.value]).toEqual([7, "gold"]);
    await settle();

    // Raw values, as the script expects: it derives variant strings itself.
    expect(page.__FLAGGR_FLAGS__).toEqual({
      hero: true,
      layout: { columns: 3 },
      "checkout-copy": "treatment",
      "max-items": 7,
      tier: "gold",
    });
    expect(events[events.length - 1]).toEqual(page.__FLAGGR_FLAGS__);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it("publishes values the page reads from the cache", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stream = streamStub();
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", updateMode: "stream" });

    // Value pushes cache flags the page hasn't used yet: nothing is published.
    stream.message({ flagKey: "promo", value: "spring", reason: "STATIC" });
    stream.message({ flagKey: "limit", value: 5, reason: "STATIC" });
    stream.message({ flagKey: "beta", value: true, reason: "STATIC" });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toBeUndefined();

    await expect(client.getStringValue("promo", "none")).resolves.toBe("spring");
    expect(client.evaluateSync("limit", 0).value).toBe(5);
    const bulk = await client.evaluateBatch([{ flagKey: "beta", defaultValue: false }]);
    expect(bulk.get("beta")?.value).toBe(true);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ promo: "spring", limit: 5, beta: true });
    expect(fetchMock).not.toHaveBeenCalled();
    client.destroy();
  });

  it("coalesces a burst into one event carrying the full map, and stays quiet when nothing changed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const config = {
      serviceId: "web",
      bootstrap: { flags: [flag("a", true), flag("b", "x"), flag("c", 1), flag("d", { cols: 2 })] },
    };
    const client = new FlaggrClient(config);

    for (let i = 0; i < 50; i++) {
      client.getBooleanValueSync("a", false);
      client.evaluateSync("b", "");
      client.evaluateSync("c", 0);
      client.evaluateSync("d", {});
    }
    // Written once the synchronous burst is over, not per evaluation.
    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    await settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ a: true, b: "x", c: 1, d: { cols: 2 } });
    expect(events[0]).toBe(page.__FLAGGR_FLAGS__);

    // The same values again, from this client or another one (whose object
    // value is a different instance with the same content): no event.
    client.getBooleanValueSync("a", false);
    await client.evaluate("b", "");
    const other = new FlaggrClient(JSON.parse(JSON.stringify(config)));
    other.getBooleanValueSync("a", false);
    other.evaluateSync("c", 0);
    other.evaluateSync("d", {});
    await settle();
    expect(events).toHaveLength(1);

    // A real change: one more event.
    const changed = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("c", 2)] } });
    changed.evaluateSync("c", 0);
    await settle();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ a: true, b: "x", c: 2, d: { cols: 2 } });
    for (const c of [client, other, changed]) c.destroy();
  });

  it("merges into what other code published and never drops its keys", async () => {
    vi.stubGlobal("fetch", vi.fn());
    // Published earlier by something else: the web provider, hand-written glue, another SDK copy.
    page.__FLAGGR_FLAGS__ = { "legacy-banner": "on", hero: false };
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("hero", true), flag("nav", "top")] },
    });

    client.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "legacy-banner": "on", hero: true });

    // A key added without an event, then a second client: everything is kept.
    page.__FLAGGR_FLAGS__ = { ...page.__FLAGGR_FLAGS__, "late-key": 1 };
    const checkout = new FlaggrClient({
      serviceId: "checkout",
      bootstrap: { flags: [flag("pay-later", true)] },
    });
    checkout.getBooleanValueSync("pay-later", false);
    client.evaluateSync("nav", "");
    await settle();

    const expected = { "legacy-banner": "on", hero: true, "late-key": 1, "pay-later": true, nav: "top" };
    expect(page.__FLAGGR_FLAGS__).toEqual(expected);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(expected);
    client.destroy();
    checkout.destroy();
  });

  it("keeps the server-rendered __FLAGGR_BOOTSTRAP__ values when it publishes first", async () => {
    vi.stubGlobal("fetch", vi.fn());
    page.__FLAGGR_BOOTSTRAP__ = { "ssr-layout": { value: "wide" }, hero: { value: false } };
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true)] } });

    client.getBooleanValueSync("hero", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ "ssr-layout": "wide", hero: true });
    client.destroy();
  });

  it("stays a lookup on repeat renders when the server-rendered values already match", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const keys = Array.from({ length: 30 }, (_, i) => `f${i}`);
    page.__FLAGGR_BOOTSTRAP__ = Object.fromEntries(keys.map((key) => [key, { value: true }]));
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: keys.map((key) => flag(key, true)) } });
    const render = () => keys.forEach((key) => client.getBooleanValueSync(key, false));
    render();
    await settle();
    // The same values the script already reads: on the page, nothing to announce.
    expect(page.__FLAGGR_FLAGS__).toEqual(Object.fromEntries(keys.map((key) => [key, true])));
    expect(events).toHaveLength(0);

    /** What ten more renders cost. */
    const tenRenders = async () => {
      // Passes over a map holding these flags: everything the client
      // published, say. (The test runner iterates maps of its own meanwhile.)
      let walks = 0;
      const iterate = Map.prototype[Symbol.iterator];
      const spies = {
        queued: vi.spyOn(globalThis, "queueMicrotask"),
        serialized: vi.spyOn(JSON, "stringify"),
        walked: vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
          if (this.has("f0")) walks++;
          return iterate.call(this);
        }),
      };
      for (let i = 0; i < 10; i++) {
        render();
        await settle();
      }
      const calls = { queued: spies.queued.mock.calls.length, serialized: spies.serialized.mock.calls.length, walks };
      for (const spy of Object.values(spies)) spy.mockRestore(); // before the assertions use them
      return calls;
    };
    expect(await tenRenders()).toEqual({ queued: 0, serialized: 0, walks: 0 });

    // Other code merges a key in: a new map, with everything still there.
    // One look confirms that; the renders after it are lookups again.
    page.__FLAGGR_FLAGS__ = { ...page.__FLAGGR_FLAGS__, other: 1 };
    expect(await tenRenders()).toEqual({ queued: 0, serialized: 0, walks: 1 });
    expect(events).toHaveLength(0);
    client.destroy();
  });

  it("never publishes a fallback: errors, missing flags, defaults, nothing loaded yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/batch")) {
          // "gone" is missing from the response; "broken" failed on the server.
          return json({ flags: [{ key: "broken", reason: "ERROR" }] });
        }
        const { flagKey } = JSON.parse(String(init?.body)) as { flagKey: string };
        if (flagKey === "missing") {
          // The data plane's answer for a flag that doesn't exist: 200, no value.
          return json({ flagKey, reason: "FLAG_NOT_FOUND", errorCode: "FLAG_NOT_FOUND" });
        }
        if (flagKey === "offline") throw new TypeError("Failed to fetch");
        return json({ error: "boom" }, 500);
      }),
    );
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      defaults: { "has-default": "configured" },
    });

    expect(client.evaluateSync("not-loaded", "fallback").value).toBe("fallback");
    expect(client.getBooleanValueSync("not-loaded-either", true)).toBe(true);
    await expect(client.getStringValue("has-default", "x")).resolves.toBe("configured");
    await expect(client.getBooleanValue("missing", true)).resolves.toBe(true);
    await expect(client.getBooleanValue("missing", true)).resolves.toBe(true); // cached
    await expect(client.getBooleanValue("offline", true)).resolves.toBe(true);
    await expect(client.getNumberValue("server-error", 3)).resolves.toBe(3);
    const bulk = await client.evaluateBatch([
      { flagKey: "gone", defaultValue: "a" },
      { flagKey: "broken", defaultValue: "b" },
    ]);
    expect([bulk.get("gone")?.reason, bulk.get("broken")?.reason]).toEqual(["ERROR", "ERROR"]);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    expect(events).toHaveLength(0);
    client.destroy();
  });

  it("keeps the last resolved value when a later evaluation fails", async () => {
    let answer: "treatment" | "offline" | "left out" | "error" = "treatment";
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (answer === "offline") throw new TypeError("Failed to fetch");
      if (answer === "treatment") return json({ value: "treatment", reason: "TARGETING_MATCH" });
      if (!String(url).endsWith("/batch")) throw new Error(`unexpected request to ${String(url)}`);
      // Batch answers that don't resolve the flag: one leaves it out (the
      // SDK's "Flag missing from batch response"), one reports an error.
      return json(answer === "left out" ? { flags: {}, total: 0 } : { flags: [{ key: "copy", reason: "ERROR" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web" });

    await expect(client.getStringValue("copy", "control")).resolves.toBe("treatment");
    answer = "offline";
    // The refresh fails: the cached value is dropped, so the next read goes
    // to the network, and fails too.
    await client.refresh();
    await expect(client.getStringValue("copy", "control")).resolves.toBe("control");
    for (const next of ["left out", "error"] as const) {
      answer = next;
      await client.refresh();
      const bulk = await client.evaluateBatch([{ flagKey: "copy", defaultValue: "control" }]);
      expect(bulk.get("copy")).toMatchObject({ value: "control", reason: "ERROR" });
      // Read again from the cache, still as an error.
      expect(client.evaluateSync("copy", "control")).toMatchObject({ value: "control", reason: "ERROR" });
    }
    await settle();

    // The evaluation, the failed refresh and read, then a batch each for the
    // two answers (nothing was cached for the first refresh to ask about),
    // and the second refresh's batch.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(page.__FLAGGR_FLAGS__).toEqual({ copy: "treatment" });
    expect(events).toHaveLength(1);
    client.destroy();
  });

  it("publishes stream updates to flags the page uses, not the rest of the configuration", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const stream = streamStub();
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", updateMode: "stream" });
    const watched: unknown[] = [];
    client.onFlagChange("watched", (event) => watched.push(event.newValue));

    stream.emit("configuration_sync", {
      type: "configuration_sync",
      version: "v1",
      flags: [flag("hero", true), flag("unused", true), flag("watched", "a")],
    });
    await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
    await settle();
    // "unused" is in the configuration, but the page never asked for it.
    expect(page.__FLAGGR_FLAGS__).toEqual({ watched: "a", hero: true });
    const before = events.length;

    stream.emit("configuration_delta", {
      type: "configuration_delta",
      version: "v2",
      flags: [flag("hero", false), flag("unused", false), flag("watched", "b")],
    });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ watched: "b", hero: false });
    expect(events).toHaveLength(before + 1); // one burst, one event

    // Control-plane flag-update carrying the full flag.
    stream.message({ type: "flag-update", flagKey: "hero", eventType: "UPDATED", flag: flag("hero", true) });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ watched: "b", hero: true });

    // Value pushes: republished for a flag in use, ignored otherwise.
    stream.message({ flagKey: "watched", value: "c" });
    stream.message({ flagKey: "never-used", value: "z" });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ watched: "c", hero: true });
    expect(watched).toEqual(["a", "b", "c"]);
    client.destroy();
  });

  it("publishes batch-mode refreshes", async () => {
    vi.useFakeTimers();
    let copy = "control";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const { flags } = JSON.parse(String(init?.body)) as { flags: Array<{ key: string }> };
        return json({ flags: flags.map(({ key }) => ({ key, value: copy, reason: "STATIC" })) });
      }),
    );
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      updateMode: "batch",
      batchIntervalMs: 1000,
    });
    client.onFlagChange("checkout-copy", () => {});

    await vi.advanceTimersByTimeAsync(1000);
    expect(page.__FLAGGR_FLAGS__).toEqual({ "checkout-copy": "control" });
    copy = "redesign";
    await vi.advanceTimersByTimeAsync(1000);
    expect(page.__FLAGGR_FLAGS__).toEqual({ "checkout-copy": "redesign" });
    await vi.advanceTimersByTimeAsync(1000); // unchanged: no event
    expect(events.map((detail) => detail["checkout-copy"])).toEqual(["control", "redesign"]);
    client.destroy();
  });

  it("publishes values from the data plane's batch answer, a map of flag key → result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        // services/flaggr-api/handler/rest.go: the keys asked for, a missing one as FLAG_NOT_FOUND.
        const { flagKeys } = JSON.parse(String(init?.body)) as { flagKeys: string[] };
        const results: Record<string, unknown> = {
          "checkout-copy": { flagKey: "checkout-copy", value: "redesign", reason: "TARGETING_MATCH", evaluatedAt: "" },
          layout: { flagKey: "layout", value: { columns: 3 }, variant: "three-col", reason: "TARGETING_MATCH", evaluatedAt: "" },
          gone: { flagKey: "gone", value: null, reason: "FLAG_NOT_FOUND", errorCode: "FLAG_NOT_FOUND", evaluatedAt: "" },
        };
        const flags = Object.fromEntries(flagKeys.map((key) => [key, results[key]]));
        return json({ flags, total: flagKeys.length, evaluatedAt: "2026-10-08T03:00:00Z" });
      }),
    );
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web" });

    const bulk = await client.evaluateBatch([
      { flagKey: "checkout-copy", defaultValue: "control" },
      { flagKey: "layout", defaultValue: {} },
      { flagKey: "gone", defaultValue: "none" },
    ]);
    expect([bulk.get("checkout-copy")?.value, bulk.get("gone")?.value]).toEqual(["redesign", "none"]);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ "checkout-copy": "redesign", layout: "three-col" });
    client.destroy();
  });

  it("republishes what listeners receive after setContext", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      context: { targetingKey: "u1", plan: "free" },
      bootstrap: {
        flags: [
          flag("plan-banner", "standard", {
            targeting: [
              { id: "r1", conditions: [{ property: "plan", operator: "equals", value: "pro" }], value: "pro" },
            ],
          }),
        ],
      },
    });
    client.onFlagChange("plan-banner", () => {});
    expect(client.evaluateSync("plan-banner", "").value).toBe("standard");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "standard" });

    client.setContext({ targetingKey: "u1", plan: "pro" });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "pro" });
    client.destroy();
  });

  it("republishes a flag the page evaluated for the new context after setContext, watched or not", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      context: { targetingKey: "u1", plan: "free" },
      bootstrap: { flags: [planBanner(), flag("unused", "a", { targeting: proPlan })] },
    });
    // Read once (a plain render), never watched.
    expect(client.evaluateSync("plan-banner", "").value).toBe("standard");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "standard" });

    client.setContext({ targetingKey: "u1", plan: "pro" }); // e.g. the user upgraded
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "pro" });
    expect(client.evaluateSync("plan-banner", "").value).toBe("pro");
    client.destroy();
  });

  it("publishes a remote-only flag again at its first evaluation after setContext", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ value: "treatment", reason: "TARGETING_MATCH" })));
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", context: { targetingKey: "u1" } });
    await expect(client.getStringValue("remote-copy", "control")).resolves.toBe("treatment");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "remote-copy": "treatment" });
    // Something else wrote that key meanwhile.
    page.__FLAGGR_FLAGS__ = { "remote-copy": "stale" };

    client.setContext({ targetingKey: "u2" });
    await settle();
    // Only the data plane can evaluate it: nothing to publish until the page asks.
    expect(page.__FLAGGR_FLAGS__).toEqual({ "remote-copy": "stale" });

    // The same value as before the context change, but now for the new context.
    await expect(client.getStringValue("remote-copy", "control")).resolves.toBe("treatment");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "remote-copy": "treatment" });
    client.destroy();
  });

  it("leaves a value published with a per-call context to its next evaluation after setContext", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      context: { targetingKey: "u1", plan: "free" },
      bootstrap: { flags: [planBanner()] },
    });
    // The page's own user, with an attribute the client's context doesn't carry.
    const ownContext = { targetingKey: "u1", plan: "pro" };
    expect(client.evaluateSync("plan-banner", "", ownContext).value).toBe("pro");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "pro" });

    // An unrelated change: the page still shows (and evaluates) "pro".
    client.setContext({ targetingKey: "u1", plan: "free", locale: "en" });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "pro" });
    expect(client.evaluateSync("plan-banner", "", ownContext).value).toBe("pro");

    // Read with the client's own context again: from then on setContext
    // republishes it at once.
    expect(client.evaluateSync("plan-banner", "").value).toBe("standard");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "standard" });
    client.setContext({ targetingKey: "u1", plan: "pro" });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "pro" });
    client.destroy();
  });

  it("after setContext, puts back neither its old context's values nor holds back another client's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ value: "dark", reason: "TARGETING_MATCH" })));
    const web = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      context: { targetingKey: "anon-1" },
      bootstrap: { flags: [flag("hero", true)] },
    });
    const checkout = new FlaggrClient({
      serviceId: "checkout",
      bootstrap: { flags: [flag("theme", "light"), flag("pay-later", true)] },
    });
    await expect(web.getStringValue("theme", "light")).resolves.toBe("dark"); // remote, for the anonymous visitor
    web.getBooleanValueSync("hero", false);
    await settle();
    checkout.evaluateSync("theme", "dark"); // the newer resolution of the key
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ theme: "light", hero: true });

    web.setContext({ targetingKey: "u2" }); // they sign in: theme waits for its next evaluation
    page.__FLAGGR_FLAGS__ = { other: 1 }; // other code replaces the map
    web.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, hero: true });
    checkout.getBooleanValueSync("pay-later", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, hero: true, theme: "light", "pay-later": true });
    web.destroy();
    checkout.destroy();
  });

  it("doesn't cache, track or publish a remote result that arrives after setContext", async () => {
    let release!: (response: Response) => void;
    const outcomes: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/events/outcomes")) {
        outcomes.push(JSON.parse(String(init?.body)).variant);
        return json({});
      }
      const { context } = JSON.parse(String(init?.body)) as { context: { targetingKey: string } };
      if (context.targetingKey === "anon-1") return new Promise<Response>((resolve) => (release = resolve));
      return json({ value: "member-copy", variant: "member", reason: "TARGETING_MATCH" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", context: { targetingKey: "anon-1" } });

    const before = client.getStringValue("remote-copy", "control"); // for the anonymous visitor
    await settle(); // the request is out
    client.setContext({ targetingKey: "u2" }); // they sign in
    release(json({ value: "anon-copy", variant: "anon", reason: "TARGETING_MATCH" }));
    await expect(before).resolves.toBe("anon-copy"); // the caller still gets its answer
    await settle();
    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    await client.trackOutcome({ flagKey: "remote-copy", eventName: "signup" });

    // Not cached for u2: the next read asks the data plane for u2.
    await expect(client.getStringValue("remote-copy", "control")).resolves.toBe("member-copy");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "remote-copy": "member-copy" });
    await client.trackOutcome({ flagKey: "remote-copy", eventName: "signup" });
    expect(outcomes).toEqual(["unknown", "member"]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/flags/evaluate"))).toHaveLength(2);
    client.destroy();
  });

  it("doesn't cache or publish batch results that arrive after setContext", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const { context, flags } = JSON.parse(String(init?.body)) as {
        context: { targetingKey: string };
        flags: Array<{ key: string }>;
      };
      const value = context.targetingKey === "anon-1" ? "anon-copy" : "member-copy";
      const response = json({ flags: flags.map(({ key }) => ({ key, value, reason: "TARGETING_MATCH" })) });
      if (context.targetingKey === "anon-1") return new Promise<Response>((resolve) => (release = () => resolve(response)));
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", context: { targetingKey: "anon-1" } });
    const requests = [{ flagKey: "remote-copy", defaultValue: "control" }];

    const before = client.evaluateBatch(requests);
    await settle(); // the request is out
    client.setContext({ targetingKey: "u2" });
    release();
    expect((await before).get("remote-copy")?.value).toBe("anon-copy");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toBeUndefined();

    expect((await client.evaluateBatch(requests)).get("remote-copy")?.value).toBe("member-copy");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "remote-copy": "member-copy" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it("treats an evaluation called before setContext as the old context's while remote config still loads", async () => {
    let releaseConfig!: () => void;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/sdk-config") {
        return new Promise<Response>((resolve) => (releaseConfig = () => resolve(json({}))));
      }
      const body = JSON.parse(String(init?.body)) as { context: { targetingKey: string }; flags?: Array<{ key: string }> };
      const value = body.context.targetingKey === "anon-1" ? "anon-copy" : "member-copy";
      if (body.flags) return json({ flags: body.flags.map(({ key }) => ({ key, value, reason: "TARGETING_MATCH" })) });
      return json({ value, reason: "TARGETING_MATCH" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "config-race",
      remoteConfig: true,
      context: { targetingKey: "anon-1" },
    });

    // Both wait for the remote config before asking the data plane.
    const single = client.getStringValue("remote-copy", "control");
    const batch = client.evaluateBatch([{ flagKey: "batch-copy", defaultValue: "control" }]);
    await settle();
    client.setContext({ targetingKey: "u2" });
    releaseConfig();

    // Answered for the context they were called with, and only for it.
    await expect(single).resolves.toBe("anon-copy");
    expect((await batch).get("batch-copy")?.value).toBe("anon-copy");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    await expect(client.getStringValue("remote-copy", "control")).resolves.toBe("member-copy");
    client.destroy();
    localStorage.clear();
  });

  it("doesn't publish values evaluated for someone else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/batch")) {
          const { flags } = JSON.parse(String(init?.body)) as { flags: Array<{ key: string }> };
          return json({ flags: flags.map(({ key }) => ({ key, value: "pro-copy", reason: "TARGETING_MATCH" })) });
        }
        return json({ value: "pro-copy", reason: "TARGETING_MATCH" });
      }),
    );
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      context: { targetingKey: "u1", plan: "free" },
      bootstrap: { flags: [planBanner()] },
    });

    // An admin page previewing what a customer sees, on every evaluation path.
    const customer = { targetingKey: "customer-42", plan: "pro" };
    expect(client.evaluateSync("plan-banner", "", customer).value).toBe("pro"); // sync, local
    for (let i = 0; i < 2; i++) {
      await expect(client.getStringValue("plan-banner", "", customer)).resolves.toBe("pro"); // local, then cached
      await expect(client.getStringValue("remote-copy", "", customer)).resolves.toBe("pro-copy"); // remote, then cached
    }
    const both = [
      { flagKey: "plan-banner", defaultValue: "" },
      { flagKey: "remote-copy", defaultValue: "" },
    ];
    await client.evaluateBatch(both, customer); // bulk, cached
    const bulk = await client.evaluateBatch(both, { targetingKey: "customer-43", plan: "pro" }); // bulk, local and remote
    expect([bulk.get("plan-banner")?.value, bulk.get("remote-copy")?.value]).toEqual(["pro", "pro-copy"]);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    expect(events).toHaveLength(0);

    // The page's own user is published, including through a per-call context
    // with the same targetingKey.
    expect(client.evaluateSync("plan-banner", "").value).toBe("standard");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "standard" });
    expect(client.evaluateSync("plan-banner", "", { targetingKey: "u1", plan: "pro" }).value).toBe("pro");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "pro" });
    client.destroy();
  });

  it("doesn't publish an evaluation whose per-call context clears the client's targetingKey", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { context: { targetingKey?: string }; flags?: Array<{ key: string }> };
        const value = body.context.targetingKey ? "member-copy" : "anonymous-copy";
        if (body.flags) return json({ flags: body.flags.map(({ key }) => ({ key, value, reason: "TARGETING_MATCH" })) });
        return json({ value, reason: "TARGETING_MATCH" });
      }),
    );
    const beta = flag("beta", "off", {
      targeting: [{ id: "r1", conditions: [{ property: "targetingKey", operator: "equals", value: "device-1" }], value: "on" }],
    });
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      context: { targetingKey: "device-1" },
      bootstrap: { flags: [beta] },
    });

    // useFlag(key, def, { targetingKey: user?.id }) before the user has loaded: nobody's values.
    const cleared = { targetingKey: undefined };
    expect(client.evaluateSync("beta", "off", cleared).value).toBe("off"); // sync, local
    for (let i = 0; i < 2; i++) {
      await expect(client.getStringValue("beta", "off", cleared)).resolves.toBe("off"); // local, then cached
      await expect(client.getStringValue("remote-copy", "", { targetingKey: "" })).resolves.toBe("anonymous-copy"); // remote, then cached
    }
    const bulk = await client.evaluateBatch(
      [
        { flagKey: "beta", defaultValue: "off" },
        { flagKey: "batch-copy", defaultValue: "" },
      ],
      cleared,
    ); // bulk, local and remote
    expect([bulk.get("beta")?.value, bulk.get("batch-copy")?.value]).toEqual(["off", "anonymous-copy"]);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toBeUndefined();

    // A per-call context that doesn't mention the targetingKey keeps the client's.
    expect(client.evaluateSync("beta", "off", { plan: "pro" }).value).toBe("on");
    await expect(client.getStringValue("remote-copy", "", { plan: "pro" })).resolves.toBe("member-copy");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ beta: "on", "remote-copy": "member-copy" });
    client.destroy();
  });

  it("publishes per-call contexts when the client has no targetingKey of its own", async () => {
    vi.stubGlobal("fetch", vi.fn());
    // A FlaggrProvider without a context, and useFlag(key, def, { targetingKey: user.id, ... }).
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [planBanner()] } });

    expect(client.evaluateSync("plan-banner", "", { targetingKey: "u42", plan: "pro" }).value).toBe("pro");
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ "plan-banner": "pro" });
    client.destroy();
  });

  it("puts its values back after other code replaces the map", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("hero", true), flag("tier", "gold")] },
    });
    client.getBooleanValueSync("hero", false);
    client.evaluateSync("tier", "basic");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true, tier: "gold" });

    // Code that replaces the map: Flaggr's OpenFeature web provider, or glue
    // written for SDK 0.4.0 (`window.__FLAGGR_FLAGS__ = flags`).
    page.__FLAGGR_FLAGS__ = { "provider-flag": "on" };
    window.dispatchEvent(new CustomEvent("flaggr:flags-changed", { detail: page.__FLAGGR_FLAGS__ }));

    for (let i = 0; i < 3; i++) {
      client.getBooleanValueSync("hero", false);
      await expect(client.getStringValue("tier", "basic")).resolves.toBe("gold");
    }
    await settle();

    const restored = { "provider-flag": "on", hero: true, tier: "gold" };
    expect(page.__FLAGGR_FLAGS__).toEqual(restored);
    // The SDK's first event, the replacement's, and one for the restore.
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual(restored);
    client.destroy();
  });

  it("puts back every value the new map dropped at its next evaluation of any flag", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("_flaggr_analytics", "full"), flag("tier", "gold"), flag("hero", true)] },
    });
    // Read once, at load.
    client.evaluateSync("_flaggr_analytics", "standard");
    client.evaluateSync("tier", "basic");
    client.getBooleanValueSync("hero", false);
    await settle();
    page.__FLAGGR_FLAGS__ = { "legacy-banner": "on" };
    window.dispatchEvent(new CustomEvent("flaggr:flags-changed", { detail: page.__FLAGGR_FLAGS__ }));

    client.getBooleanValueSync("hero", false); // the page goes on reading one flag
    await settle();

    const restored = { "legacy-banner": "on", _flaggr_analytics: "full", tier: "gold", hero: true };
    expect(page.__FLAGGR_FLAGS__).toEqual(restored);
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual(restored);
    client.destroy();
  });

  it("puts back a value other code deleted from the map in place when the page reads it again", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true)] } });
    client.getBooleanValueSync("hero", false);
    await settle();

    delete page.__FLAGGR_FLAGS__!.hero; // the same map object, minus the key
    client.getBooleanValueSync("hero", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
    client.destroy();
  });

  it("puts its values back after other code deletes the whole map", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true), flag("tier", "gold")] } });
    client.getBooleanValueSync("hero", false);
    client.evaluateSync("tier", "basic");
    await settle();

    delete page.__FLAGGR_FLAGS__;
    client.getBooleanValueSync("hero", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true, tier: "gold" });
    client.destroy();
  });

  it("puts back values other code dropped in the same burst the client queued another in", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("hero", true), flag("tier", "gold"), flag("nav", "top")] },
    });
    client.getBooleanValueSync("hero", false);
    client.evaluateSync("tier", "basic");
    await settle();

    // One synchronous stretch: a new flag read, then other code replaces the map.
    client.evaluateSync("nav", "side");
    page.__FLAGGR_FLAGS__ = { other: 1 };
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, nav: "top" });

    client.evaluateSync("nav", "side");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, nav: "top", hero: true, tier: "gold" });
    client.destroy();
  });

  it("puts its values back after other code deletes a map it set up while the client's first values waited", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("hero", true), flag("tier", "gold"), flag("nav", "top")] },
    });
    client.getBooleanValueSync("hero", false);
    client.evaluateSync("tier", "basic");
    page.__FLAGGR_FLAGS__ = { other: 1 }; // the same synchronous stretch
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, hero: true, tier: "gold" });

    delete page.__FLAGGR_FLAGS__;
    client.evaluateSync("nav", "side");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true, tier: "gold", nav: "top" });
    client.destroy();
  });

  it("carries the server-rendered values over only while nothing is on the page", async () => {
    vi.stubGlobal("fetch", vi.fn());
    page.__FLAGGR_BOOTSTRAP__ = { "ssr-layout": { value: "wide" }, hero: { value: false } };
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true)] } });
    client.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "ssr-layout": "wide", hero: true });

    // From now on the script reads the live map, whatever it holds.
    page.__FLAGGR_FLAGS__ = { other: 1 };
    client.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, hero: true });
    client.destroy();
  });

  it("carries server-rendered values over by its own rules: own keys, copies, within the size limit", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const layout = { columns: 2 };
    const analyticsConfig = { clicks: true, note: "z".repeat(2000) };
    page.__FLAGGR_BOOTSTRAP__ = Object.assign(Object.create({ inherited: { value: "x" } }), {
      layout: { value: layout },
      "legal-text": { value: { copy: "x".repeat(4000) } },
      "legal-copy": { value: "y".repeat(4000) },
      _flaggr_analytics: { value: analyticsConfig },
    });
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true)] } });

    client.getBooleanValueSync("hero", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ layout: { columns: 2 }, _flaggr_analytics: analyticsConfig, hero: true });
    expect(page.__FLAGGR_FLAGS__!.layout).not.toBe(layout);
    client.destroy();
  });

  it("doesn't carry over a server-rendered value for a key whose latest value it kept off the page", async () => {
    vi.stubGlobal("fetch", vi.fn());
    page.__FLAGGR_BOOTSTRAP__ = { "legal-text": { value: { copy: "short" } }, hero: { value: true } };
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("legal-text", { copy: "x".repeat(2000) }), flag("hero", true)] },
    });
    client.evaluateSync("legal-text", {}); // its value now: too big to publish
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });

    // Other code deletes the map: the next publish starts from the server-rendered values again.
    delete page.__FLAGGR_FLAGS__;
    client.getBooleanValueSync("hero", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
    client.destroy();
  });

  it("leaves a key the new map holds with another value: re-reading an unchanged value isn't a new resolution", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true)] } });
    client.getBooleanValueSync("hero", false);
    await settle();

    page.__FLAGGR_FLAGS__ = { hero: false, other: 1 }; // another writer's value for the key
    for (let i = 0; i < 3; i++) client.getBooleanValueSync("hero", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: false, other: 1 });
    expect(events).toHaveLength(1);
    client.destroy();
  });

  it("doesn't put back a value another client's newer resolution kept off the page", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const short = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("legal-text", { copy: "short" }), flag("hero", true)] } });
    const long = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("legal-text", { copy: "x".repeat(2000) })] } });
    short.evaluateSync("legal-text", {});
    await settle();
    long.evaluateSync("legal-text", {}); // newer, and too big to publish: removed
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({});

    short.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
    short.destroy();
    long.destroy();
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "puts back a flag keyed %s, a name every object inherits, like any other",
    async (key) => {
      vi.stubGlobal("fetch", vi.fn());
      const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag(key, "on")] } });
      client.evaluateSync(key, "off");
      await settle();
      expect(Object.keys(page.__FLAGGR_FLAGS__!)).toEqual([key]);

      page.__FLAGGR_FLAGS__ = { other: 1 };
      client.evaluateSync(key, "off");
      await settle();
      // Own keys and values only: the map's own `toString` (say) is the flag's value.
      expect(Object.keys(page.__FLAGGR_FLAGS__!)).toEqual(["other", key]);
      expect(Object.values(page.__FLAGGR_FLAGS__!)).toEqual([1, "on"]);
      client.destroy();
    },
  );

  it("announces nothing when a value it keeps off the page has an inherited name and nothing to remove", async () => {
    vi.stubGlobal("fetch", vi.fn());
    page.__FLAGGR_FLAGS__ = { other: 1 };
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("constructor", { copy: "x".repeat(2000) })] },
    });

    client.evaluateSync("constructor", {});
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1 });
    expect(events).toHaveLength(0);
    client.destroy();
  });

  it("never fails an evaluation over a map it can't read, and publishes again once it can", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true)] } });
    client.getBooleanValueSync("hero", false);
    await settle();
    const evaluateAll = async () => {
      expect(client.getBooleanValueSync("hero", false)).toBe(true);
      await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
      expect((await client.evaluateBatch([{ flagKey: "hero", defaultValue: false }])).get("hero")?.value).toBe(true);
      await settle();
    };

    // Page code left a revoked Proxy there.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    page.__FLAGGR_FLAGS__ = proxy;
    await evaluateAll();

    // Or a getter that throws.
    Object.defineProperty(window, "__FLAGGR_FLAGS__", {
      configurable: true,
      get() {
        throw new Error("no flags for you");
      },
    });
    await evaluateAll();

    delete page.__FLAGGR_FLAGS__;
    page.__FLAGGR_FLAGS__ = {};
    await evaluateAll();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
    client.destroy();
  });

  it("doesn't let two clients overwrite each other back and forth", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const light = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("theme", "light")] } });
    const dark = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("theme", "dark")] } });
    light.evaluateSync("theme", "");
    await settle();
    dark.evaluateSync("theme", "");
    await settle();

    for (let i = 0; i < 5; i++) {
      light.evaluateSync("theme", "");
      await settle();
      dark.evaluateSync("theme", "");
      await settle();
    }

    // The latest resolution wins; reading an unchanged value again isn't one.
    expect(page.__FLAGGR_FLAGS__).toEqual({ theme: "dark" });
    expect(events).toHaveLength(2);
    light.destroy();
    dark.destroy();
  });

  it("publishes copies, so changes to the objects it returned don't reach the page", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("layout", { columns: 3, nav: ["top"] })] },
    });
    const layout = await client.getObjectValue<{ columns: number; nav: string[]; self?: unknown }>("layout", {
      columns: 1,
      nav: [],
    });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ layout: { columns: 3, nav: ["top"] } });

    // App code changing the object it got back, down to making it circular.
    layout.columns = 99;
    layout.nav.push("side");
    layout.self = layout;

    expect(page.__FLAGGR_FLAGS__).toEqual({ layout: { columns: 3, nav: ["top"] } });
    expect(() => JSON.stringify(page.__FLAGGR_FLAGS__)).not.toThrow();
    client.destroy();
  });

  it("copies a value as resolved, and puts that copy back, whatever the app did to the object since", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("layout", { columns: 3 }), flag("theme", { dark: true }), flag("hero", true)] },
    });
    const layout = await client.getObjectValue<{ columns: number; self?: unknown }>("layout", { columns: 1 });
    // Changed in the same synchronous stretch as the evaluation, before the values are written.
    const theme = client.evaluateSync<Record<string, unknown>>("theme", {}).value;
    theme.dark = false;
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ layout: { columns: 3 }, theme: { dark: true } });

    // The app changes the object, down to making it circular, and other code replaces the map.
    layout.columns = 99;
    layout.self = layout;
    page.__FLAGGR_FLAGS__ = { other: 1 };
    for (let i = 0; i < 3; i++) {
      client.getBooleanValueSync("hero", false);
      await client.getObjectValue("layout", {});
      await settle();
    }

    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, layout: { columns: 3 }, theme: { dark: true }, hero: true });
    client.destroy();
  });

  it("skips a value it can't serialize, and still publishes the rest of the burst", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const cyclic: Record<string, unknown> = { mode: "grid" };
    cyclic.self = cyclic;
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("cyclic", cyclic), flag("hero", true), flag("big-number", 10n)] },
    });

    client.evaluateSync("cyclic", {});
    client.evaluateSync("big-number", 0);
    client.getBooleanValueSync("hero", false);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
    expect(events).toHaveLength(1);
    client.destroy();
  });

  it("publishes object and array values by variant name, and keeps values over ~1 KB off the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/batch")) {
          const { flags } = JSON.parse(String(init?.body)) as { flags: Array<{ key: string }> };
          return json({
            flags: flags.map(({ key }) => ({ key, value: { cols: 2 }, variant: "two-col", reason: "TARGETING_MATCH" })),
          });
        }
        return json({ value: { cols: 4 }, variant: "four-col", reason: "TARGETING_MATCH" });
      }),
    );
    const analyticsConfig = { clicks: true, scroll: true, sampling: 1, note: "y".repeat(2000) };
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      context: { targetingKey: "u1" },
      bootstrap: {
        flags: [
          flag("layout", { columns: 1 }, variant("three-col", { columns: 3 })),
          flag("menu", ["home", "pricing"], variant("short-menu", ["home"])),
          flag("theme", { dark: true }), // no variant name: the value itself
          flag("checkout-copy", "plain", variant("b", "treatment")), // not an object: the value itself
          flag("legal-text", { copy: "x".repeat(2000) }), // over ~1 KB, no variant name
          flag("_flaggr_analytics", "off", variant("everything", analyticsConfig)), // always in full
        ],
      },
    });

    for (const key of ["layout", "menu", "theme", "checkout-copy", "legal-text", "_flaggr_analytics"]) {
      client.evaluateSync(key, "");
    }
    await client.getObjectValue("remote-layout", {});
    await client.evaluateBatch([{ flagKey: "batch-layout", defaultValue: {} }]);
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({
      layout: "three-col",
      menu: "short-menu",
      theme: { dark: true },
      "checkout-copy": "treatment",
      _flaggr_analytics: analyticsConfig,
      "remote-layout": "four-col",
      "batch-layout": "two-col",
    });
    client.destroy();
  });

  it("publishes values up to 1,024 characters of JSON, and _flaggr_analytics at any size", async () => {
    vi.stubGlobal("fetch", vi.fn());
    // `{"copy":"…"}` is 11 characters around the copy, a JSON string 2.
    const object = (length: number) => ({ copy: "x".repeat(length - 11) });
    const string = (length: number) => "y".repeat(length - 2);
    const values: Record<string, unknown> = {
      "object-1024": object(1024),
      "object-1025": object(1025),
      "string-1024": string(1024),
      "string-1025": string(1025),
      _flaggr_analytics: { clicks: true, note: "z".repeat(1100) },
    };
    for (const [key, value] of Object.entries(values)) {
      if (key !== "_flaggr_analytics") expect(JSON.stringify(value)).toHaveLength(Number(key.slice(-4)));
    }
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: Object.entries(values).map(([key, value]) => flag(key, value)) },
    });

    for (const key of Object.keys(values)) client.evaluateSync(key, "");
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({
      "object-1024": values["object-1024"],
      "string-1024": values["string-1024"],
      _flaggr_analytics: values._flaggr_analytics,
    });
    client.destroy();
  });

  it("removes a published value when its newer value can't be published", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const stream = streamStub();
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", updateMode: "stream" });
    stream.emit("configuration_sync", {
      type: "configuration_sync",
      flags: [flag("legal-text", { copy: "short" }), flag("hero", true)],
    });
    await client.getObjectValue("legal-text", {});
    client.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "legal-text": { copy: "short" }, hero: true });

    // The value outgrows the limit: events mustn't keep carrying the old one.
    stream.emit("configuration_delta", {
      type: "configuration_delta",
      flags: [flag("legal-text", { copy: "x".repeat(2000) })],
    });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
    expect(events[events.length - 1]).toEqual({ hero: true });

    // Back under the limit: published again, and put back like any other
    // value if other code replaces the map.
    stream.emit("configuration_delta", {
      type: "configuration_delta",
      flags: [flag("legal-text", { copy: "medium" })],
    });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true, "legal-text": { copy: "medium" } });
    page.__FLAGGR_FLAGS__ = {};
    await client.getObjectValue("legal-text", {});
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true, "legal-text": { copy: "medium" } });
    client.destroy();
  });

  it("doesn't queue a value it kept off the page again on every evaluation", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("legal-text", { copy: "x".repeat(2000) })] },
    });
    client.evaluateSync("legal-text", {});
    await settle();

    const queued = vi.spyOn(globalThis, "queueMicrotask");
    for (let i = 0; i < 100; i++) client.evaluateSync("legal-text", {});
    expect(queued).not.toHaveBeenCalled();
    queued.mockRestore();

    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    client.destroy();
  });

  it("takes a deleted flag's value off the page, and doesn't put it back", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const stream = streamStub();
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", updateMode: "stream" });
    stream.emit("configuration_sync", { type: "configuration_sync", flags: [flag("old-promo", "spring"), flag("hero", true)] });
    client.evaluateSync("old-promo", "none");
    client.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ "old-promo": "spring", hero: true });

    stream.message({ type: "flag-update", flagKey: "old-promo", eventType: "DELETED" });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
    expect(events[events.length - 1]).toEqual({ hero: true });

    // Other code replaces the map: only the flag that still exists comes back.
    page.__FLAGGR_FLAGS__ = { other: 1 };
    client.getBooleanValueSync("hero", false);
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ other: 1, hero: true });
    client.destroy();
  });

  it("takes off flags a configuration_delta removes or a later configuration_sync no longer has", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ value: "treatment", reason: "TARGETING_MATCH" })));
    const stream = streamStub();
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", updateMode: "stream" });
    stream.emit("configuration_sync", { type: "configuration_sync", flags: [flag("a", 1), flag("b", 2), flag("hero", true)] });
    client.evaluateSync("a", 0);
    client.evaluateSync("b", 0);
    client.getBooleanValueSync("hero", false);
    // Not in the configuration at all: a configuration without it says nothing about it.
    await expect(client.getStringValue("remote-copy", "control")).resolves.toBe("treatment");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ a: 1, b: 2, hero: true, "remote-copy": "treatment" });

    stream.emit("configuration_delta", { type: "configuration_delta", flags: [], removed: ["a"] });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ b: 2, hero: true, "remote-copy": "treatment" });

    // The stream reconnects after "b" was deleted: a full configuration without it.
    stream.emit("configuration_sync", { type: "configuration_sync", flags: [flag("hero", true)] });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true, "remote-copy": "treatment" });
    client.destroy();
  });

  it("takes a flag off the page once the data plane says it doesn't exist", async () => {
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { flagKey?: string; flagKeys?: string[] };
        // services/flaggr-api/handler/rest.go: 200, FLAG_NOT_FOUND and no value for a flag it doesn't have.
        const result = (flagKey: string) =>
          deleted || flagKey === "legacy-banner"
            ? { flagKey, value: null, reason: "FLAG_NOT_FOUND", errorCode: "FLAG_NOT_FOUND", evaluatedAt: "" }
            : { flagKey, value: flagKey === "promo" ? "spring" : "summer", reason: "STATIC", evaluatedAt: "" };
        if (String(url).endsWith("/batch")) {
          return json({ flags: Object.fromEntries(body.flagKeys!.map((key) => [key, result(key)])) });
        }
        return json(result(body.flagKey!));
      }),
    );
    // The default update mode: evaluations ask the data plane once the cache expires.
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web" });
    await expect(client.getStringValue("promo", "none")).resolves.toBe("spring");
    expect((await client.evaluateBatch([{ flagKey: "banner", defaultValue: "none" }])).get("banner")?.value).toBe("summer");
    await settle();
    // A key something else published, for a flag this client doesn't have: left alone.
    page.__FLAGGR_FLAGS__ = { ...page.__FLAGGR_FLAGS__, "legacy-banner": "on" };
    await expect(client.getStringValue("legacy-banner", "off")).resolves.toBe("off");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ promo: "spring", banner: "summer", "legacy-banner": "on" });

    deleted = true;
    await client.refresh();
    await expect(client.getStringValue("promo", "none")).resolves.toBe("none");
    expect((await client.evaluateBatch([{ flagKey: "banner", defaultValue: "none" }])).get("banner")?.value).toBe("none");
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({ "legacy-banner": "on" });
    client.destroy();
  });

  it("takes off a deleted flag it published before setContext", async () => {
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(deleted ? { reason: "FLAG_NOT_FOUND", errorCode: "FLAG_NOT_FOUND" } : { value: "spring", reason: "STATIC" }),
      ),
    );
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", context: { targetingKey: "anon-1" } });
    await expect(client.getStringValue("promo", "none")).resolves.toBe("spring");
    client.setContext({ targetingKey: "u2" }); // only the data plane can evaluate it: published until the next evaluation
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ promo: "spring" });

    deleted = true;
    await expect(client.getStringValue("promo", "none")).resolves.toBe("none");
    await settle();

    expect(page.__FLAGGR_FLAGS__).toEqual({});
    client.destroy();
  });

  it("leaves the value of a flag that changed without a configuration until the page evaluates it again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ value: "autumn", reason: "STATIC" })));
    const stream = streamStub();
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", updateMode: "stream" });
    stream.emit("configuration_sync", { type: "configuration_sync", flags: [flag("promo", "spring")] });
    client.evaluateSync("promo", "none");
    await settle();

    // The control plane's notice that the flag changed, without the flag: the page still shows "spring".
    stream.message({ type: "flag-update", flagKey: "promo", eventType: "UPDATED" });
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ promo: "spring" });

    await expect(client.getStringValue("promo", "none")).resolves.toBe("autumn");
    await settle();
    expect(page.__FLAGGR_FLAGS__).toEqual({ promo: "autumn" });
    client.destroy();
  });

  it("exposeFlags: false keeps values off the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ value: "treatment", reason: "STATIC" })));
    const client = new FlaggrClient({
      apiUrl: API,
      serviceId: "web",
      exposeFlags: false,
      bootstrap: { flags: [flag("hero", true)] },
    });

    client.getBooleanValueSync("hero", false);
    await client.getBooleanValue("hero", false);
    await client.getStringValue("remote-copy", "control");
    await settle();

    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    expect(events).toHaveLength(0);
    client.destroy();
  });

  it.each([
    ["published by default", undefined, { hero: true }],
    ['off with data-expose-flags="false"', "false", undefined],
  ])("script tag: %s", async (_name, attribute, expected) => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => json({ value: true, reason: "STATIC" })));
    const tag = document.createElement("script");
    tag.setAttribute("data-flaggr-sdk", "");
    tag.dataset.serviceId = "web";
    tag.dataset.apiUrl = API;
    if (attribute !== undefined) tag.dataset.exposeFlags = attribute;
    document.head.appendChild(tag);
    try {
      // The browser bundle's entry configures the global client from the tag.
      const sdk = await import("./browser");
      await expect(sdk.flag("hero")).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toEqual(expected);
      sdk.resetGlobalClient();
    } finally {
      tag.remove();
    }
  });

  describe('data-expose-flags="false" on any script tag', () => {
    type BrowserBundle = typeof import("./browser");
    let tags: HTMLScriptElement[] = [];
    let bundle: BrowserBundle | undefined;

    const addTag = (attributes: Record<string, string>) => {
      const tag = document.createElement("script");
      for (const [name, value] of Object.entries(attributes)) tag.setAttribute(name, value);
      document.head.appendChild(tag);
      tags.push(tag);
    };
    /** A script tag on the page, then the browser bundle's entry (`window.flaggr`). */
    const load = async (attributes: Record<string, string>): Promise<BrowserBundle> => {
      addTag(attributes);
      vi.resetModules();
      bundle = await import("./browser");
      return bundle;
    };

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => json({ value: true, reason: "STATIC" })));
    });

    afterEach(() => {
      bundle?.resetGlobalClient();
      bundle = undefined;
      for (const tag of tags) tag.remove();
      tags = [];
    });

    it("applies to configure() when the tag has no data-service-id", async () => {
      const flaggr = await load({ "data-expose-flags": "false" });
      flaggr.configure({ serviceId: "web", apiUrl: API });

      await expect(flaggr.flag("hero")).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    });

    it("still applies after configure() replaces the configuration the tag set", async () => {
      const flaggr = await load({
        "data-flaggr-sdk": "",
        "data-service-id": "web",
        "data-api-url": API,
        "data-expose-flags": "false",
      });
      flaggr.configure({ serviceId: "web", apiUrl: API, environment: "staging" });

      await expect(flaggr.flag("hero")).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    });

    it("applies to the client the SDK's tag configures when another tag carries it", async () => {
      addTag({ src: "/consent.js", "data-expose-flags": "false" });
      const flaggr = await load({ "data-flaggr-sdk": "", "data-service-id": "web", "data-api-url": API });

      await expect(flaggr.flag("hero")).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    });

    it("applies to createFlaggr() clients", async () => {
      const flaggr = await load({ "data-expose-flags": "false" });
      const client = flaggr.createFlaggr({ serviceId: "web", apiUrl: API });

      await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();
      client.destroy();
    });

    it("applies to clients from the npm package", async () => {
      addTag({ type: "module", src: "/app.js", "data-expose-flags": "false" });
      const client = new FlaggrClient({ serviceId: "web", apiUrl: API });

      await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();
      client.destroy();
    });

    it("still applies once a loader has removed the SDK's tag, before the first flaggr.flag()", async () => {
      const flaggr = await load({
        "data-flaggr-sdk": "",
        "data-service-id": "web",
        "data-api-url": API,
        "data-expose-flags": "false",
      });
      for (const tag of tags) tag.remove(); // after onload
      expect(document.querySelector("script[data-expose-flags]")).toBeNull();

      await expect(flaggr.flag("hero")).resolves.toBe(true);
      const later = flaggr.createFlaggr({ serviceId: "web", apiUrl: API });
      await expect(later.getBooleanValue("hero", false)).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();

      // Still overridden by an explicit exposeFlags: true.
      const explicit = flaggr.createFlaggr({ serviceId: "web", apiUrl: API, exposeFlags: true });
      await expect(explicit.getBooleanValue("hero", false)).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
      later.destroy();
      explicit.destroy();
    });

    it("still applies to configure() once an opt-out tag that was there at load is gone", async () => {
      const flaggr = await load({ src: "/consent.js", "data-expose-flags": "false" });
      for (const tag of tags) tag.remove(); // a single-page app swapping the head
      flaggr.configure({ serviceId: "web", apiUrl: API });

      await expect(flaggr.flag("hero")).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    });

    it("doesn't apply to an npm client created after the tag is gone: there's no bundle load to remember it", async () => {
      addTag({ type: "module", src: "/app.js", "data-expose-flags": "false" });
      const before = new FlaggrClient({ serviceId: "web", apiUrl: API });
      for (const tag of tags) tag.remove();
      const after = new FlaggrClient({ serviceId: "web", apiUrl: API });

      await expect(before.getBooleanValue("hero", false)).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toBeUndefined();
      await expect(after.getBooleanValue("hero", false)).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
      before.destroy();
      after.destroy();
    });

    it("gives way to an explicit exposeFlags: true", async () => {
      const flaggr = await load({ "data-expose-flags": "false" });
      const client = flaggr.createFlaggr({ serviceId: "web", apiUrl: API, exposeFlags: true });

      await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
      await settle();
      expect(page.__FLAGGR_FLAGS__).toEqual({ hero: true });
      client.destroy();
    });
  });
});

/** What these tests use of the analytics script's source (packages/analytics/src). */
interface AnalyticsScript {
  initFlagListener(): void;
  getFlags(): FlagMap | undefined;
  normalizeFlagAssignments(flags?: FlagMap): Array<{ flagKey: string; variant: string }>;
  computeFlagsetHash(flags?: FlagMap): string | undefined;
  initCollection(attrs: { trackClicks: boolean; trackErrors: boolean; trackScroll: boolean }): void;
  shouldCollect(type: "pageview" | "webvital" | "click" | "error" | "scroll" | "custom"): boolean;
  getCollectionLevel(): string;
}

/**
 * The analytics script's sources sit next to this package in Flaggr's main
 * repository. The public flaggr-js repository carries only the SDK and the
 * evaluator, so these tests are skipped there.
 */
const analyticsScriptSources = resolve(dirname(fileURLToPath(import.meta.url)), "../../analytics/src");

describe.skipIf(!existsSync(analyticsScriptSources))("with the analytics script's flag reader (packages/analytics)", () => {
  // A fresh copy of the script's modules per test: they keep module state.
  // Imported by path at runtime: a static import would pull the script's
  // sources into this package's TypeScript program (outside its rootDir).
  const loadAnalytics = async (): Promise<AnalyticsScript> => {
    vi.resetModules();
    const source = (file: string) => new URL(`../../analytics/src/${file}.ts`, import.meta.url).pathname;
    const flags = await import(/* @vite-ignore */ source("flags"));
    const collection = await import(/* @vite-ignore */ source("collection"));
    return { ...flags, ...collection };
  };

  it("sees the values the SDK publishes after the script started", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const analytics = await loadAnalytics();
    analytics.initFlagListener();
    expect(analytics.getFlags()).toBeUndefined();

    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: {
        flags: [flag("checkout-v2", true), flag("pricing", "annual-first"), flag("limits", { seats: 5 })],
      },
    });
    client.getBooleanValueSync("checkout-v2", false);
    client.evaluateSync("pricing", "monthly");
    await settle();

    expect(analytics.getFlags()).toEqual({ "checkout-v2": true, pricing: "annual-first" });
    expect(analytics.normalizeFlagAssignments(analytics.getFlags())).toEqual([
      { flagKey: "checkout-v2", variant: "true" },
      { flagKey: "pricing", variant: "annual-first" },
    ]);
    expect(analytics.computeFlagsetHash(analytics.getFlags())).toMatch(/^fs_/);

    // Later values reach the script's snapshot through flaggr:flags-changed.
    await client.getObjectValue("limits", {});
    await settle();
    expect(analytics.getFlags()).toEqual({ "checkout-v2": true, pricing: "annual-first", limits: { seats: 5 } });
    expect(analytics.normalizeFlagAssignments(analytics.getFlags())).toContainEqual({
      flagKey: "limits",
      variant: "{seats:5}",
    });
    client.destroy();
  });

  it("reads window.__FLAGGR_FLAGS__ when the SDK published before the script started", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", "b")] } });
    client.evaluateSync("hero", "a");
    await settle();

    const analytics = await loadAnalytics();
    analytics.initFlagListener();
    expect(analytics.getFlags()).toEqual({ hero: "b" });
    client.destroy();
  });

  it("stops sending a big server-rendered value once the SDK publishes, even when nothing else changed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    page.__FLAGGR_BOOTSTRAP__ = { hero: { value: true }, "legal-copy": { value: "y".repeat(4000) } };
    const analytics = await loadAnalytics();
    analytics.initFlagListener();
    expect(Object.keys(analytics.getFlags()!)).toEqual(["hero", "legal-copy"]); // read from the server-rendered values

    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("hero", true)] } });
    client.getBooleanValueSync("hero", false); // the value the server rendered
    await settle();

    expect(analytics.getFlags()).toEqual({ hero: true });
    client.destroy();
  });

  it("gets the SDK's values back after other code replaced the map", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const analytics = await loadAnalytics();
    analytics.initFlagListener();
    const client = new FlaggrClient({ serviceId: "web", bootstrap: { flags: [flag("checkout-v2", true)] } });
    client.getBooleanValueSync("checkout-v2", false);
    await settle();
    expect(analytics.getFlags()).toEqual({ "checkout-v2": true });

    // Glue written for SDK 0.4.0 replaces the map and announces it.
    page.__FLAGGR_FLAGS__ = { "legacy-banner": "on" };
    window.dispatchEvent(new CustomEvent("flaggr:flags-changed", { detail: page.__FLAGGR_FLAGS__ }));
    expect(analytics.getFlags()).toEqual({ "legacy-banner": "on" });

    // The next time the page reads the flag, the script sees it again.
    client.getBooleanValueSync("checkout-v2", false);
    await settle();
    expect(analytics.getFlags()).toEqual({ "legacy-banner": "on", "checkout-v2": true });
    client.destroy();
  });

  it("keeps the _flaggr_analytics level after other code replaces the map, once the page reads any flag", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const analytics = await loadAnalytics();
    analytics.initFlagListener();
    analytics.initCollection({ trackClicks: false, trackErrors: false, trackScroll: false });
    const client = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("_flaggr_analytics", "full"), flag("hero", true)] },
    });
    client.evaluateSync("_flaggr_analytics", "standard"); // read once, as the docs suggest
    client.getBooleanValueSync("hero", false);
    await settle();
    expect(analytics.getCollectionLevel()).toBe("full");

    // Glue written for SDK 0.4.0 replaces the map: the script falls back to its data-* settings.
    page.__FLAGGR_FLAGS__ = { "legacy-banner": "on" };
    window.dispatchEvent(new CustomEvent("flaggr:flags-changed", { detail: page.__FLAGGR_FLAGS__ }));
    expect(analytics.getCollectionLevel()).toBe("data-attrs");

    client.getBooleanValueSync("hero", false);
    await settle();
    expect(analytics.getCollectionLevel()).toBe("full");
    expect(analytics.shouldCollect("scroll")).toBe(true);
    expect(analytics.getFlags()).toEqual({ "legacy-banner": "on", _flaggr_analytics: "full", hero: true });
    client.destroy();
  });

  it("tags events with an object flag's variant name, and without the values kept off the page", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const analytics = await loadAnalytics();
    analytics.initFlagListener();
    const client = new FlaggrClient({
      serviceId: "web",
      context: { targetingKey: "u1" },
      bootstrap: {
        flags: [
          flag("layout", { columns: 1 }, variant("three-col", { columns: 3 })),
          flag("legal-text", { copy: "x".repeat(2000) }),
          flag("pricing", "annual-first"),
        ],
      },
    });
    for (const key of ["layout", "legal-text", "pricing"]) client.evaluateSync(key, "");
    await settle();

    expect(analytics.normalizeFlagAssignments(analytics.getFlags())).toEqual([
      { flagKey: "layout", variant: "three-col" },
      { flagKey: "pricing", variant: "annual-first" },
    ]);
    client.destroy();
  });

  it("lets the _flaggr_analytics flag set what the script collects", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const analytics = await loadAnalytics();
    analytics.initFlagListener();
    analytics.initCollection({ trackClicks: false, trackErrors: false, trackScroll: false });
    expect(analytics.shouldCollect("scroll")).toBe(false);

    // A level string.
    const levels = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("_flaggr_analytics", "full")] },
    });
    levels.evaluateSync("_flaggr_analytics", "off");
    await settle();
    expect(analytics.getCollectionLevel()).toBe("full");
    expect(analytics.shouldCollect("scroll")).toBe(true);

    // A config object stays an object on the page, not a serialized string.
    const config = new FlaggrClient({
      serviceId: "web",
      bootstrap: { flags: [flag("_flaggr_analytics", { clicks: true, errors: true, sampling: 1 })] },
    });
    config.evaluateSync("_flaggr_analytics", {});
    await settle();
    expect(analytics.getCollectionLevel()).toBe("detailed");
    expect(analytics.shouldCollect("click")).toBe(true);
    expect(analytics.shouldCollect("scroll")).toBe(false);
    levels.destroy();
    config.destroy();
  });
});

describe("exposeFlags and refresh()", () => {
  it("doesn't publish a flag the page evaluated only for someone else: a refresh doesn't evaluate it for the page's user", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { context: { targetingKey?: string }; flags?: Array<{ key: string }> };
      const value = body.context.targetingKey === "admin" ? "admin-copy" : "customer-copy";
      if (String(url).endsWith("/batch")) return json({ flags: body.flags!.map(({ key }) => ({ key, value, reason: "STATIC" })) });
      return json({ value, reason: "STATIC" });
    });
    vi.stubGlobal("fetch", fetchMock);
    // An admin's page previewing a flag for a customer.
    const client = new FlaggrClient({ apiUrl: API, serviceId: "web", context: { targetingKey: "admin" } });
    await expect(client.getStringValue("copy", "none", { targetingKey: "customer-42" })).resolves.toBe("customer-copy");

    await client.refresh();
    await settle();

    expect(page.__FLAGGR_FLAGS__).toBeUndefined();
    expect(events).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.destroy();
  });
});
