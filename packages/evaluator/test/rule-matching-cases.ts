import type { EvaluationContext, FlagConfig, FlagValue } from "../src";

/**
 * The shared rule-matching cases (rule-matching-cases.json), each with its flag
 * in two forms: as the case writes it, and as the Go data plane encodes it
 * (rule-matching-cases.go-wire.json, written by
 * services/flaggr-api/evaluator/rule_matching_parity_test.go), where every
 * unset field is null or "". Read by this package's tests, the control plane's
 * (__tests__/unit/evaluator-parity.test.ts) and the in-process provider's.
 */

export interface RuleMatchingEvaluation {
  context: EvaluationContext;
  value: FlagValue;
  reason: string;
  /** Absent when the result names no variant. */
  variant?: string;
}

export interface RuleMatchingCase {
  name: string;
  flag: FlagConfig;
  evaluations: RuleMatchingEvaluation[];
}

export type RuleMatchingForm = "as written" | "as the data plane encodes it";

export interface RuleMatchingSuite extends RuleMatchingCase {
  /** The case's flag in each form. */
  forms: Array<[form: RuleMatchingForm, flag: FlagConfig]>;
}

/**
 * Every case with both forms of its flag. `read` returns the text of a file in
 * this directory. A case the Go-encoded file lacks is an error: regenerate it
 * with `UPDATE_RULE_MATCHING_GO_WIRE=1 go test ./evaluator -run
 * TestRuleMatchingGoWireForm` (in services/flaggr-api).
 */
export function loadRuleMatchingSuites(read: (file: string) => string): RuleMatchingSuite[] {
  const { cases } = JSON.parse(read("rule-matching-cases.json")) as { cases: RuleMatchingCase[] };
  const { flags } = JSON.parse(read("rule-matching-cases.go-wire.json")) as { flags: Record<string, FlagConfig> };
  return cases.map((c) => {
    const encoded = flags[c.name];
    if (!encoded) {
      throw new Error(
        `rule-matching-cases.go-wire.json has no flag for "${c.name}": regenerate it with UPDATE_RULE_MATCHING_GO_WIRE=1 go test ./evaluator -run TestRuleMatchingGoWireForm (in services/flaggr-api)`
      );
    }
    return {
      ...c,
      forms: [
        ["as written", c.flag],
        ["as the data plane encodes it", encoded],
      ],
    };
  });
}
