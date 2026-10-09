import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Evaluator } from "../src";
import { loadRuleMatchingSuites } from "./rule-matching-cases";

/**
 * The shared rule-matching cases (rule-matching-cases.json), each flag as
 * written and as the Go data plane encodes it: the control plane's evaluator
 * (__tests__/unit/evaluator-parity.test.ts) and the Go data plane
 * (services/flaggr-api/evaluator/rule_matching_parity_test.go) are tested
 * against the same cases.
 */
const suites = loadRuleMatchingSuites((file) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));

describe("rule matching (shared cases)", () => {
  it("has cases", () => {
    expect(suites.length).toBeGreaterThan(0);
  });

  describe.each(suites.map((s) => [s.name, s] as const))("%s", (_name, { forms, evaluations }) => {
    describe.each(forms)("%s", (_form, flag) => {
      it.each(evaluations.map((e) => [JSON.stringify(e.context), e] as const))("context %s", (_context, evaluation) => {
        const result = Evaluator.evaluate(flag, evaluation.context);
        expect({ value: result.value, reason: result.reason, variant: result.variant }).toEqual({
          value: evaluation.value,
          reason: evaluation.reason,
          variant: evaluation.variant,
        });
      });
    });
  });
});
