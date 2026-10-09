import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlaggrProvider, useBooleanFlag } from "./react";
import type { FlaggrConfig, FlaggrPlugin } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Hero() {
  return <p>{useBooleanFlag("hero", false) ? "on" : "off"}</p>;
}

describe("FlaggrProvider in a server render", () => {
  it.each(["stream", "batch"] as const)(
    "renders %s mode from the bootstrap without starting the client: no request, timer or plugin",
    async (updateMode) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      const plugin: FlaggrPlugin = { name: "probe", onInit: vi.fn() };
      const config: FlaggrConfig = {
        apiUrl: "https://flaggr.test",
        serviceId: "web",
        apiKey: "fgr_key",
        updateMode,
        remoteConfig: true,
        plugins: [plugin],
        bootstrap: { flags: [{ key: "hero", type: "boolean", enabled: true, defaultValue: true }] },
      };

      // A server render never commits, so no effect runs: nothing would
      // ever stop a client started here.
      const html = renderToString(
        <FlaggrProvider config={config}>
          <Hero />
        </FlaggrProvider>
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(html).toBe("<p>on</p>");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(plugin.onInit).not.toHaveBeenCalled();
    }
  );
});
