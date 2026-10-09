/**
 * Runtime-safe environment variable reader for Flaggr SDK
 *
 * Reads from:
 * - process.env (Node.js / Edge)
 * - NEXT_PUBLIC_* (Next.js browser bundles)
 *
 * Always trims values to avoid whitespace issues.
 *
 * Every variable is read with a literal `process.env.NAME` expression, never
 * `process.env[name]`: bundlers (Next.js, webpack's DefinePlugin, esbuild's
 * and Vite's `define`) replace only the literal expressions with their
 * values, so in a browser bundle a dynamic lookup finds nothing — Next.js
 * leaves the browser no process.env of NEXT_PUBLIC_* values to read.
 */

import type { FlaggrConfig } from "./types";

type EnvValues = Partial<Record<"apiKey" | "serviceId" | "environment" | "apiUrl", string | undefined>>;

/** The server-side names: never inlined into browser bundles. */
function serverEnv(): EnvValues {
  if (typeof process === "undefined" || !process.env) return {};
  return {
    apiKey: process.env.FLAGGR_API_KEY,
    serviceId: process.env.FLAGGR_SERVICE_ID,
    environment: process.env.FLAGGR_ENVIRONMENT,
    apiUrl: process.env.FLAGGR_API_URL,
  };
}

/**
 * One NEXT_PUBLIC_* value. A bundler that inlined it left no `process`
 * reference in `read`, so this works in a browser, which has no `process`.
 * One it didn't inline (unset at build time) throws there, and is unset:
 * each is read on its own, so that doesn't lose the others.
 */
function publicValue(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The NEXT_PUBLIC_* names: inlined into browser bundles by Next.js. */
function publicEnv(): EnvValues {
  return {
    apiKey: publicValue(() => process.env.NEXT_PUBLIC_FLAGGR_API_KEY),
    serviceId: publicValue(() => process.env.NEXT_PUBLIC_FLAGGR_SERVICE_ID),
    environment: publicValue(() => process.env.NEXT_PUBLIC_FLAGGR_ENVIRONMENT),
    apiUrl: publicValue(() => process.env.NEXT_PUBLIC_FLAGGR_API_URL),
  };
}

/** A set, non-blank value, trimmed. */
function clean(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
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
 *
 * Where both are set, the server-side name wins.
 */
export function readEnvConfig(): Partial<FlaggrConfig> {
  const server = serverEnv();
  const pub = publicEnv();
  const apiKey = clean(server.apiKey) ?? clean(pub.apiKey);
  const serviceId = clean(server.serviceId) ?? clean(pub.serviceId);
  const environment = clean(server.environment) ?? clean(pub.environment);
  const apiUrl = clean(server.apiUrl) ?? clean(pub.apiUrl);

  const config: Partial<FlaggrConfig> = {};
  if (apiKey) config.apiKey = apiKey;
  if (serviceId) config.serviceId = serviceId;
  if (environment) config.environment = environment;
  if (apiUrl) config.apiUrl = apiUrl;

  return config;
}
