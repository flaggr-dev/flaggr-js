# Flaggr JavaScript SDK

[![CI](https://github.com/flaggr-dev/flaggr-js/actions/workflows/ci.yml/badge.svg)](https://github.com/flaggr-dev/flaggr-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@flaggr/sdk)](https://www.npmjs.com/package/@flaggr/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The TypeScript and JavaScript SDK for [Flaggr](https://flaggr.dev), an OpenFeature-compatible feature flag platform.

| Package | What it is |
|---------|------------|
| [`@flaggr/sdk`](packages/sdk) | The client SDK for browsers, Node.js and edge runtimes: typed flag evaluation, polling or streaming updates, React hooks (`@flaggr/sdk/react`), OpenTelemetry instrumentation (`@flaggr/sdk/otel`) and a script-tag bundle. |
| [`@flaggr/evaluator`](packages/evaluator) | The standalone, zero-dependency flag evaluator that the SDK uses for local evaluation. It evaluates targeting rules, percentage rollouts, variants, overrides and schedules the same way Flaggr's data plane does for the operators the data plane implements (`isLocallyEvaluable(flag)` tells you whether a flag uses only those). You can also use it on its own to evaluate flag configuration you already have. |

## Install

```bash
npm install @flaggr/sdk
```

Use `@flaggr/sdk` 0.5.0 or later. Until 0.5.0 is on npm (check with `npm view @flaggr/sdk version`), `npm install @flaggr/sdk` installs 0.4.0. That version can't be imported as an ES module, and loaded with `require()` it can't evaluate flags locally; 0.3.0 has the same problems. The script-tag bundle isn't affected.

## Usage

```typescript
import { createFlaggr } from '@flaggr/sdk'

const client = createFlaggr({
  serviceId: 'web-app',
  apiKey: process.env.FLAGGR_API_KEY,
  environment: 'production',
})

const checkoutV2 = await client.getBooleanValue('checkout-v2', false)
const plan = await client.getStringValue('pricing-page', 'monthly', { targetingKey: 'user-123' })
```

Set `environment` explicitly. Without it, `https://api.flaggr.dev` (the default `apiUrl`) evaluates in `production`, but `https://flaggr.dev` evaluates in `development`. Call `client.destroy()` when you no longer need a client that streams updates.

### React

```tsx
import { FlaggrProvider, useBooleanFlag } from '@flaggr/sdk/react'

function App() {
  return (
    <FlaggrProvider apiKey="fgr_your_token" serviceId="web-app" environment="production">
      <Checkout />
    </FlaggrProvider>
  )
}

function Checkout() {
  const useNewFlow = useBooleanFlag('checkout-v2', false)
  return useNewFlow ? <CheckoutV2 /> : <CheckoutClassic />
}
```

The [`@flaggr/sdk` README](packages/sdk/README.md) covers the script tag, streaming, browser analytics and OpenTelemetry.

### Evaluating locally with `@flaggr/evaluator`

```bash
npm install @flaggr/evaluator
```

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

result.value  // true
result.reason // "TARGETING_MATCH"
```

## Authentication

The SDK authenticates with a project API token (`fgr_…`). To create one, open your project's **Settings → API tokens** in the Flaggr console, then pass it as `apiKey`. Evaluating flags needs only the `read` permission.

Code that runs in a browser shows its token to anyone who loads the page, so give browser clients a token with only the `read` permission. Such a token can also read the project's flag configuration. Personal access tokens (`fgp_…`) can't evaluate flags.

If you don't call `configure()`, the one-line `flag()` helper reads `FLAGGR_SERVICE_ID`, `FLAGGR_API_KEY`, `FLAGGR_ENVIRONMENT` and `FLAGGR_API_URL` from `process.env`. See [API tokens](https://flaggr.dev/docs/api/tokens) for scopes and token management.

## Documentation

- [Flaggr docs](https://flaggr.dev/docs)
- [TypeScript SDK](https://flaggr.dev/docs/sdk/typescript-sdk)
- [React hooks](https://flaggr.dev/docs/sdk/react-hooks)
- [Quick start](https://flaggr.dev/docs/getting-started/quick-start)
- [Targeting rules](https://flaggr.dev/docs/guides/targeting-rules)

## Development

You need Node.js 20 or later. The packages are npm workspaces, so the SDK builds against the evaluator in this repository.

```bash
npm ci
npm run build   # builds @flaggr/evaluator, then @flaggr/sdk
npm test        # type-checks both packages, then runs the SDK's tests (Vitest)
```

## How this repository is maintained

This repository is synced from Flaggr's main repository at each release. New versions of `@flaggr/sdk` and `@flaggr/evaluator` are published to npm from the main repository, not from here. Issues and pull requests are welcome here. When we accept a change, we apply it in the main repository, and it comes back here with the next sync.

## Security

Please don't report security vulnerabilities in public issues. Report them privately with GitHub's [Report a vulnerability](https://github.com/flaggr-dev/flaggr-js/security/advisories/new) button, or email [security@flaggr.dev](mailto:security@flaggr.dev). See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
