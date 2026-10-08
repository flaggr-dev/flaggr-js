/**
 * Standalone Evaluator Types
 *
 * Minimal type definitions for flag evaluation.
 * No external dependencies - pure TypeScript.
 */

/**
 * Value types that can be stored in a flag
 */
export type FlagValue = boolean | string | number | Record<string, unknown>;

/**
 * Flag type enumeration
 */
export type FlagType = "boolean" | "string" | "number" | "object";

/**
 * Evaluation context - key-value pairs for targeting.
 * Values can be any flag-serializable type (the data plane accepts
 * map[string]interface{}).
 */
export interface EvaluationContext {
  targetingKey?: string;
  [key: string]: string | number | boolean | object | undefined;
}

/**
 * Flag variant for A/B testing and percentage rollouts
 */
export interface FlagVariant {
  name: string;
  value: FlagValue;
  weight?: number; // Percentage weight (0-100)
}

/**
 * Condition operators for targeting rules
 */
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "greater_than"
  | "less_than"
  | "gte"
  | "lte"
  | "greater_than_or_equal"
  | "less_than_or_equal"
  | "regex"
  | "before"
  | "after"
  | "exists"
  | "not_exists"
  | "in_cohort"
  | "not_in_cohort";

/**
 * Targeting condition
 */
export interface Condition {
  property: string;
  operator: ConditionOperator | string;
  value: string | number | boolean | Array<string | number | boolean>;
}

/**
 * Condition group — conditions AND together, groups combine via the rule's
 * groupOperator (Go evaluator parity).
 */
export interface ConditionGroup {
  conditions: Condition[];
}

/**
 * Recurring schedule window (UTC)
 */
export interface ScheduleRecurrence {
  type?: string; // "daily" | "weekly"
  daysOfWeek?: number[]; // 0=Sunday
  startTime?: string; // "HH:MM"
  endTime?: string; // "HH:MM"
}

/**
 * When a targeting rule is active
 */
export interface RuleSchedule {
  startDate?: string; // RFC3339
  endDate?: string; // RFC3339
  recurrence?: ScheduleRecurrence;
}

/**
 * Targeting rule with conditions and resulting value/variant
 */
export interface TargetingRule {
  id: string;
  conditions: Condition[];
  conditionOperator?: "and" | "or"; // Default: "and"
  groups?: ConditionGroup[];
  groupOperator?: "and" | "or"; // Default: "or"
  variant?: string;
  value?: FlagValue;
  rolloutPercentage?: number;
  schedule?: RuleSchedule;
}

/**
 * Identity-based value override (matched against context.targetingKey)
 */
export interface FlagOverride {
  name?: string;
  identifiers: string[];
  value: FlagValue;
  priority?: number;
}

/**
 * Flag configuration for evaluation
 * Minimal subset needed for evaluation (no metadata fields)
 */
export interface FlagConfig {
  key: string;
  type: FlagType;
  enabled: boolean;
  defaultValue: FlagValue;
  variants?: FlagVariant[];
  targeting?: TargetingRule[];
  overrides?: FlagOverride[];
}

/**
 * Full feature flag with all metadata
 */
export interface FeatureFlag extends FlagConfig {
  name: string;
  description?: string;
  projectId: string;
  serviceId: string;
  environment: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/**
 * Evaluation result reason
 */
export type EvaluationReason =
  | "DEFAULT"
  | "DISABLED"
  | "TARGETING_MATCH"
  | "OVERRIDE"
  | "VARIANT"
  | "ERROR"
  | "NOT_FOUND"
  | "STATIC";

/**
 * Resolution details returned from evaluation
 */
export interface ResolutionDetails<T extends FlagValue = FlagValue> {
  value: T;
  variant?: string;
  reason: EvaluationReason;
  errorCode?: string;
  errorMessage?: string;
  flagMetadata?: Record<string, string | number | boolean>;
}

/**
 * Flag configuration set (multiple flags)
 */
export interface FlagConfiguration {
  flags: Record<string, FlagConfig>;
  version?: string;
  generatedAt?: string;
}
