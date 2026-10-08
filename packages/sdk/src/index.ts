/**
 * flaggr - Feature flag SDK for TypeScript
 *
 * @example Zero-config one-liner
 * ```typescript
 * import { flag } from '@flaggr/sdk'
 *
 * if (await flag('dark-mode')) {
 *   enableDarkMode()
 * }
 * ```
 *
 * @example Explicit client
 * ```typescript
 * import { createFlaggr } from '@flaggr/sdk'
 *
 * const client = createFlaggr({
 *   serviceId: 'web-app',
 *   apiKey: 'flg_xxx',
 * })
 *
 * const isEnabled = await client.getBooleanValue('my-feature', false)
 * ```
 *
 * @example With OpenTelemetry
 * ```typescript
 * import { createFlaggr } from '@flaggr/sdk'
 * import { otelPlugin } from '@flaggr/sdk/otel'
 *
 * const client = createFlaggr({
 *   serviceId: 'web-app',
 *   apiKey: 'flg_xxx',
 *   plugins: [otelPlugin({ serviceName: 'checkout' })],
 * })
 * ```
 *
 * @example With React
 * ```tsx
 * import { FlaggrProvider, useFlag } from '@flaggr/sdk/react'
 *
 * function App() {
 *   return (
 *     <FlaggrProvider apiKey="flg_xxx" serviceId="web">
 *       <MyComponent />
 *     </FlaggrProvider>
 *   )
 * }
 *
 * function MyComponent() {
 *   const darkMode = useFlag('dark-mode')
 *   return <div className={darkMode ? 'dark' : 'light'}>...</div>
 * }
 * ```
 */

import { FlaggrClient } from "./client";
import { getGlobalClient } from "./global";
import type {
  FlaggrConfig,
  FlaggrClientInstance,
  FlagValue,
  EvaluationContext,
} from "./types";

/**
 * Create a Flaggr client instance
 *
 * @param config - Client configuration
 * @returns Flaggr client instance
 */
export function createFlaggr(config: FlaggrConfig): FlaggrClientInstance {
  return new FlaggrClient(config);
}

/**
 * Evaluate a feature flag using the global client.
 *
 * Uses env vars or a prior `configure()` call for configuration.
 * Defaults to `false` when no defaultValue is given (boolean mode).
 *
 * @example Boolean flag
 * ```typescript
 * if (await flag('dark-mode')) { ... }
 * ```
 *
 * @example String flag
 * ```typescript
 * const variant = await flag('checkout-variant', 'classic')
 * ```
 *
 * @example With context
 * ```typescript
 * const enabled = await flag('beta', false, { targetingKey: user.id })
 * ```
 */
export async function flag(
  flagKey: string,
  defaultValue?: boolean
): Promise<boolean>;
export async function flag<T extends FlagValue>(
  flagKey: string,
  defaultValue: T,
  context?: EvaluationContext
): Promise<T>;
export async function flag<T extends FlagValue = boolean>(
  flagKey: string,
  defaultValue?: T,
  context?: EvaluationContext
): Promise<T> {
  const client = getGlobalClient();
  const def = (defaultValue ?? false) as T;
  const result = await client.evaluate<T>(flagKey, def, context);
  return result.value;
}

// Re-export types
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
} from "./types";
export { ConnectionState } from "./types";

// Re-export client class for advanced usage
export { FlaggrClient } from "./client";

// Smart cache
export { SmartCache } from "./smart-cache";
export type {
  SmartCacheConfig,
  CacheResult,
  CacheStats,
  CacheStatus,
} from "./smart-cache";

// Global singleton management
export { configure, resetGlobalClient } from "./global";

// Environment config reader
export { readEnvConfig } from "./env";

// Browser telemetry plugin (opt-in)
export { flaggrTelemetry } from "./telemetry";
export type { TelemetryOptions } from "./telemetry";
