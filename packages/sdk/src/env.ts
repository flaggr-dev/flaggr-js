/**
 * Runtime-safe environment variable reader for Flaggr SDK
 *
 * Reads from:
 * - process.env (Node.js / Edge)
 * - NEXT_PUBLIC_* (Next.js browser bundles)
 *
 * Always trims values to avoid whitespace issues.
 */

import type { FlaggrConfig } from "./types";

function readEnv(key: string): string | undefined {
  // Node.js / Edge / Next.js server
  if (typeof process !== "undefined" && process.env) {
    const val = process.env[key];
    if (val) return val.trim();
  }
  return undefined;
}

/**
 * Read Flaggr configuration from environment variables.
 *
 * Server-side:
 *   FLAGGR_API_KEY, FLAGGR_SERVICE_ID, FLAGGR_ENVIRONMENT, FLAGGR_API_URL
 *
 * Client-side (Next.js):
 *   NEXT_PUBLIC_FLAGGR_API_KEY, NEXT_PUBLIC_FLAGGR_SERVICE_ID,
 *   NEXT_PUBLIC_FLAGGR_ENVIRONMENT, NEXT_PUBLIC_FLAGGR_API_URL
 */
export function readEnvConfig(): Partial<FlaggrConfig> {
  const apiKey =
    readEnv("FLAGGR_API_KEY") ?? readEnv("NEXT_PUBLIC_FLAGGR_API_KEY");
  const serviceId =
    readEnv("FLAGGR_SERVICE_ID") ?? readEnv("NEXT_PUBLIC_FLAGGR_SERVICE_ID");
  const environment =
    readEnv("FLAGGR_ENVIRONMENT") ?? readEnv("NEXT_PUBLIC_FLAGGR_ENVIRONMENT");
  const apiUrl =
    readEnv("FLAGGR_API_URL") ?? readEnv("NEXT_PUBLIC_FLAGGR_API_URL");

  const config: Partial<FlaggrConfig> = {};
  if (apiKey) config.apiKey = apiKey;
  if (serviceId) config.serviceId = serviceId;
  if (environment) config.environment = environment;
  if (apiUrl) config.apiUrl = apiUrl;

  return config;
}
