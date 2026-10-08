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
import { evaluate } from '@flaggr/evaluator'

const result = evaluate({
  flag: {
    key: 'checkout-v2',
    type: 'boolean',
    enabled: true,
    defaultValue: false,
    targetingRules: [
      {
        conditions: [{ attribute: 'plan', operator: 'equals', value: 'enterprise' }],
        value: true,
      },
    ],
  },
  context: {
    targetingKey: 'user-123',
    plan: 'enterprise',
  },
})

console.log(result.value)  // true
console.log(result.reason) // "TARGETING_MATCH"
```

## Features

- Zero dependencies
- Supports all 16 targeting operators
- Percentage rollouts with deterministic hashing
- Variant assignment for experiments
- Type-safe evaluation (boolean, string, number, object)

## Documentation

- [Advanced evaluation](https://flaggr.dev/docs/guides/advanced-evaluation)
- [Targeting rules](https://flaggr.dev/docs/guides/targeting-rules)
