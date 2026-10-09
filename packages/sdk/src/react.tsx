/**
 * flaggr/react - React hooks for Flaggr feature flag evaluation
 *
 * @example Zero-config
 * ```tsx
 * import { FlaggrProvider, useFlag } from 'flaggr/react'
 *
 * function App() {
 *   return (
 *     <FlaggrProvider apiKey="fgr_xxx" serviceId="web">
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
 * <FlaggrProvider apiKey="fgr_xxx" serviceId="my-app">
 *   <App />
 * </FlaggrProvider>
 * ```
 *
 * @example Config object
 * ```tsx
 * <FlaggrProvider config={{ serviceId: 'my-app', apiKey: 'fgr_xxx', enableStreaming: true }}>
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
  // The props a replacement client is created from (see the second effect):
  // the latest committed ones. This effect runs before that one.
  const props = { apiKey, serviceId, environment, config };
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  // Created while rendering but not started: no plugin onInit, remote config
  // fetch, stream or timer. A render React throws away (Strict Mode renders
  // twice in development; a server render never commits) leaves nothing
  // running, and the server never opens a stream. Children can evaluate
  // synchronously (bootstrap, cache) from the first render.
  const [client, setClient] = useState(
    () => new FlaggrClient(resolveProviderConfig(props), { start: false })
  );
  /** The client this effect's cleanup destroyed last. */
  const destroyedRef = useRef<FlaggrClient | null>(null);

  useEffect(() => {
    if (destroyedRef.current === client) {
      // Mounted again after the cleanup destroyed the client: Strict Mode
      // does that once after the first mount in development, as does an
      // <Activity> shown again. Replace it; this effect runs again for the
      // new client and starts it.
      setClient(new FlaggrClient(resolveProviderConfig(propsRef.current), { start: false }));
      return;
    }
    client.start();
    return () => {
      client.destroy();
      destroyedRef.current = client;
    };
  }, [client]);

  return (
    <FlaggrContext.Provider value={client}>
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

/** Whether a hook's per-call context sets anything (`{}` is the client's own context). */
function hasOwnContext(context: EvaluationContext | undefined): boolean {
  return context !== undefined && Object.keys(context).length > 0;
}

/**
 * A hook's effect: evaluate its flag, then follow the flag's changes. A
 * change event carries the flag's value for the client's own context, so a
 * hook with a per-call context (or an event without a value, such as a
 * deletion) evaluates again, with its own context, instead of taking it.
 * Only the newest answer is kept: an evaluation still on its way when a
 * newer one starts, or a newer value arrives, is dropped.
 */
function followFlag<T>(
  client: FlaggrClientInstance,
  flagKey: string,
  contextRef: { readonly current: EvaluationContext | undefined },
  evaluate: (context: EvaluationContext | undefined) => Promise<T>,
  accepts: (value: FlagValue) => boolean,
  setValue: (value: T) => void
): () => void {
  let mounted = true;
  let latest = 0;
  const reevaluate = () => {
    const call = ++latest;
    evaluate(contextRef.current).then(
      (value) => {
        if (mounted && call === latest) setValue(value);
      },
      () => {
        /* evaluation errors resolve to the fallback; a throwing plugin keeps the value */
      }
    );
  };
  reevaluate();
  const unsubscribe = client.onFlagChange(flagKey, (event) => {
    if (!mounted) return;
    if (hasOwnContext(contextRef.current) || event.newValue === undefined) {
      reevaluate();
    } else if (accepts(event.newValue)) {
      latest++;
      setValue(event.newValue as T);
    }
  });
  return () => {
    mounted = false;
    unsubscribe();
  };
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

  useEffect(
    () =>
      followFlag(
        client,
        flagKey,
        contextRef,
        (ctx) => client.evaluate<T>(flagKey, def, ctx).then((result) => result.value),
        () => true,
        setValue
      ),
    [client, flagKey, def]
  );

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

  useEffect(
    () =>
      followFlag(
        client,
        flagKey,
        contextRef,
        (ctx) => client.getBooleanValue(flagKey, defaultValue, ctx),
        (value) => typeof value === "boolean",
        setValue
      ),
    [client, flagKey, defaultValue]
  );

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

  useEffect(
    () =>
      followFlag(
        client,
        flagKey,
        contextRef,
        (ctx) => client.getStringValue(flagKey, defaultValue, ctx),
        (value) => typeof value === "string",
        setValue
      ),
    [client, flagKey, defaultValue]
  );

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

  useEffect(
    () =>
      followFlag(
        client,
        flagKey,
        contextRef,
        (ctx) => client.getNumberValue(flagKey, defaultValue, ctx),
        (value) => typeof value === "number",
        setValue
      ),
    [client, flagKey, defaultValue]
  );

  return value;
}

/**
 * Evaluate a typed object feature flag (T may be an interface: any object type)
 */
export function useObjectFlag<T extends object>(
  flagKey: string,
  defaultValue: T,
  context?: EvaluationContext
): T {
  const client = useFlaggr();
  const [value, setValue] = useState<T>(
    () => client.evaluateSync<T & FlagValue>(flagKey, defaultValue as T & FlagValue, context).value
  );

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(
    () =>
      followFlag(
        client,
        flagKey,
        contextRef,
        (ctx) => client.getObjectValue<T>(flagKey, defaultValue, ctx),
        (value) => typeof value === "object" && value !== null,
        setValue
      ),
    [client, flagKey, defaultValue]
  );

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
 * Get a refresh function to force-refresh all flags: it re-evaluates the
 * flags the client has cached or watches (the hooks watch theirs), and the
 * hooks of flags whose value changed re-render (see `refresh()`). A hook with
 * a per-call context evaluates again, for that context, when its flag's
 * value changes for the client's own context (or the client had none
 * cached for it): give the provider the user's context (`config.context`)
 * rather than each hook, and every hook follows every change.
 */
export function useRefreshFlags(): () => Promise<void> {
  const client = useFlaggr();
  return useCallback(() => client.refresh(), [client]);
}
