import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnvConfig } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * env.ts bundled for a browser the way Next.js builds a client bundle: the
 * NEXT_PUBLIC_* values set at build time replace their literal
 * `process.env.NEXT_PUBLIC_…` expressions (DefinePlugin; esbuild's `define`
 * here), and anything else is left as written. Then run where a browser
 * runs it, with no `process` global.
 */
async function readEnvConfigInBrowser(inlined: Record<string, string>): Promise<ReturnType<typeof readEnvConfig>> {
  const define = Object.fromEntries(
    Object.entries(inlined).map(([name, value]) => [`process.env.${name}`, JSON.stringify(value)])
  );
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./env.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "flaggrEnv",
    platform: "browser",
    define,
    logLevel: "silent",
  });
  const sandbox: { flaggrEnv?: { readEnvConfig: typeof readEnvConfig } } = {};
  vm.runInNewContext(`${result.outputFiles[0].text}\nthis.flaggrEnv = flaggrEnv;`, sandbox);
  expect("process" in sandbox).toBe(false);
  return sandbox.flaggrEnv!.readEnvConfig();
}

describe("readEnvConfig in a browser bundle", () => {
  it("reads the NEXT_PUBLIC_* values the bundler inlined", async () => {
    await expect(
      readEnvConfigInBrowser({
        NEXT_PUBLIC_FLAGGR_SERVICE_ID: " web-app\n",
        NEXT_PUBLIC_FLAGGR_API_KEY: "fgr_public",
        NEXT_PUBLIC_FLAGGR_ENVIRONMENT: "staging",
        NEXT_PUBLIC_FLAGGR_API_URL: "https://flaggr.dev",
      })
    ).resolves.toEqual({
      serviceId: "web-app",
      apiKey: "fgr_public",
      environment: "staging",
      apiUrl: "https://flaggr.dev",
    });
  });

  it("reads each one on its own: an unset one doesn't hide the others", async () => {
    // Only the service id was set at build time: the other three stay
    // `process.env.…` expressions, which throw without a `process`.
    await expect(readEnvConfigInBrowser({ NEXT_PUBLIC_FLAGGR_SERVICE_ID: "web-app" })).resolves.toEqual({
      serviceId: "web-app",
    });
  });

  it("is empty when nothing was inlined", async () => {
    await expect(readEnvConfigInBrowser({})).resolves.toEqual({});
  });
});

describe("readEnvConfig on a server", () => {
  it("prefers the server-side names, falls back to NEXT_PUBLIC_*, and trims", () => {
    vi.stubEnv("FLAGGR_SERVICE_ID", " api \n");
    vi.stubEnv("NEXT_PUBLIC_FLAGGR_SERVICE_ID", "web-app");
    vi.stubEnv("FLAGGR_API_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_FLAGGR_API_KEY", "fgr_public ");
    vi.stubEnv("FLAGGR_ENVIRONMENT", "   ");
    vi.stubEnv("NEXT_PUBLIC_FLAGGR_ENVIRONMENT", "");
    vi.stubEnv("FLAGGR_API_URL", "https://flaggr.dev");
    vi.stubEnv("NEXT_PUBLIC_FLAGGR_API_URL", "https://example.test");

    expect(readEnvConfig()).toEqual({ serviceId: "api", apiKey: "fgr_public", apiUrl: "https://flaggr.dev" });
  });
});
