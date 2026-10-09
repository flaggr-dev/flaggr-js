import { afterEach, describe, expect, it, vi } from "vitest";
import { appBaseUrl } from "./app-url";
import { FlaggrClient } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("appBaseUrl", () => {
  it.each([
    [undefined, "https://flaggr.dev"],
    ["https://api.flaggr.dev", "https://flaggr.dev"],
    ["https://api.flaggr.dev/", "https://flaggr.dev"],
    ["https://API.flaggr.dev:8443", "https://flaggr.dev"],
    ["https://flaggr.dev", "https://flaggr.dev"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["https://flags.example.com", "https://flags.example.com"],
    ["", ""],
    ["/", ""],
  ])("apiUrl %s: the app is at %s", (apiUrl, expected) => {
    expect(appBaseUrl(apiUrl)).toBe(expected);
  });
});

/**
 * GET /api/sdk-config is the Flaggr app's route. The hosted data plane
 * (https://api.flaggr.dev, the client's default apiUrl) answers it with a
 * 404, which loadRemoteConfig ignores, so remote config never applied.
 */
describe("remoteConfig", () => {
  const configRequests = (apiUrl?: string) => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlaggrClient({
      ...(apiUrl === undefined ? {} : { apiUrl }),
      serviceId: "web-app",
      apiKey: "fgr_test",
      remoteConfig: true,
      updateMode: "poll",
    });
    client.destroy();
    return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/api/sdk-config"));
  };

  it("fetches the hosted data plane's config from the Flaggr app", () => {
    const [url] = configRequests();
    expect(url).toMatch(/^https:\/\/flaggr\.dev\/api\/sdk-config\?/);
    expect(new URL(url).searchParams.get("serviceId")).toBe("web-app");
  });

  it("fetches it at any other apiUrl", () => {
    expect(configRequests("https://flags.example.com")[0]).toMatch(/^https:\/\/flags\.example\.com\/api\/sdk-config\?/);
  });
});
