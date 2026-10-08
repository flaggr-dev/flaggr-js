/**
 * @flaggr/sdk/otel - Pluggable OpenTelemetry instrumentation for Flaggr SDK
 *
 * Usage:
 * ```typescript
 * import { createFlaggr } from '@flaggr/sdk'
 * import { otelPlugin } from '@flaggr/sdk/otel'
 *
 * const client = createFlaggr({
 *   serviceId: 'web-app',
 *   apiKey: 'flg_xxx',
 *   plugins: [
 *     otelPlugin()                    // Uses global OTEL providers
 *     otelPlugin({ serviceName: 'my-app' })  // Custom service name
 *     otelPlugin({ meterProvider })   // Bring your own meter provider
 *   ]
 * })
 * ```
 */

import type {
  FlaggrPlugin,
  EvaluationContext,
  EvaluationResult,
  FlagChangeEvent,
  ConnectionState,
} from "./types";

// OTEL types — imported dynamically so the plugin is optional
type Meter = import("@opentelemetry/api").Meter;
type Counter = import("@opentelemetry/api").Counter;
type Histogram = import("@opentelemetry/api").Histogram;
type UpDownCounter = import("@opentelemetry/api").UpDownCounter;
type MeterProvider = import("@opentelemetry/api").MeterProvider;
type Tracer = import("@opentelemetry/api").Tracer;
type TracerProvider = import("@opentelemetry/api").TracerProvider;
type Span = import("@opentelemetry/api").Span;

/**
 * Configuration for the OTEL plugin
 */
export interface OtelPluginConfig {
  /** Custom service name for metrics/traces (default: "flaggr-sdk") */
  serviceName?: string;
  /** Custom meter provider (uses global by default) */
  meterProvider?: MeterProvider;
  /** Custom tracer provider (uses global by default) */
  tracerProvider?: TracerProvider;
  /** Enable trace spans for evaluations (default: true) */
  enableTracing?: boolean;
  /** Enable metrics for evaluations (default: true) */
  enableMetrics?: boolean;
  /** Custom metric prefix (default: "flaggr") */
  metricPrefix?: string;
  /** Additional attributes to add to all metrics/spans */
  additionalAttributes?: Record<string, string>;
}

interface OtelInstruments {
  evaluationCounter: Counter;
  evaluationDuration: Histogram;
  evaluationErrors: Counter;
  cacheHits: Counter;
  cacheMisses: Counter;
  flagChanges: Counter;
  activeConnections: UpDownCounter;
}

/**
 * Create an OpenTelemetry instrumentation plugin for Flaggr SDK
 *
 * @example Basic usage (uses global OTEL providers)
 * ```typescript
 * import { otelPlugin } from '@flaggr/sdk/otel'
 * plugins: [otelPlugin()]
 * ```
 *
 * @example Custom configuration
 * ```typescript
 * import { otelPlugin } from '@flaggr/sdk/otel'
 * plugins: [otelPlugin({
 *   serviceName: 'checkout-service',
 *   enableTracing: true,
 *   enableMetrics: true,
 *   additionalAttributes: { 'deployment.env': 'production' },
 * })]
 * ```
 *
 * @example Bring your own providers
 * ```typescript
 * import { otelPlugin } from '@flaggr/sdk/otel'
 * import { MeterProvider } from '@opentelemetry/sdk-metrics'
 * plugins: [otelPlugin({
 *   meterProvider: new MeterProvider({ ... }),
 *   tracerProvider: myTracerProvider,
 * })]
 * ```
 */
export function otelPlugin(config?: OtelPluginConfig): FlaggrPlugin {
  const {
    serviceName = "flaggr-sdk",
    enableTracing = true,
    enableMetrics = true,
    metricPrefix = "flaggr",
    additionalAttributes = {},
  } = config ?? {};

  let meter: Meter | null = null;
  let tracer: Tracer | null = null;
  let instruments: OtelInstruments | null = null;
  let otelApi: typeof import("@opentelemetry/api") | null = null;

  async function initOtel(): Promise<boolean> {
    try {
      // Dynamic import so @opentelemetry/api is truly optional
      otelApi = await import("@opentelemetry/api");

      if (enableMetrics) {
        const provider =
          config?.meterProvider ?? otelApi.metrics.getMeterProvider();
        meter = provider.getMeter(serviceName, "0.1.0");

        instruments = {
          evaluationCounter: meter.createCounter(
            `${metricPrefix}.evaluations.total`,
            {
              description: "Total flag evaluations",
              unit: "1",
            }
          ),
          evaluationDuration: meter.createHistogram(
            `${metricPrefix}.evaluations.duration`,
            {
              description: "Flag evaluation duration in milliseconds",
              unit: "ms",
            }
          ),
          evaluationErrors: meter.createCounter(
            `${metricPrefix}.evaluations.errors`,
            {
              description: "Total evaluation errors",
              unit: "1",
            }
          ),
          cacheHits: meter.createCounter(`${metricPrefix}.cache.hits`, {
            description: "Cache hits for flag evaluations",
            unit: "1",
          }),
          cacheMisses: meter.createCounter(`${metricPrefix}.cache.misses`, {
            description: "Cache misses for flag evaluations",
            unit: "1",
          }),
          flagChanges: meter.createCounter(`${metricPrefix}.flag_changes.total`, {
            description: "Total flag change events received",
            unit: "1",
          }),
          activeConnections: meter.createUpDownCounter(
            `${metricPrefix}.connections.active`,
            {
              description: "Active SDK connections",
              unit: "1",
            }
          ),
        };
      }

      if (enableTracing) {
        const provider =
          config?.tracerProvider ?? otelApi.trace.getTracerProvider();
        tracer = provider.getTracer(serviceName, "0.1.0");
      }

      return true;
    } catch {
      console.warn(
        "[flaggr/otel] @opentelemetry/api not found. Install it to enable instrumentation: npm install @opentelemetry/api"
      );
      return false;
    }
  }

  function attrs(extra?: Record<string, string>): Record<string, string> {
    return { ...additionalAttributes, ...extra };
  }

  // Track active spans per evaluation
  const activeSpans = new Map<string, Span>();

  return {
    name: "otel",

    onInit() {
      // Fire and forget — don't block init
      initOtel();
    },

    onEvaluate(flagKey: string, context?: EvaluationContext) {
      if (!tracer || !otelApi) return;

      const span = tracer.startSpan("flaggr.evaluate", {
        attributes: {
          "feature_flag.key": flagKey,
          "feature_flag.provider_name": "flaggr",
          ...attrs(),
          ...(context?.targetingKey
            ? { "feature_flag.context.targeting_key": context.targetingKey }
            : {}),
        },
      });

      activeSpans.set(flagKey, span);
    },

    onEvaluateComplete(
      flagKey: string,
      result: EvaluationResult,
      durationMs: number
    ) {
      const flagAttrs = attrs({
        "feature_flag.key": flagKey,
        "feature_flag.reason": result.reason,
        ...(result.variant ? { "feature_flag.variant": result.variant } : {}),
      });

      // Metrics
      if (instruments) {
        instruments.evaluationCounter.add(1, flagAttrs);
        instruments.evaluationDuration.record(durationMs, flagAttrs);

        // Track cache hits (very fast evaluations are likely cache hits)
        if (durationMs < 1) {
          instruments.cacheHits.add(1, attrs({ "feature_flag.key": flagKey }));
        } else {
          instruments.cacheMisses.add(1, attrs({ "feature_flag.key": flagKey }));
        }
      }

      // Tracing
      const span = activeSpans.get(flagKey);
      if (span && otelApi) {
        span.setAttributes({
          "feature_flag.value": String(result.value),
          "feature_flag.reason": result.reason,
          ...(result.variant
            ? { "feature_flag.variant": result.variant }
            : {}),
        });
        span.setStatus({ code: otelApi.SpanStatusCode.OK });
        span.end();
        activeSpans.delete(flagKey);
      }
    },

    onEvaluateError(flagKey: string, error: Error, durationMs: number) {
      const flagAttrs = attrs({
        "feature_flag.key": flagKey,
        "error.type": error.name,
      });

      // Metrics
      if (instruments) {
        instruments.evaluationErrors.add(1, flagAttrs);
        instruments.evaluationDuration.record(durationMs, flagAttrs);
      }

      // Tracing
      const span = activeSpans.get(flagKey);
      if (span && otelApi) {
        span.setStatus({
          code: otelApi.SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();
        activeSpans.delete(flagKey);
      }
    },

    onFlagChange(event: FlagChangeEvent) {
      if (instruments) {
        instruments.flagChanges.add(
          1,
          attrs({ "feature_flag.key": event.flagKey })
        );
      }
    },

    onConnectionStateChange(state: ConnectionState) {
      if (instruments) {
        const delta = state === "connected" ? 1 : -1;
        instruments.activeConnections.add(delta, attrs());
      }
    },

    onDestroy() {
      // End any remaining spans
      for (const [, span] of activeSpans) {
        span.end();
      }
      activeSpans.clear();
    },
  };
}
