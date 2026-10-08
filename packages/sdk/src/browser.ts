/**
 * Browser bundle entry — IIFE build registers `window.flaggr`.
 *
 * <script src="https://cdn.jsdelivr.net/npm/@flaggr/sdk@0/dist/browser.global.js"></script>
 * <script>
 *   flaggr.configure({ serviceId: "web-app", apiKey: "fgr_..." });
 *   const enabled = await flaggr.flag("checkout-v2", false);
 * </script>
 */

import { configure, flaggrTelemetry } from "./index";
import { recordOptOut } from "./expose-flags";
import type { FlaggrConfig, UpdateMode } from "./types";

// Minimal surface for script-tag consumers — SmartCache/otel/react stay
// out of the IIFE via treeshake (the npm ESM entry keeps them).
export {
  createFlaggr,
  configure,
  resetGlobalClient,
  flag,
  flaggrTelemetry,
} from "./index";

/**
 * One-line integration: read config from the script tag's data attributes so
 * this is the entire setup:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@flaggr/sdk@0/dist/browser.global.js"
 *           data-service-id="web-app" data-api-key="fgr_..." defer></script>
 *   <script>await flaggr.flag("checkout-v2", false)</script>
 *
 * Optional: data-api-url (default https://api.flaggr.dev), data-environment,
 * data-update-mode, data-remote-config, data-telemetry.
 */
if (typeof document !== "undefined") {
  // data-expose-flags="false" on any script tag now keeps flag values off
  // the page even once that tag is gone: the global client is only created
  // at the first flaggr.flag(), and a loader may remove this tag before then.
  recordOptOut();
  // currentScript is null for defer/async — fall back to a src lookup
  const tag =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[data-service-id][data-flaggr-sdk],script[src*="flaggr"][data-service-id],script[src*="browser.global"][data-service-id]') ??
    document.querySelector<HTMLScriptElement>('script[data-service-id]');
  if (tag?.dataset.serviceId) {
    // Only attributes the tag has, with a value, go into the config. The
    // client spreads the config over its defaults, so `apiUrl: undefined`
    // would replace https://api.flaggr.dev and send every evaluation to
    // "<page>/undefined/api/flags/evaluate".
    const config: FlaggrConfig = { serviceId: tag.dataset.serviceId };
    if (tag.dataset.apiKey) config.apiKey = tag.dataset.apiKey;
    if (tag.dataset.apiUrl) config.apiUrl = tag.dataset.apiUrl;
    if (tag.dataset.environment) config.environment = tag.dataset.environment;
    if (tag.dataset.updateMode) config.updateMode = tag.dataset.updateMode as UpdateMode;
    // data-remote-config → fetch service-level SDK config from Flaggr
    if (tag.dataset.remoteConfig !== undefined) config.remoteConfig = true;
    // data-telemetry → attach the telemetry plugin (eval stats + Web Vitals
    // + error correlation, beacon-flushed to the platform)
    if (tag.dataset.telemetry !== undefined) config.plugins = [flaggrTelemetry()];
    // data-expose-flags="false" (on this or any script tag) keeps flag
    // values off the page. It isn't passed here: every client reads it
    // from the page (and recordOptOut above), so it still applies after a
    // later configure() and to createFlaggr() clients (see shouldExpose in
    // expose-flags.ts).
    configure(config);
  }
}

export type {
  FlaggrConfig,
  FlaggrClientInstance,
  FlaggrPlugin,
  FlagValue,
  EvaluationContext,
  EvaluationResult,
  FlagChangeEvent,
  OutcomeEvent,
  UpdateMode,
  RequestInfo,
  SmartCacheConfig,
  CacheResult,
  CacheStats,
  CacheStatus,
} from "./index";
