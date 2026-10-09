/**
 * Standalone Flag Evaluator
 *
 * Pure TypeScript evaluation logic with zero external dependencies.
 * Can be embedded in any runtime: Node.js, browsers, edge workers, serverless.
 *
 * Semantics mirror the Go data-plane evaluator (services/flaggr-api/evaluator):
 * evaluation order, hashing, coercion, and operator behaviour are identical so
 * SDK-side local evaluation produces the same results as remote evaluation.
 */

import {
  FlagConfig,
  EvaluationContext,
  ResolutionDetails,
  Condition,
  ConditionGroup,
  TargetingRule,
  FlagVariant,
  FlagValue,
  RuleSchedule,
} from "./types";

/**
 * Operators the Go data plane implements. Anything outside this set evaluates
 * to false there — SDKs should treat flags using other operators as
 * remote-only to preserve parity.
 */
export const GO_SUPPORTED_OPERATORS: ReadonlySet<string> = new Set([
  "equals",
  "not_equals",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "greater_than",
  "less_than",
  "gte",
  "lte",
  "regex",
  "before",
  "after",
]);

/**
 * Returns true when every operator in the flag's targeting rules is
 * implemented by the Go data plane, so local evaluation has exact parity.
 * Flags using other operators (exists, in_cohort, ...) should be evaluated
 * remotely.
 */
export function isLocallyEvaluable(flag: FlagConfig): boolean {
  for (const rule of Array.isArray(flag.targeting) ? flag.targeting : []) {
    if (!isObject(rule)) continue;
    for (const cond of rule.conditions ?? []) {
      if (!GO_SUPPORTED_OPERATORS.has(cond.operator)) return false;
    }
    for (const group of rule.groups ?? []) {
      for (const cond of group?.conditions ?? []) {
        if (!GO_SUPPORTED_OPERATORS.has(cond.operator)) return false;
      }
    }
  }
  return true;
}

/**
 * Flag evaluator - stateless, pure functions
 */
export class Evaluator {
  /**
   * Evaluates a flag configuration against an evaluation context.
   * Order (Go parity): disabled → overrides → targeting rules (schedule →
   * conditions/groups → rollout %) → variants → default.
   *
   * Reads the data plane's JSON (/api/flags/export, its SSE configuration
   * events) as the data plane does: a field it encodes as null or "" is unset,
   * and an entry of targeting or overrides that isn't an object is skipped.
   */
  static evaluate(
    flag: FlagConfig,
    context: EvaluationContext = {}
  ): ResolutionDetails {
    if (!flag.enabled) {
      return {
        value: flag.defaultValue,
        reason: "DISABLED",
      };
    }

    // Overrides — identity match, priority-sorted (highest first)
    if (Array.isArray(flag.overrides) && flag.overrides.length > 0 && context.targetingKey) {
      const sorted = flag.overrides
        .filter(isObject)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      for (const override of sorted) {
        if (override.identifiers?.includes(context.targetingKey)) {
          return { value: override.value, reason: "OVERRIDE" };
        }
      }
    }

    // Targeting rules
    if (Array.isArray(flag.targeting) && flag.targeting.length > 0) {
      for (const rule of flag.targeting) {
        // Not an object (null, or junk an import stored): no rule. Read as
        // one, it would have no conditions and match everyone.
        if (!isObject(rule)) continue;
        if (!isWithinSchedule(rule.schedule)) continue;
        if (this.evaluateRule(rule, context)) {
          if (
            rule.rolloutPercentage != null &&
            rule.rolloutPercentage < 100 &&
            !isInRollout(flag.key, context.targetingKey ?? "", rule.rolloutPercentage)
          ) {
            continue;
          }
          return {
            value: rule.value != null ? rule.value : flag.defaultValue,
            variant: rule.variant || undefined,
            reason: "TARGETING_MATCH",
          };
        }
      }
      // Targeting present but unmatched — variants still apply
      if (flag.variants && flag.variants.length > 0 && context.targetingKey) {
        const variant = this.selectVariant(
          flag.key,
          context.targetingKey,
          flag.variants
        );
        if (variant) {
          return { value: variant.value, variant: variant.name, reason: "VARIANT" };
        }
      }
      return { value: flag.defaultValue, reason: "DEFAULT" };
    }

    // Variants (no targeting rules)
    if (flag.variants && flag.variants.length > 0 && context.targetingKey) {
      const variant = this.selectVariant(
        flag.key,
        context.targetingKey,
        flag.variants
      );
      if (variant) {
        return {
          value: variant.value,
          variant: variant.name,
          reason: "VARIANT",
        };
      }
    }

    // Default
    return {
      value: flag.defaultValue,
      reason: "DEFAULT",
    };
  }

  /**
   * Evaluates multiple flags at once
   */
  static evaluateBulk(
    flags: Record<string, FlagConfig>,
    context: EvaluationContext = {}
  ): Record<string, ResolutionDetails> {
    const results: Record<string, ResolutionDetails> = {};

    for (const [key, flag] of Object.entries(flags)) {
      results[key] = this.evaluate(flag, context);
    }

    return results;
  }

  /**
   * Evaluates a targeting rule against the context (Go parity). A rule with
   * condition groups is decided by its groups; otherwise its flat conditions
   * combine with conditionOperator ("and" by default). A rule with neither
   * conditions nor groups matches everyone, so `conditions: []` with a
   * rolloutPercentage rolls the rule's value out to that share of all users.
   * The cases in test/rule-matching-cases.json pin these semantics for this
   * evaluator, the control plane's and the Go data plane's.
   */
  private static evaluateRule(
    rule: TargetingRule,
    context: EvaluationContext
  ): boolean {
    if (Array.isArray(rule.groups) && rule.groups.length > 0) {
      return this.evaluateGroups(rule.groups, rule.groupOperator || "or", context);
    }

    // No groups and no conditions: the rule matches everyone.
    const conditions = rule.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return true;
    }

    const operator = rule.conditionOperator || "and";

    if (operator === "or") {
      return conditions.some((condition: Condition) =>
        this.evaluateCondition(condition, context)
      );
    }

    // Default: AND logic
    return conditions.every((condition: Condition) =>
      this.evaluateCondition(condition, context)
    );
  }

  /**
   * Evaluates condition groups: each group ANDs its conditions, groups combine
   * with the group operator (default "or") — Go parity. A group without
   * conditions matches nobody.
   */
  private static evaluateGroups(
    groups: Array<ConditionGroup | null>,
    groupOp: string,
    context: EvaluationContext
  ): boolean {
    const evalGroup = (g: ConditionGroup | null): boolean => {
      const conditions = g?.conditions;
      if (!Array.isArray(conditions) || conditions.length === 0) return false;
      return conditions.every((cond) => this.evaluateCondition(cond, context));
    };

    if (groupOp === "or") {
      return groups.some(evalGroup);
    }
    return groups.every(evalGroup);
  }

  /**
   * Evaluates a single condition. Operator set and coercion match the Go
   * evaluator exactly.
   */
  private static evaluateCondition(
    condition: Condition,
    context: EvaluationContext
  ): boolean {
    const contextValue =
      condition.property === "targetingKey"
        ? context.targetingKey
        : context[condition.property];
    const exists = contextValue !== undefined && contextValue !== null;

    switch (condition.operator) {
      case "equals":
        return compareEqual(contextValue, condition.value);

      case "not_equals":
        return !compareEqual(contextValue, condition.value);

      case "in":
        return (
          exists &&
          Array.isArray(condition.value) &&
          (condition.value as FlagValue[]).some((v) =>
            compareEqual(contextValue, v)
          )
        );

      case "not_in":
        return (
          exists &&
          Array.isArray(condition.value) &&
          !(condition.value as FlagValue[]).some((v) =>
            compareEqual(contextValue, v)
          )
        );

      case "contains":
        return (
          typeof contextValue === "string" &&
          typeof condition.value === "string" &&
          contextValue.includes(condition.value)
        );

      case "starts_with":
        return (
          typeof contextValue === "string" &&
          typeof condition.value === "string" &&
          contextValue.startsWith(condition.value)
        );

      case "ends_with":
        return (
          typeof contextValue === "string" &&
          typeof condition.value === "string" &&
          contextValue.endsWith(condition.value)
        );

      case "greater_than":
        return (
          typeof contextValue === "number" &&
          typeof condition.value === "number" &&
          contextValue > condition.value
        );

      case "less_than":
        return (
          typeof contextValue === "number" &&
          typeof condition.value === "number" &&
          contextValue < condition.value
        );

      case "gte":
      case "greater_than_or_equal":
        return (
          typeof contextValue === "number" &&
          typeof condition.value === "number" &&
          contextValue >= condition.value
        );

      case "lte":
      case "less_than_or_equal":
        return (
          typeof contextValue === "number" &&
          typeof condition.value === "number" &&
          contextValue <= condition.value
        );

      case "regex":
        if (
          typeof contextValue === "string" &&
          typeof condition.value === "string"
        ) {
          try {
            return new RegExp(condition.value).test(contextValue);
          } catch {
            return false;
          }
        }
        return false;

      case "before": {
        const ctxDate = parseDate(contextValue);
        const cmpDate = parseDate(condition.value);
        if (!ctxDate || !cmpDate) return false;
        return ctxDate.getTime() < cmpDate.getTime();
      }

      case "after": {
        const ctxDate = parseDate(contextValue);
        const cmpDate = parseDate(condition.value);
        if (!ctxDate || !cmpDate) return false;
        return ctxDate.getTime() > cmpDate.getTime();
      }

      case "exists":
        return exists;

      case "not_exists":
        return !exists;

      default:
        return false;
    }
  }

  /**
   * Selects a variant based on weighted distribution.
   * Uses the same h*31+c hash as the Go evaluator so local and remote
   * bucketing are identical. Falls back to the first variant when weights
   * don't cover 100 (Go parity).
   */
  private static selectVariant(
    flagKey: string,
    targetingKey: string,
    variants: FlagVariant[]
  ): FlagVariant | null {
    if (variants.length === 0) return null;

    const hash = hashString(flagKey + targetingKey);
    const percentage = hash % 100;

    let cumulative = 0;
    for (const variant of variants) {
      cumulative += variant.weight || 0;
      if (percentage < cumulative) {
        return variant;
      }
    }

    return variants[0];
  }
}

/**
 * Go-parity hash: hash = hash*31 + codePoint (int32 wraparound), abs at end.
 * The Go evaluator iterates runes; for..of iterates code points — identical.
 */
export function hashString(str: string): number {
  let hash = 0;
  for (const c of str) {
    hash = (hash * 31 + c.codePointAt(0)!) | 0;
  }
  return Math.abs(hash);
}

/**
 * Gradual rollout bucket check — Go parity:
 * hash(flagKey + ":rollout:" + targetingKey) % 100 < percentage. Without a
 * targeting key there is no bucket, so a partial rollout leaves the context
 * out.
 */
export function isInRollout(
  flagKey: string,
  targetingKey: string,
  percentage: number
): boolean {
  if (percentage === 0) return false;
  if (percentage >= 100) return true;
  if (!targetingKey) return false;
  return hashString(`${flagKey}:rollout:${targetingKey}`) % 100 < percentage;
}

/** A JSON object (not null, not an array): what a rule or an override must be. */
function isObject<T>(value: T): value is T & object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Equality with Go evaluator coercion: strings compare as strings, numbers as
 * numbers, booleans as booleans; mixed types fall back to string form
 * comparison (Go's fmt %v equivalence).
 */
function compareEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  return String(a) === String(b);
}

/**
 * Date parsing matching the Go evaluator: RFC3339 first, then YYYY-MM-DD.
 */
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Date-only parses as UTC midnight, matching Go's time.Parse("2006-01-02")
    return new Date(`${value}T00:00:00Z`);
  }
  return parsed;
}

/**
 * Schedule gating — Go parity (IsWithinSchedule). All times are UTC.
 */
export function isWithinSchedule(
  schedule: RuleSchedule | null | undefined,
  now: Date = new Date()
): boolean {
  if (!schedule) return true;

  if (schedule.startDate) {
    const start = new Date(schedule.startDate);
    if (!isNaN(start.getTime()) && now < start) return false;
  }
  if (schedule.endDate) {
    const end = new Date(schedule.endDate);
    if (!isNaN(end.getTime()) && now > end) return false;
  }

  const rec = schedule.recurrence;
  if (rec) {
    if (rec.type === "weekly" && rec.daysOfWeek && rec.daysOfWeek.length > 0) {
      if (!rec.daysOfWeek.includes(now.getUTCDay())) return false;
    }

    if (rec.startTime && rec.endTime) {
      const current = now.getUTCHours() * 60 + now.getUTCMinutes();
      const start = parseTimeMinutes(rec.startTime);
      const end = parseTimeMinutes(rec.endTime);

      if (start <= end) {
        if (current < start || current > end) return false;
      } else {
        // Overnight window (e.g. 22:00-06:00)
        if (current < start && current > end) return false;
      }
    }
  }

  return true;
}

function parseTimeMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Convenience function for evaluating a single flag
 */
export function evaluateFlag(
  flag: FlagConfig,
  context: EvaluationContext = {}
): ResolutionDetails {
  return Evaluator.evaluate(flag, context);
}

/**
 * Convenience function for evaluating multiple flags
 */
export function evaluateFlags(
  flags: Record<string, FlagConfig>,
  context: EvaluationContext = {}
): Record<string, ResolutionDetails> {
  return Evaluator.evaluateBulk(flags, context);
}

/**
 * Create a typed evaluation function for a specific flag type
 */
export function createTypedEvaluator<T extends FlagValue>(
  defaultValue: T
): (flag: FlagConfig, context?: EvaluationContext) => ResolutionDetails<T> {
  return (flag: FlagConfig, context: EvaluationContext = {}) => {
    const result = Evaluator.evaluate(flag, context);
    return {
      ...result,
      value: (result.value as T) ?? defaultValue,
    };
  };
}
