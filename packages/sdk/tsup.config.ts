import { defineConfig } from "tsup";

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
