/**
 * Global singleton client for the `flag()` one-liner
 *
 * Lazy-initialized on first call. Reads config from:
 *   1. Explicit `configure()` call
 *   2. Environment variables via `readEnvConfig()`
 */

import { FlaggrClient } from "./client";
import { readEnvConfig } from "./env";
import type { FlaggrConfig, FlaggrClientInstance } from "./types";

let globalClient: FlaggrClientInstance | null = null;
let explicitConfig: FlaggrConfig | null = null;

/**
 * Pre-configure the global Flaggr client.
 *
 * Call this early in your app (e.g. instrumentation.ts) to set
 * API key, service ID, etc. without relying on env vars.
 *
 * If not called, `flag()` will auto-detect from environment variables.
 */
export function configure(config: FlaggrConfig): void {
  explicitConfig = config;
  // Reset so the next `getGlobalClient()` picks up the new config
  if (globalClient) {
    globalClient.destroy();
    globalClient = null;
  }
}

/**
 * Get (or lazily create) the global Flaggr client singleton.
 */
export function getGlobalClient(): FlaggrClientInstance {
  if (globalClient) return globalClient;

  const config = explicitConfig ?? resolveConfig();
  globalClient = new FlaggrClient(config);
  return globalClient;
}

/**
 * Destroy the global client and reset state.
 * Primarily useful for testing.
 */
export function resetGlobalClient(): void {
  globalClient?.destroy();
  globalClient = null;
  explicitConfig = null;
}

function resolveConfig(): FlaggrConfig {
  const envConfig = readEnvConfig();

  if (!envConfig.serviceId) {
    throw new Error(
      "Flaggr: No serviceId found. Either call configure({ serviceId: '...' }) " +
        "or set the FLAGGR_SERVICE_ID (server) / NEXT_PUBLIC_FLAGGR_SERVICE_ID (client) environment variable."
    );
  }

  return envConfig as FlaggrConfig;
}
