/**
 * flaggr/react - React hooks for Flaggr feature flag evaluation
 *
 * @example Zero-config
 * ```tsx
 * import { FlaggrProvider, useFlag } from 'flaggr/react'
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

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { FlaggrClient } from "./client";
import { readEnvConfig } from "./env";
import type {
  FlaggrConfig,
  FlaggrClientInstance,
  FlagValue,
  EvaluationContext,
  ConnectionState,
} from "./types";

// --- Context ---

const FlaggrContext = createContext<FlaggrClientInstance | null>(null);

/**
 * Provider component that initializes the Flaggr client.
 *
 * Accepts either flat props (apiKey, serviceId, environment) or a
 * `config` object for advanced usage. Falls back to env vars.
 *
 * @example Flat props (recommended)
 * ```tsx
 * <FlaggrProvider apiKey="flg_xxx" serviceId="my-app">
 *   <App />
 * </FlaggrProvider>
 * ```
 *
 * @example Config object
 * ```tsx
 * <FlaggrProvider config={{ serviceId: 'my-app', apiKey: 'flg_xxx', enableStreaming: true }}>
 *   <App />
 * </FlaggrProvider>
 * ```
 */
export function FlaggrProvider({
  apiKey,
  serviceId,
  environment,
  config,
  children,
}: {
  apiKey?: string;
  serviceId?: string;
  environment?: string;
  config?: FlaggrConfig;
  children: ReactNode;
}) {
  const clientRef = useRef<FlaggrClient | null>(null);

  if (!clientRef.current) {
    const resolved = resolveProviderConfig({ apiKey, serviceId, environment, config });
    clientRef.current = new FlaggrClient(resolved);
  }

  useEffect(() => {
    return () => {
      clientRef.current?.destroy();
    };
  }, []);

  return (
    <FlaggrContext.Provider value={clientRef.current}>
      {children}
    </FlaggrContext.Provider>
  );
}

function resolveProviderConfig(props: {
  apiKey?: string;
  serviceId?: string;
  environment?: string;
  config?: FlaggrConfig;
}): FlaggrConfig {
  // Explicit flat props take priority
  if (props.serviceId) {
    return {
      serviceId: props.serviceId,
      apiKey: props.apiKey,
      environment: props.environment,
      ...props.config,
      // Flat props override config object fields
      ...(props.serviceId ? { serviceId: props.serviceId } : {}),
      ...(props.apiKey ? { apiKey: props.apiKey } : {}),
      ...(props.environment ? { environment: props.environment } : {}),
    };
  }

  // Config object
  if (props.config) {
    return props.config;
  }

  // Fall back to env vars
  const envConfig = readEnvConfig();
  if (!envConfig.serviceId) {
    throw new Error(
      "FlaggrProvider: No serviceId found. Pass serviceId as a prop, " +
        "use the config prop, or set NEXT_PUBLIC_FLAGGR_SERVICE_ID."
    );
  }
  return envConfig as FlaggrConfig;
}

/**
 * Get the Flaggr client instance from context
 */
export function useFlaggr(): FlaggrClientInstance {
  const client = useContext(FlaggrContext);
  if (!client) {
    throw new Error("useFlaggr must be used within a <FlaggrProvider>");
  }
  return client;
}

// --- Generic hook ---

/**
 * Evaluate any feature flag. Defaults to boolean `false` if no defaultValue given.
 *
 * @example Boolean (default)
 * ```tsx
 * const enabled = useFlag('dark-mode')
 * ```
 *
 * @example String
 * ```tsx
 * const variant = useFlag('checkout', 'classic')
 * ```
 *
 * @example With context
 * ```tsx
 * const beta = useFlag('beta', false, { targetingKey: user.id })
 * ```
 */
export function useFlag(
  flagKey: string,
  defaultValue?: boolean
): boolean;
export function useFlag<T extends FlagValue>(
  flagKey: string,
  defaultValue: T,
  context?: EvaluationContext
): T;
export function useFlag<T extends FlagValue = boolean>(
  flagKey: string,
  defaultValue?: T,
  context?: EvaluationContext
): T {
  const client = useFlaggr();
  const def = (defaultValue ?? false) as T;
  // Sync initial evaluation: when the configuration is already streamed or
  // bootstrapped, the first render gets the real value — no flash-of-default.
  const [value, setValue] = useState<T>(
    () => client.evaluateSync<T>(flagKey, def, context).value
  );

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let mounted = true;

    client.evaluate<T>(flagKey, def, contextRef.current).then((result) => {
      if (mounted) setValue(result.value);
    });

    const unsub = client.onFlagChange(flagKey, (event) => {
      if (mounted) setValue(event.newValue as T);
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [client, flagKey, def]);

  return value;
}

// --- Type-specific hooks ---

/**
 * Evaluate a boolean feature flag
 */
export function useBooleanFlag(
  flagKey: string,
  defaultValue: boolean,
  context?: EvaluationContext
): boolean {
  const client = useFlaggr();
  const [value, setValue] = useState(
    () => client.getBooleanValueSync(flagKey, defaultValue, context)
  );

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let mounted = true;

    client
      .getBooleanValue(flagKey, defaultValue, contextRef.current)
      .then((v) => {
        if (mounted) setValue(v);
      });

    const unsub = client.onFlagChange(flagKey, (event) => {
      if (mounted && typeof event.newValue === "boolean") {
        setValue(event.newValue);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [client, flagKey, defaultValue]);

  return value;
}

/**
 * Evaluate a string feature flag
 */
export function useStringFlag(
  flagKey: string,
  defaultValue: string,
  context?: EvaluationContext
): string {
  const client = useFlaggr();
  const [value, setValue] = useState(
    () => client.evaluateSync<string>(flagKey, defaultValue, context).value
  );

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let mounted = true;

    client
      .getStringValue(flagKey, defaultValue, contextRef.current)
      .then((v) => {
        if (mounted) setValue(v);
      });

    const unsub = client.onFlagChange(flagKey, (event) => {
      if (mounted && typeof event.newValue === "string") {
        setValue(event.newValue);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [client, flagKey, defaultValue]);

  return value;
}

/**
 * Evaluate a number feature flag
 */
export function useNumberFlag(
  flagKey: string,
  defaultValue: number,
  context?: EvaluationContext
): number {
  const client = useFlaggr();
  const [value, setValue] = useState(
    () => client.evaluateSync<number>(flagKey, defaultValue, context).value
  );

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let mounted = true;

    client
      .getNumberValue(flagKey, defaultValue, contextRef.current)
      .then((v) => {
        if (mounted) setValue(v);
      });

    const unsub = client.onFlagChange(flagKey, (event) => {
      if (mounted && typeof event.newValue === "number") {
        setValue(event.newValue);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [client, flagKey, defaultValue]);

  return value;
}

/**
 * Evaluate a typed object feature flag
 */
export function useObjectFlag<T extends Record<string, unknown>>(
  flagKey: string,
  defaultValue: T,
  context?: EvaluationContext
): T {
  const client = useFlaggr();
  const [value, setValue] = useState<T>(
    () => client.evaluateSync<T>(flagKey, defaultValue, context).value
  );

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let mounted = true;

    client
      .getObjectValue<T>(flagKey, defaultValue, contextRef.current)
      .then((v) => {
        if (mounted) setValue(v);
      });

    const unsub = client.onFlagChange(flagKey, (event) => {
      if (mounted && typeof event.newValue === "object" && event.newValue !== null) {
        setValue(event.newValue as T);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [client, flagKey, defaultValue]);

  return value;
}

/**
 * Get the current connection state and subscribe to changes
 */
export function useConnectionState(): ConnectionState {
  const client = useFlaggr();
  const [state, setState] = useState<ConnectionState>(
    client.getConnectionState()
  );

  useEffect(() => {
    return client.onConnectionStateChange(setState);
  }, [client]);

  return state;
}

/**
 * Get a refresh function to force-refresh all flags
 */
export function useRefreshFlags(): () => Promise<void> {
  const client = useFlaggr();
  return useCallback(() => client.refresh(), [client]);
}
