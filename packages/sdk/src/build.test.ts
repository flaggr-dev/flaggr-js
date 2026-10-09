import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The package as tsup.config.ts builds it (into a temporary directory, without
 * the type declarations, which the checks here don't need).
 */
const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let outDir = "";

beforeAll(() => {
  outDir = mkdtempSync(path.join(tmpdir(), "flaggr-sdk-build-"));
  execFileSync(
    process.execPath,
    [
      "-e",
      "require('tsup').build({ outDir: process.argv[1], dts: false, silent: true })" +
        ".catch((error) => { console.error(error); process.exit(1); })",
      outDir,
    ],
    { cwd: SDK_DIR, stdio: "pipe" }
  );
}, 120_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const built = (file: string) => readFileSync(path.join(outDir, file), "utf8");

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The original line (0-based) the first segment of generated line `line` maps to, or null. */
function originalLine(mappings: string, line: number): number | null {
  // Decode every segment up to `line`: fields are deltas across the whole map.
  let sourceLine = 0;
  const lines = mappings.split(";");
  for (let l = 0; l <= line && l < lines.length; l++) {
    let first: number | null = null;
    for (const segment of lines[l].split(",").filter(Boolean)) {
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = BASE64.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      if (fields.length >= 4) {
        sourceLine += fields[2];
        first ??= sourceLine;
      }
    }
    if (l === line) return first;
  }
  return null;
}

describe("the built package", () => {
  it.each(["react.mjs", "react.js"])("%s starts with the \"use client\" directive", (file) => {
    // A Server Component can import FlaggrProvider and the hooks: the entry is a client boundary.
    expect(built(file).startsWith('"use client";\n')).toBe(true);
  });

  it("marks only the React entry: the core entries and shared chunks stay server-usable", () => {
    const others = readdirSync(outDir).filter(
      (file) => /\.(m?js)$/.test(file) && file !== "react.mjs" && file !== "react.js"
    );
    expect(others).toEqual(expect.arrayContaining(["index.mjs", "index.js", "otel.mjs", "otel.js", "browser.global.js"]));
    for (const file of others) expect([file, built(file).includes("use client")]).toEqual([file, false]);
  });

  it.each(["react.mjs", "react.js"])("%s's source map still lines up after the directive", (file) => {
    const code = built(file).split("\n");
    const map = JSON.parse(built(`${file}.map`)) as { sources: string[]; mappings: string };
    expect(originalLine(map.mappings, 0)).toBeNull(); // the directive: no source
    const source = readFileSync(path.join(SDK_DIR, "src/react.tsx"), "utf8").split("\n");
    // Every top-level function, and the context, maps to its declaration in react.tsx.
    const probes = code.flatMap((line, index) => {
      const declared = /^function (\w+)\(/.exec(line) ?? /^var (FlaggrContext) = /.exec(line);
      return declared ? [{ index, name: declared[1] }] : [];
    });
    expect(probes.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["FlaggrContext", "FlaggrProvider", "useFlaggr", "useFlag", "useBooleanFlag", "useRefreshFlags"])
    );
    for (const { index, name } of probes) {
      const line = originalLine(map.mappings, index);
      expect([name, line === null ? null : source[line]]).toEqual([
        name,
        expect.stringMatching(new RegExp(`^(export )?(function|const) ${name}\\b`)),
      ]);
    }
  });
});
