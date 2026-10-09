import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Vitest runs the tests without checking their types, so the type-level
 * tests (a public type taking what it should: getObjectValue's interfaces,
 * EvaluationResult's reasons, a 0.4.0-style FlaggrClientInstance) would pass
 * on broken types. This runs the package's type check, tests included.
 */
const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the package's types", () => {
  it("type-check: tsc --noEmit over the sources and tests finds no error", () => {
    const tsc = createRequire(path.join(SDK_DIR, "package.json")).resolve("typescript/bin/tsc");
    let output = "";
    try {
      execFileSync(process.execPath, [tsc, "--noEmit", "-p", path.join(SDK_DIR, "tsconfig.json")], {
        cwd: SDK_DIR,
        stdio: "pipe",
      });
    } catch (error) {
      const { stdout, stderr, message } = error as { stdout?: Buffer; stderr?: Buffer; message: string };
      output = `${stdout ?? ""}${stderr ?? ""}` || message;
    }
    expect(output).toBe("");
  }, 120_000);
});
