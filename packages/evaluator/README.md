# @flaggr/evaluator

[![npm](https://img.shields.io/npm/v/@flaggr/evaluator)](https://www.npmjs.com/package/@flaggr/evaluator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Standalone flag evaluation engine for [Flaggr](https://flaggr.dev). Zero dependencies, pure TypeScript.

Use this package for **local/edge evaluation** when you want to evaluate feature flags without making API calls. The evaluation rules are cached locally and evaluated in-process for sub-millisecond latency.

## Installation

```bash
npm install @flaggr/evaluator
```

## Usage

```typescript
import { evaluateFlag } from '@flaggr/evaluator'

const result = evaluateFlag(
  {
    key: 'checkout-v2',
    type: 'boolean',
    enabled: true,
    defaultValue: false,
    targeting: [
      {
        id: 'enterprise-customers',
        conditions: [{ property: 'plan', operator: 'equals', value: 'enterprise' }],
        value: true,
      },
    ],
  },
  { targetingKey: 'user-123', plan: 'enterprise' },
)

console.log(result.value)  // true
console.log(result.reason) // "TARGETING_MATCH"
```

`evaluateFlags(flags, context)` evaluates a record of flags keyed by flag key, and `Evaluator.evaluate(flag, context)` is the same as `evaluateFlag`. Each result has a `value`, a `reason` and, when a variant was chosen, a `variant`.

## Features

- Zero dependencies
- Gives the same results as Flaggr's data plane for the operators it implements: equals, not_equals, in, not_in, contains, starts_with, ends_with, greater_than, less_than, gte, lte, regex, before and after. `isLocallyEvaluable(flag)` tells you whether a flag uses only these. It also evaluates exists and not_exists. Cohort operators need the server.
- Percentage rollouts with deterministic hashing
- Variant assignment for experiments
- Type-safe evaluation (boolean, string, number, object)

## Documentation

- [Advanced evaluation](https://flaggr.dev/docs/guides/advanced-evaluation)
- [Targeting rules](https://flaggr.dev/docs/guides/targeting-rules)
