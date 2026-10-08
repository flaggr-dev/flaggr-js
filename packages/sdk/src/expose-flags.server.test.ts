// @vitest-environment node

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlaggrClient } from "./client";

const bootstrap = { flags: [{ key: "hero", type: "boolean", enabled: true, defaultValue: true }] };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const remote = () =>
  vi.fn(async () => ({ ok: true, json: async () => ({ value: "b", reason: "STATIC" }) }));
const globals = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete globals.__FLAGGR_FLAGS__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exposeFlags outside a browser page", () => {
  it.each([undefined, true])("is a no-op on the server (exposeFlags: %s)", async (exposeFlags) => {
    expect(typeof window).toBe("undefined");
    vi.stubGlobal("fetch", remote());
    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", exposeFlags, bootstrap });

    // Any publish would be queued synchronously, during the evaluation.
    const queued = vi.spyOn(globalThis, "queueMicrotask");
    expect(client.getBooleanValueSync("hero", false)).toBe(true);
    expect(queued).not.toHaveBeenCalled();
    queued.mockRestore();

    await expect(client.getBooleanValue("hero", false)).resolves.toBe(true);
    await expect(client.getStringValue("remote", "a")).resolves.toBe("b");
    await settle();
    expect("__FLAGGR_FLAGS__" in globalThis).toBe(false);
    client.destroy();
  });

  it("is a no-op where window is the global object but there's no document (Deno 1.x)", async () => {
    vi.stubGlobal("window", globalThis);
    const dispatchEvent = vi.fn();
    vi.stubGlobal("dispatchEvent", dispatchEvent);
    const client = new FlaggrClient({ serviceId: "web", bootstrap });

    expect(client.getBooleanValueSync("hero", false)).toBe(true);
    await settle();

    expect("__FLAGGR_FLAGS__" in globalThis).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
    client.destroy();
  });

  it.each([
    ["without querySelector", { cookie: "" }],
    [
      "whose querySelector throws",
      {
        querySelector() {
          throw new Error("Not implemented");
        },
      },
    ],
  ])("creates clients and publishes nothing where window is the global object and document is a stub %s", async (_name, stub) => {
    // Hand-rolled browser globals, as some Node test setups and polyfills leave them.
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", stub);
    vi.stubGlobal("dispatchEvent", vi.fn());
    vi.stubGlobal("fetch", remote());

    for (const exposeFlags of [undefined, true, false]) {
      const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", exposeFlags, bootstrap });
      expect(client.getBooleanValueSync("hero", false)).toBe(true);
      await expect(client.getStringValue("remote", "a")).resolves.toBe("b");
      client.destroy();
    }
    await settle();

    expect("__FLAGGR_FLAGS__" in globalThis).toBe(false);
    expect(globals.dispatchEvent).not.toHaveBeenCalled();
  });

  it("is a no-op on a server that hangs a DOM shim's window on its global (domino, global-jsdom)", async () => {
    // What `global.window = win; global.document = win.document` leaves behind.
    const { window: shim } = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", shim);
    vi.stubGlobal("document", shim.document);
    const dispatched = vi.fn();
    shim.addEventListener("flaggr:flags-changed", dispatched);
    vi.stubGlobal("fetch", remote());

    // Per-request clients, one user after another, as the server renders pages.
    for (const user of ["alice", "bob"]) {
      const client = new FlaggrClient({
        apiUrl: "https://flaggr.test",
        serviceId: "web",
        context: { targetingKey: user },
        exposeFlags: true,
        bootstrap,
      });
      expect(client.getBooleanValueSync("hero", false)).toBe(true);
      await expect(client.getStringValue("remote", "a")).resolves.toBe("b");
      client.destroy();
    }
    await settle();

    expect((shim as unknown as Record<string, unknown>).__FLAGGR_FLAGS__).toBeUndefined();
    expect(dispatched).not.toHaveBeenCalled();
    shim.close();
  });

  describe("where window is the global object and there's a document", () => {
    // happy-dom's GlobalRegistrator.register() copies its window onto the
    // global object and swaps every reference to that window for globalThis,
    // so window === globalThis there, as in a page and in jsdom test
    // environments. It also adds `happyDOM`.
    const install = () => {
      const { window: dom } = new JSDOM("<!doctype html><html><body></body></html>");
      vi.stubGlobal("window", globalThis);
      vi.stubGlobal("document", dom.document);
      const dispatchEvent = vi.fn();
      vi.stubGlobal("dispatchEvent", dispatchEvent);
      return { dom, dispatchEvent };
    };

    it("publishes: that's a page (or a jsdom test environment)", async () => {
      const { dom, dispatchEvent } = install();
      const client = new FlaggrClient({ serviceId: "web", bootstrap });

      expect(client.getBooleanValueSync("hero", false)).toBe(true);
      await settle();

      expect(globals.__FLAGGR_FLAGS__).toEqual({ hero: true });
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      client.destroy();
      dom.close();
    });

    it("is a no-op under happy-dom's global registrator, even with exposeFlags: true", async () => {
      const { dom, dispatchEvent } = install();
      vi.stubGlobal("happyDOM", {});
      vi.stubGlobal("fetch", remote());
      const client = new FlaggrClient({ apiUrl: "https://flaggr.test", serviceId: "web", exposeFlags: true, bootstrap });

      expect(client.getBooleanValueSync("hero", false)).toBe(true);
      await expect(client.getStringValue("remote", "a")).resolves.toBe("b");
      await settle();

      expect("__FLAGGR_FLAGS__" in globalThis).toBe(false);
      expect(dispatchEvent).not.toHaveBeenCalled();
      client.destroy();
      dom.close();
    });
  });
});
