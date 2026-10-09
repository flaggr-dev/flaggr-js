# @flaggr/sdk

[![npm](https://img.shields.io/npm/v/@flaggr/sdk)](https://www.npmjs.com/package/@flaggr/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

TypeScript SDK for [Flaggr](https://flaggr.dev) — type-safe feature flag evaluation with React hooks and OpenTelemetry instrumentation.

## Installation

```bash
npm install @flaggr/sdk
```

## Quick Start

```typescript
import { createFlaggr } from '@flaggr/sdk'

const client = createFlaggr({
  serviceId: 'web-app',
  apiKey: 'fgr_your_token',
  environment: 'production',
})

const isEnabled = await client.getBooleanValue('checkout-v2', false)
```

Set `environment`: without it, `https://api.flaggr.dev` (the default `apiUrl`) evaluates in `production`, while the control plane at `https://flaggr.dev` evaluates in `development`.

## Script tag

The browser bundle (`dist/browser.global.js`) sets up a global `flaggr` from the tag's `data-*` attributes:

```html
<script src="https://cdn.flaggr.dev/sdk.js"
        data-service-id="web-app"
        data-api-key="fgr_your_token"
        data-api-url="https://api.flaggr.dev"
        data-environment="production"
        defer></script>
<script type="module">
  const enabled = await flaggr.flag('checkout-v2', false)
</script>
```

`https://cdn.flaggr.dev/sdk.js` serves the release Flaggr has pinned for it, whatever npm tags `latest` (a new npm release reaches it only once Flaggr adds it); `https://cdn.jsdelivr.net/npm/@flaggr/sdk@0/dist/browser.global.js` serves the newest 0.x release. [`https://cdn.flaggr.dev/manifest.json`](https://cdn.flaggr.dev/manifest.json) shows the version `/sdk.js` serves (`latest["/sdk.js"]`) and lists pinned copies with Subresource Integrity hashes. From 0.5.0, `data-api-url` is optional and defaults to `https://api.flaggr.dev`; 0.4.0 needs it, or it sends evaluations to `<page>/undefined/api/flags/evaluate`.

Other attributes: `data-update-mode`, `data-remote-config`, `data-telemetry` and `data-expose-flags="false"`. See the [script tag docs](https://flaggr.dev/docs/sdk/typescript-sdk#script-tag).

## Streaming

`updateMode: "stream"` (or `enableStreaming: true`) with an `apiKey` streams flag configuration over `fetch` with the key in the `Authorization` header, never in the URL. Evaluation then runs locally from the streamed configuration, with no network round trip (flags using operators the data plane doesn't implement are still evaluated remotely). Local evaluation uses `@flaggr/evaluator` 0.3.0: a targeting rule with no conditions matches everyone (deployments of `api.flaggr.dev` from before Flaggr 0.5.0 match it to nobody), a context without a `targetingKey` is never in a rollout below 100%, and a field the data plane sends as `null`, such as an unset `rolloutPercentage`, is unset. The SDK reconnects with backoff, and if the stream refuses the key (401/403) it polls watched flags every `batchIntervalMs` instead. Keyless clients use `EventSource`, which works only for public demo services with `apiUrl: "https://flaggr.dev"`: the data plane answers 401 to a stream without a key, and the client then polls watched flags every `batchIntervalMs`, as it does where `EventSource` doesn't exist. Call `client.destroy()` when you're done with a streaming client, including on the server (Node 18+).

## React

```tsx
import { FlaggrProvider, useBooleanFlag } from '@flaggr/sdk/react'

function App() {
  return (
    <FlaggrProvider apiKey="fgr_xxx" serviceId="web-app" environment="production">
      <Checkout />
    </FlaggrProvider>
  )
}

function Checkout() {
  const useNewFlow = useBooleanFlag('checkout-v2', false)
  return useNewFlow ? <CheckoutV2 /> : <CheckoutClassic />
}
```

`FlaggrProvider` also takes a `config` object with any `createFlaggr` option; when you pass the `serviceId` prop, the `apiKey`, `serviceId` and `environment` props override the same fields in it. Hooks return the flag's value.

In the Next.js App Router, `@flaggr/sdk/react` starts with a `'use client'` directive, so a Server Component can render `FlaggrProvider` with serializable props. Its props reach the browser, so give it only a key that's safe there. Render it from a `'use client'` file (such as `app/providers.tsx`) when `config` holds functions such as `plugins`, and call the hooks in Client Components. `NEXT_PUBLIC_FLAGGR_*` values set at build time reach browser bundles. See [React hooks](https://flaggr.dev/docs/sdk/react-hooks#nextjs-app-router).

## Browser analytics

In a browser, the client publishes the flag values it resolves for [Flaggr browser analytics](https://flaggr.dev/docs/guides/browser-analytics), so every event the analytics script sends is tagged with the variants the page is using. Values are merged into `window.__FLAGGR_FLAGS__`, keeping keys that other code put there, and each burst of changes is announced with one `flaggr:flags-changed` event. If other code replaces or deletes the map, each value of the client's that went missing is put back the next time the client evaluates any flag. A key the new map holds with another value is left as it is. When the client publishes before anything else has, it starts from the server-rendered `window.__FLAGGR_BOOTSTRAP__` values, by the same rules as its own.

- What's published is a copy of each value as it was resolved: changes your code makes to the object afterwards never reach the page, even when the value is put back. Object and array values are published by variant name when the evaluation has one. Values over 1,024 characters of JSON, and values that can't be serialized, aren't published. `_flaggr_analytics` is always published in full.
- Fallbacks aren't published: a failed evaluation, a flag that doesn't exist, or your `defaultValue` before anything has loaded. A failed evaluation leaves the value published before it.
- A flag that no longer exists is taken off the page: when an evaluation reports it missing (the data plane's `FLAG_NOT_FOUND`), the stream reports it deleted, or a configuration from the stream no longer has it.
- Values evaluated for someone else aren't published: when the client has a `targetingKey`, a per-call context that gives another one, or clears it (`{ targetingKey: undefined }`). A client without a `targetingKey` publishes values evaluated with any per-call `targetingKey`, and the latest one wins. On pages that evaluate flags for other users, such as an admin's "preview as customer" list, give the client the page user's `targetingKey` (`FlaggrProvider`'s `config.context`), or set `exposeFlags: false`.
- After `setContext`, the flags the client published for its own context, and the ones you watch with `onFlagChange`, are republished for the new context at once when the client can evaluate them locally. The rest are republished when the page next evaluates them: flags only the data plane can evaluate, and flags the page evaluated with a per-call context. A remote result for an evaluation called before `setContext` isn't published or cached.
- Nothing is published on a server (including one with a DOM shim), in a worker, or anywhere else without a working DOM.

Turn it off for one client with `exposeFlags: false`, or for the whole page with `data-expose-flags="false"` on any script tag: it applies to every client created while that tag is on the page. With the script-tag bundle it also applies after the tag is gone, if the tag was there when the bundle loaded. A client's own `exposeFlags` setting overrides the attribute.

```typescript
const client = createFlaggr({ serviceId: 'web-app', apiKey: 'fgr_xxx', exposeFlags: false })
```

```html
<script src="https://cdn.flaggr.dev/sdk.js" data-service-id="web-app" data-api-key="fgr_xxx"
        data-api-url="https://api.flaggr.dev" data-expose-flags="false" defer></script>
```

## OpenTelemetry

```typescript
import { createFlaggr } from '@flaggr/sdk'
import { otelPlugin } from '@flaggr/sdk/otel'

const client = createFlaggr({
  serviceId: 'web-app',
  apiKey: 'fgr_xxx',
  plugins: [otelPlugin()],
})
```

## Exports

| Entry Point | Description |
|-------------|-------------|
| `@flaggr/sdk` | Core client and evaluation methods |
| `@flaggr/sdk/react` | React hooks and provider |
| `@flaggr/sdk/otel` | OpenTelemetry instrumentation plugin |

## Documentation

- [TypeScript SDK docs](https://flaggr.dev/docs/sdk/typescript-sdk)
- [React hooks](https://flaggr.dev/docs/sdk/react-hooks)
- [Quick Start](https://flaggr.dev/docs/getting-started/quick-start)
