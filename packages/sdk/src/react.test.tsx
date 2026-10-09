// @vitest-environment jsdom

import React, { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FlaggrProvider,
  useBooleanFlag,
  useFlag,
  useFlaggr,
  useObjectFlag,
  useRefreshFlags,
  useStringFlag,
} from "./react";
import type { EvaluationContext, FlaggrClientInstance, FlaggrConfig, FlaggrPlugin } from "./types";

// React's act() warns unless the environment says it's a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

/** Render into a fresh container, effects included. */
function mount(node: ReactNode): void {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root!.render(node));
}

function unmount(): void {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
}

const text = (testId: string) => container?.querySelector(`[data-testid="${testId}"]`)?.textContent;

afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/** A 200 text/event-stream response whose body the test writes. */
function sseResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  return { response, send: (chunk: string) => controller.enqueue(encoder.encode(chunk)) };
}

/**
 * The data plane: every stream request (with its abort signal), batch
 * refreshes, and evaluations, which answer `hero` off.
 */
function dataPlane() {
  const streams: Array<{ signal: AbortSignal; send(chunk: string): void }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/api/flags/stream")) {
      const stream = sseResponse();
      streams.push({ signal: init!.signal!, send: stream.send });
      return stream.response;
    }
    if (String(url).endsWith("/api/flags/evaluate/batch")) {
      const { flagKeys = [] } = JSON.parse(String(init?.body)) as { flagKeys?: string[] };
      return jsonResponse({
        flags: Object.fromEntries(flagKeys.map((flagKey) => [flagKey, { flagKey, value: false, reason: "DEFAULT" }])),
      });
    }
    return jsonResponse({ value: false, reason: "DEFAULT" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    open: () => streams.filter((stream) => !stream.signal.aborted),
    batchBodies: () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/api/flags/evaluate/batch"))
        .map(([, init]) => JSON.parse(String(init?.body)) as { flagKeys: string[] }),
  };
}

const HERO_ON =
  'event: configuration_sync\ndata: {"type":"configuration_sync","version":"v1",' +
  '"flags":[{"key":"hero","type":"boolean","enabled":true,"defaultValue":true}]}\n\n';

const STREAM: FlaggrConfig = {
  apiUrl: "https://flaggr.test",
  serviceId: "web",
  apiKey: "fgr_key",
  updateMode: "stream",
};

/** Let pending fetch answers, and the renders they cause, happen (inside act). */
const settle = (ms = 20) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Settle until `check` passes (or give up after about a second). */
async function until(check: () => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await settle(10);
    try {
      check();
      return;
    } catch (error) {
      if (attempt >= 100) throw error;
    }
  }
}

let seen: FlaggrClientInstance | undefined;
function Hero() {
  seen = useFlaggr();
  const on = useBooleanFlag("hero", false);
  return <p data-testid="hero">{on ? "on" : "off"}</p>;
}

describe("FlaggrProvider", () => {
  it("ends React StrictMode's mount, unmount and mount with a started client: its stream is open and reaches the hooks", async () => {
    const plane = dataPlane();
    mount(
      <StrictMode>
        <FlaggrProvider config={STREAM}>
          <Hero />
        </FlaggrProvider>
      </StrictMode>
    );
    await until(() => expect(plane.open()).toHaveLength(1));
    await settle(); // the hooks' own evaluations are answered (off)
    expect(text("hero")).toBe("off");

    plane.open()[0].send(HERO_ON);

    await until(() => expect(text("hero")).toBe("on"));
    expect(seen!.getConnectionState()).toBe("connected");
    expect(seen!.getUpdateMode()).toBe("stream");
    // StrictMode's unmount destroyed the first started client (before its
    // stream went out, or closing it); a render React threw away started none.
    expect(plane.open()).toHaveLength(1);
  });

  it("keeps the batch timer of the client the tree uses running under StrictMode", async () => {
    const plane = dataPlane();
    mount(
      <StrictMode>
        <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web", updateMode: "batch", batchIntervalMs: 25 }}>
          <Hero />
        </FlaggrProvider>
      </StrictMode>
    );

    // The watched flag is refreshed every 25 ms.
    await until(() => expect(plane.batchBodies().length).toBeGreaterThanOrEqual(2));
    expect(plane.batchBodies()[0].flagKeys).toEqual(["hero"]);
  });

  it("starts one client without StrictMode, and unmounting destroys it", async () => {
    const plane = dataPlane();
    mount(
      <FlaggrProvider config={STREAM}>
        <Hero />
      </FlaggrProvider>
    );
    await until(() => expect(plane.open()).toHaveLength(1));
    await settle();
    expect(plane.fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/flags/stream"))).toHaveLength(1);

    unmount();
    expect(plane.open()).toHaveLength(0);
    // A destroyed client ignores a mode switch.
    seen!.setUpdateMode("poll");
    expect(seen!.getUpdateMode()).toBe("stream");
  });

  it("re-renders the hooks with what useRefreshFlags found changed", async () => {
    const values: Record<string, string> = { promo: "spring" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { flagKey?: string; flags?: Array<{ key: string }> };
        if (String(url).endsWith("/batch")) {
          return jsonResponse({ flags: body.flags!.map(({ key }) => ({ key, value: values[key], reason: "STATIC" })) });
        }
        return jsonResponse({ value: values[body.flagKey!], reason: "STATIC" });
      })
    );
    let refresh!: () => Promise<void>;
    function Promo() {
      refresh = useRefreshFlags();
      return <p data-testid="promo">{useStringFlag("promo", "none")}</p>;
    }
    mount(
      <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web" }}>
        <Promo />
      </FlaggrProvider>
    );
    await until(() => expect(text("promo")).toBe("spring"));

    values.promo = "summer";
    await act(() => refresh());

    expect(text("promo")).toBe("summer");
  });

  it("useObjectFlag takes an interface", async () => {
    interface Banner {
      text: string;
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ value: { text: "Sale" }, reason: "STATIC" })));
    function BannerView() {
      const banner: Banner = useObjectFlag<Banner>("banner", { text: "Welcome" });
      return <p data-testid="banner">{banner.text}</p>;
    }
    mount(
      <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web" }}>
        <BannerView />
      </FlaggrProvider>
    );
    expect(text("banner")).toBe("Welcome");
    await until(() => expect(text("banner")).toBe("Sale"));
  });
});

describe("hooks with a per-call context", () => {
  /**
   * The data plane answers `beta` to the targeting key admin-preview, else
   * `stable`, for evaluations and batches; `failing` batches answer 503.
   */
  function previewPlane() {
    const state = { failing: false, failed: 0, batches: 0 };
    const valueFor = (context?: EvaluationContext) => (context?.targetingKey === "admin-preview" ? "beta" : "stable");
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { context?: EvaluationContext; flagKeys?: string[] };
      if (String(url).endsWith("/api/flags/evaluate/batch")) {
        if (state.failing) {
          state.failed++;
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
        }
        state.batches++;
        const value = valueFor(body.context);
        return jsonResponse({
          flags: Object.fromEntries(body.flagKeys!.map((flagKey) => [flagKey, { flagKey, value, reason: "TARGETING_MATCH" }])),
        });
      }
      return jsonResponse({ value: valueFor(body.context), reason: "TARGETING_MATCH" });
    });
    vi.stubGlobal("fetch", fetchMock);
    return state;
  }

  let refresh!: () => Promise<void>;
  /** An admin's page previewing a flag for someone else. */
  function Preview() {
    seen = useFlaggr();
    refresh = useRefreshFlags();
    return <p data-testid="layout">{useFlag("layout", "none", { targetingKey: "admin-preview" })}</p>;
  }

  it("keeps its own value through useRefreshFlags: never the client's own context's", async () => {
    previewPlane();
    mount(
      <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web", context: { targetingKey: "me" } }}>
        <Preview />
      </FlaggrProvider>
    );
    await until(() => expect(text("layout")).toBe("beta"));

    await act(() => refresh());
    await settle();

    expect(text("layout")).toBe("beta");
  });

  it("keeps its own value across batch ticks, after a failed one too", async () => {
    const plane = previewPlane();
    mount(
      <FlaggrProvider
        config={{
          apiUrl: "https://flaggr.test",
          serviceId: "web",
          updateMode: "batch",
          batchIntervalMs: 20,
          context: { targetingKey: "me" },
        }}
      >
        <Preview />
      </FlaggrProvider>
    );
    await until(() => expect(text("layout")).toBe("beta"));

    plane.failing = true;
    await until(() => expect(plane.failed).toBeGreaterThanOrEqual(1));
    plane.failing = false;
    const before = plane.batches;
    await until(() => expect(plane.batches - before).toBeGreaterThanOrEqual(3));
    await settle();

    expect(text("layout")).toBe("beta");
  });

  it("keeps a hook on the client's own context and one with a per-call context apart", async () => {
    previewPlane();
    function Both() {
      refresh = useRefreshFlags();
      const own = useStringFlag("layout", "none");
      const preview = useStringFlag("layout", "none", { targetingKey: "admin-preview" });
      return <p data-testid="both">{`${own}/${preview}`}</p>;
    }
    mount(
      <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web", context: { targetingKey: "me" } }}>
        <Both />
      </FlaggrProvider>
    );
    await until(() => expect(text("both")).toBe("stable/beta"));

    await act(() => refresh());
    await settle();

    expect(text("both")).toBe("stable/beta");
  });

  it("takes a stream's configuration_sync for its own context", async () => {
    const plane = dataPlane();
    function Beta() {
      return <p data-testid="beta">{String(useFlag("beta", false, { targetingKey: "user-1" }))}</p>;
    }
    mount(
      <FlaggrProvider config={STREAM}>
        <Beta />
      </FlaggrProvider>
    );
    await until(() => expect(plane.open()).toHaveLength(1));
    await settle();
    expect(text("beta")).toBe("false");

    // A rule for user-1 only: the client's own context still gets false.
    plane.open()[0].send(
      'event: configuration_sync\ndata: {"type":"configuration_sync","version":"v2","flags":[{"key":"beta","type":"boolean",' +
        '"enabled":true,"defaultValue":false,"overrides":[{"identifiers":["user-1"],"value":true}]}]}\n\n'
    );

    await until(() => expect(text("beta")).toBe("true"));
  });
});

describe("hooks and value-less change events", () => {
  it("useFlag evaluates again on a change without a value (a control-plane flag-update): never undefined", async () => {
    let promo = "spring";
    let streamSend!: (chunk: string) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/flags/stream")) {
          const stream = sseResponse();
          streamSend = stream.send;
          return stream.response;
        }
        return jsonResponse({ value: promo, reason: "STATIC" });
      })
    );
    function Promo() {
      return <p data-testid="promo">{String(useFlag("promo", "none"))}</p>;
    }
    mount(
      <FlaggrProvider config={STREAM}>
        <Promo />
      </FlaggrProvider>
    );
    await until(() => expect(text("promo")).toBe("spring"));

    promo = "summer";
    streamSend('data: {"type":"flag-update","flagKey":"promo","eventType":"UPDATED"}\n\n');

    await until(() => expect(text("promo")).toBe("summer"));
  });
});

describe("hooks and answers arriving out of order", () => {
  it("keeps a newer value over an evaluation that answers after it", async () => {
    // The hook's own evaluation is slow; a refresh's batch answers first, with a newer value.
    let answerEvaluation!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/batch")) {
          const { flags } = JSON.parse(String(init?.body)) as { flags: Array<{ key: string }> };
          return Promise.resolve(jsonResponse({ flags: flags.map(({ key }) => ({ key, value: "summer", reason: "STATIC" })) }));
        }
        return new Promise<Response>((resolve) => (answerEvaluation = resolve));
      })
    );
    let refresh!: () => Promise<void>;
    function Promo() {
      refresh = useRefreshFlags();
      return <p data-testid="promo">{useStringFlag("promo", "none")}</p>;
    }
    mount(
      <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web" }}>
        <Promo />
      </FlaggrProvider>
    );
    await until(() => expect(answerEvaluation).toBeDefined());

    await act(() => refresh());
    expect(text("promo")).toBe("summer");
    // The evaluation the hook started first answers last, with what was true then.
    answerEvaluation(jsonResponse({ value: "spring", reason: "STATIC" }));
    await settle();

    expect(text("promo")).toBe("summer");
  });
});

describe("FlaggrProvider and plugins", () => {
  it("calls a plugin's onInit before any other hook, though children evaluate before the client starts", async () => {
    dataPlane();
    const calls: string[] = [];
    const plugin: FlaggrPlugin = {
      name: "recorder",
      onInit: () => void calls.push("onInit"),
      onEvaluate: (flagKey) => void calls.push(`onEvaluate:${flagKey}`),
      onEvaluateComplete: (flagKey) => void calls.push(`onEvaluateComplete:${flagKey}`),
    };
    mount(
      <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web", plugins: [plugin] }}>
        <Hero />
      </FlaggrProvider>
    );
    await until(() => expect(calls.filter((call) => call === "onEvaluateComplete:hero")).toHaveLength(2));

    expect(calls[0]).toBe("onInit");
    expect(calls.filter((call) => call === "onInit")).toHaveLength(1);
  });

  it("holds the children's first evaluations for the remote config: they ask with its default environment", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).includes("/api/sdk-config")
        ? jsonResponse({ defaultEnvironment: "staging" })
        : jsonResponse({ value: true, reason: "STATIC" })
    );
    vi.stubGlobal("fetch", fetchMock);
    mount(
      <FlaggrProvider config={{ apiUrl: "https://flaggr.test", serviceId: "web", remoteConfig: true }}>
        <Hero />
      </FlaggrProvider>
    );
    await until(() => expect(text("hero")).toBe("on"));

    const evaluations = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/flags/evaluate"));
    expect(evaluations.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(String(evaluations[0][1]?.body))).toMatchObject({ flagKey: "hero", environment: "staging" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/sdk-config");
  });
});
