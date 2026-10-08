// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser bundle's entry configures the global client from its script
 * tag's data attributes. Only attributes on the tag may reach the config: an
 * explicit `undefined` overrides the client's default for that field.
 */

type BrowserBundle = typeof import("./browser");

const DEFAULT_API_URL = "https://api.flaggr.dev";

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** A fetch mock that answers every evaluation request with `true`. */
const evaluationFetch = () =>
  vi.fn(async (_url: string, _init: RequestInit) => json({ value: true, reason: "STATIC" }));

describe("browser bundle: script-tag configuration", () => {
  let fetchMock: ReturnType<typeof evaluationFetch>;
  let tags: HTMLScriptElement[] = [];
  let bundle: BrowserBundle | undefined;

  /** The SDK's script tag on the page, then the bundle's entry (`window.flaggr`). */
  const load = async (attributes: Record<string, string>): Promise<BrowserBundle> => {
    const tag = document.createElement("script");
    for (const [name, value] of Object.entries(attributes)) tag.setAttribute(name, value);
    document.head.appendChild(tag);
    tags.push(tag);
    vi.resetModules();
    bundle = await import("./browser");
    return bundle;
  };

  /** The single evaluation request: its URL, headers and JSON body. */
  const request = () => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    return {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
  };

  beforeEach(() => {
    fetchMock = evaluationFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    bundle?.resetGlobalClient();
    bundle = undefined;
    for (const tag of tags) tag.remove();
    tags = [];
    vi.unstubAllGlobals();
  });

  it("evaluates against the default API URL when the tag has no data-api-url", async () => {
    const flaggr = await load({ "data-flaggr-sdk": "", "data-service-id": "web", "data-api-key": "fgr_read" });

    await expect(flaggr.flag("hero")).resolves.toBe(true);

    const { url, headers, body } = request();
    expect(url).toBe(`${DEFAULT_API_URL}/api/flags/evaluate`);
    expect(headers.Authorization).toBe("Bearer fgr_read");
    expect(body).toMatchObject({ flagKey: "hero", serviceId: "web" });
  });

  it("treats an empty data-api-url like a missing one", async () => {
    const flaggr = await load({ "data-flaggr-sdk": "", "data-service-id": "web", "data-api-url": "" });

    await expect(flaggr.flag("hero")).resolves.toBe(true);

    expect(request().url).toBe(`${DEFAULT_API_URL}/api/flags/evaluate`);
  });

  it("uses data-api-url, data-api-key and data-environment when the tag has them", async () => {
    const flaggr = await load({
      "data-flaggr-sdk": "",
      "data-service-id": "web",
      "data-api-key": "fgr_read",
      "data-api-url": "https://flags.example.com",
      "data-environment": "staging",
    });

    await expect(flaggr.flag("hero")).resolves.toBe(true);

    const { url, headers, body } = request();
    expect(url).toBe("https://flags.example.com/api/flags/evaluate");
    expect(headers.Authorization).toBe("Bearer fgr_read");
    expect(body).toMatchObject({ flagKey: "hero", serviceId: "web", environment: "staging" });
  });

  it("sends no key and no environment when the tag has neither", async () => {
    const flaggr = await load({ "data-flaggr-sdk": "", "data-service-id": "web" });

    await expect(flaggr.flag("hero")).resolves.toBe(true);

    const { url, headers, body } = request();
    expect(url).toBe(`${DEFAULT_API_URL}/api/flags/evaluate`);
    expect(headers).not.toHaveProperty("Authorization");
    expect(body).not.toHaveProperty("environment");
  });
});
