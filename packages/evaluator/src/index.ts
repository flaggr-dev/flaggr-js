/**
 * @flaggr/evaluator
 *
 * Standalone flag evaluator for Flaggr.
 * Zero dependencies, pure TypeScript.
 * Semantics mirror the Go data-plane evaluator for local/remote parity.
 *
 * @example
 * ```typescript
 * import { Evaluator, evaluateFlag } from '@flaggr/evaluator';
 *
 * // Using the class
 * const result = Evaluator.evaluate(flag, context);
 *
 * // Using the convenience function
 * const result = evaluateFlag(flag, context);
 *
 * // Bulk evaluation
 * const results = Evaluator.evaluateBulk(flags, context);
 * ```
 */

// Core evaluator
export {
  Evaluator,
  evaluateFlag,
  evaluateFlags,
  createTypedEvaluator,
  hashString,
  isInRollout,
  isWithinSchedule,
  isLocallyEvaluable,
  GO_SUPPORTED_OPERATORS,
} from "./evaluator";

// Types
export type {
  FlagValue,
  FlagType,
  EvaluationContext,
  FlagVariant,
  ConditionOperator,
  Condition,
  ConditionGroup,
  ScheduleRecurrence,
  RuleSchedule,
  TargetingRule,
  FlagOverride,
  FlagConfig,
  FeatureFlag,
  EvaluationReason,
  ResolutionDetails,
  FlagConfiguration,
} from "./types";
