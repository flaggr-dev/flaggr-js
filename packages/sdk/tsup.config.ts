import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Options } from "tsup";

type TsupPlugin = NonNullable<Options["plugins"]>[number];

/**
 * Put `"use client";` at the top of the built React entry (react.mjs and
 * react.js), so a Server Component can import FlaggrProvider and the hooks:
 * the directive makes the module a Client Component boundary. Only that
 * entry: `@flaggr/sdk` itself (flag(), createFlaggr) stays usable on the
 * server, and the chunks the entries share stay plain modules.
 *
 * Done once the files are written: tsup's banner applies to every file of a
 * build, and its treeshake pass (Rollup) drops module-level directives from
 * the source. The line it adds maps to nothing in the source map: a ";"
 * opens the map's mappings, so every other line keeps its mapping.
 */
function clientDirectivePlugin(entry: string): TsupPlugin {
  const files = new Set([`${entry}.mjs`, `${entry}.js`]);
  return {
    name: "use-client-directive",
    async buildEnd({ writtenFiles }) {
      for (const { name } of writtenFiles) {
        if (!files.has(path.basename(name))) continue;
        const file = path.resolve(name);
        const code = await readFile(file, "utf8");
        if (code.startsWith('"use client";')) continue;
        await writeFile(file, `"use client";\n${code}`);
        try {
          const map = JSON.parse(await readFile(`${file}.map`, "utf8")) as { mappings: string };
          map.mappings = `;${map.mappings}`;
          await writeFile(`${file}.map`, JSON.stringify(map));
        } catch {
          /* no source map for this file */
        }
      }
    },
  };
}

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      react: "src/react.tsx",
      otel: "src/otel.ts",
    },
    format: ["cjs", "esm"],
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ["react", "@opentelemetry/api"],
    plugins: [clientDirectivePlugin("react")],
  },
  {
    // Browser bundle — served via CDN (jsDelivr/unpkg) as a plain <script>
    // tag that registers `window.flaggr`.
    entry: { browser: "src/browser.ts" },
    format: ["iife"],
    globalName: "flaggr",
    dts: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: true,
    external: ["react", "@opentelemetry/api"],
    outExtension: () => ({ js: ".global.js" }),
    esbuildOptions(options) {
      options.target = "es2020";
    },
  },
]);
