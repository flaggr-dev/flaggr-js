import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlaggrPlugin } from "./types";

afterEach(() => {
  vi.doUnmock("./telemetry");
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("the telemetry plugin a remote config turns on", () => {
  it("isn't added when its module arrives after destroy()", async () => {
    // The plugin's module, held until the test lets it load.
    let load!: () => void;
    const loaded = new Promise<void>((resolve) => (load = resolve));
    const plugin: FlaggrPlugin = { name: "flaggr-telemetry", onInit: vi.fn() };
    const factory = vi.fn(async () => {
      await loaded;
      return { flaggrTelemetry: () => plugin };
    });
    vi.doMock("./telemetry", factory);
    const { FlaggrClient } = await import("./client");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ sdk: { telemetry: true } }))
    );

    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web", remoteConfig: true });
    // The remote config is applied: the plugin's module is on its way.
    await vi.waitFor(() => expect(factory).toHaveBeenCalled());
    client.destroy();
    load();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(plugin.onInit).not.toHaveBeenCalled();
  });

  it("is added and initialised when its module arrives first", async () => {
    const plugin: FlaggrPlugin = { name: "flaggr-telemetry", onInit: vi.fn(), onDestroy: vi.fn() };
    vi.doMock("./telemetry", async () => ({ flaggrTelemetry: () => plugin }));
    const { FlaggrClient } = await import("./client");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ sdk: { telemetry: true } })));

    const client = new FlaggrClient({ apiUrl: "https://flaggr.test", apiKey: "fgr_key", serviceId: "web", remoteConfig: true });
    await vi.waitFor(() => expect(plugin.onInit).toHaveBeenCalledWith(client));
    client.destroy();
    expect(plugin.onDestroy).toHaveBeenCalledTimes(1);
  });
});
