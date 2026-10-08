import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventStreamParser,
  openEventStream,
  type EventStreamError,
  type ServerSentEvent,
} from "./event-stream";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function parse(chunks: string[]): { events: ServerSentEvent[]; retries: number[]; parser: EventStreamParser } {
  const events: ServerSentEvent[] = [];
  const retries: number[] = [];
  const parser = new EventStreamParser((event) => events.push(event), (ms) => retries.push(ms));
  for (const chunk of chunks) parser.push(chunk);
  return { events, retries, parser };
}

/** A 200 text/event-stream response whose body the test writes. */
function sseResponse(init: { status?: number; contentType?: string } = {}) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": init.contentType ?? "text/event-stream; charset=utf-8" },
  });
  return {
    response,
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    sendBytes: (bytes: Uint8Array) => controller.enqueue(bytes),
    end: () => controller.close(),
    fail: (error: Error) => controller.error(error),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("EventStreamParser", () => {
  it("parses named events, multi-line data, ids and comments", () => {
    const { events } = parse([
      ": keep-alive\n\n",
      "event: configuration_sync\nid: 7\ndata: {\"a\":1,\ndata: \"b\":2}\n\n",
      "data: plain\n\n",
    ]);
    expect(events).toEqual([
      { type: "configuration_sync", data: '{"a":1,\n"b":2}', lastEventId: "7" },
      { type: "message", data: "plain", lastEventId: "7" },
    ]);
  });

  it("accepts CRLF, LF and CR line ends, including a CRLF split across chunks", () => {
    const { events } = parse(["data: one\r\n\r\ndata: two\r", "\n\rdata: three\r\r", "data: four\n", "\n"]);
    expect(events.map((e) => e.data)).toEqual(["one", "two", "three", "four"]);
  });

  it("reassembles lines split across any chunk boundary", () => {
    const stream = "event: configuration_delta\ndata: {\"flags\":[{\"key\":\"hero\"}]}\n\n";
    const { events } = parse(stream.split(""));
    expect(events).toEqual([
      { type: "configuration_delta", data: '{"flags":[{"key":"hero"}]}', lastEventId: "" },
    ]);
  });

  it("strips exactly one space after the colon and treats a bare field name as an empty value", () => {
    const { events } = parse(["data:  two spaces\n\n", "data\n\n", "data:\n\n"]);
    expect(events.map((e) => e.data)).toEqual([" two spaces", "", ""]);
  });

  it("dispatches nothing for a blank line without data, and resets the event type", () => {
    const { events } = parse(["event: heartbeat\n\n", "data: x\n\n"]);
    expect(events).toEqual([{ type: "message", data: "x", lastEventId: "" }]);
  });

  it("keeps the last event id across events, ignores ids with NUL and commits an id without data", () => {
    const { events, parser } = parse(["id: 1\ndata: a\n\n", "data: b\n\n", "id: bad\u0000id\ndata: c\n\n", "id: 9\n\n"]);
    expect(events.map((e) => e.lastEventId)).toEqual(["1", "1", "1"]);
    expect(parser.lastEventId).toBe("9");
  });

  it("reports retry only for ASCII digits and ignores unknown fields", () => {
    const { events, retries } = parse(["retry: 1500\nretry: soon\nretry: 1e3\nfoo: bar\ndata: x\n\n"]);
    expect(retries).toEqual([1500]);
    expect(events).toHaveLength(1);
  });

  it("drops an event that is still missing its closing blank line at end()", () => {
    const { events, parser } = parse(["data: complete\n\n", "data: partial\n"]);
    parser.end();
    parser.push("\n");
    expect(events.map((e) => e.data)).toEqual(["complete"]);
  });
});

describe("openEventStream", () => {
  it("sends the key in the Authorization header, never the URL, and delivers events", async () => {
    const stream = sseResponse();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => stream.response);
    const events: ServerSentEvent[] = [];
    const onOpen = vi.fn();

    const handle = openEventStream({
      url: "https://flaggr.test/api/flags/stream?serviceId=web",
      headers: () => ({ Authorization: "Bearer fgr_secret" }),
      onOpen,
      onEvent: (event) => events.push(event),
      fetch: fetchMock,
    });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://flaggr.test/api/flags/stream?serviceId=web");
    expect(url).not.toContain("fgr_secret");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Accept: "text/event-stream", Authorization: "Bearer fgr_secret" });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    stream.send('event: configuration_sync\ndata: {"flags":[]}\n\n');
    stream.send("data: hello\n\n");
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]).toMatchObject({ type: "configuration_sync", data: '{"flags":[]}' });
    expect(events[1]).toMatchObject({ type: "message", data: "hello" });
    handle.close();
  });

  it("decodes UTF-8 characters split across chunks", async () => {
    const stream = sseResponse();
    const events: ServerSentEvent[] = [];
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: (event) => events.push(event),
      fetch: async () => stream.response,
    });
    const bytes = new TextEncoder().encode("data: café 🚀\n\n");
    for (const byte of bytes) stream.sendBytes(new Uint8Array([byte]));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].data).toBe("café 🚀");
    handle.close();
  });

  it("reconnects with backoff after a network error and after the stream ends", async () => {
    vi.useFakeTimers();
    const streams = [sseResponse(), sseResponse()];
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(streams[0].response)
      .mockResolvedValueOnce(streams[1].response);
    const errors: EventStreamError[] = [];
    const events: string[] = [];

    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: (event) => events.push(event.data),
      onError: (error) => errors.push(error),
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([
      expect.objectContaining({ fatal: false, willRetry: true, attempt: 1, retryInMs: 1000 }),
    ]);
    expect(errors[0].status).toBeUndefined();

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    streams[0].send("data: first\n\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["first"]);

    // The server ends the stream (e.g. its max duration): reconnect, and the
    // received event reset the failure count, so the delay starts over.
    streams[0].end();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[1]).toEqual(
      expect.objectContaining({ fatal: false, willRetry: true, attempt: 1, retryInMs: 1000, message: "Stream ended" })
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    handle.close();
  });

  it("doubles the delay for consecutive failures up to the cap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const delays: Array<number | undefined> = [];
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => delays.push(error.retryInMs),
      reconnect: { initialDelayMs: 1000, maxDelayMs: 5000 },
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(delays).toEqual([1000, 2000, 4000, 5000]);
    handle.close();
  });

  it("uses the server's retry: value as the base delay", async () => {
    vi.useFakeTimers();
    const stream = sseResponse();
    const fetchMock = vi.fn().mockResolvedValueOnce(stream.response).mockResolvedValue(sseResponse().response);
    const errors: EventStreamError[] = [];
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(0);
    stream.send("retry: 5000\ndata: x\n\n");
    stream.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0].retryInMs).toBe(5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    handle.close();
  });

  it.each([401, 403, 400, 404])("treats HTTP %i as fatal: no reconnect", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status }));
    const errors: EventStreamError[] = [];
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([
      expect.objectContaining({ status, fatal: true, willRetry: false, attempt: 1 }),
    ]);
    expect(errors[0].retryInMs).toBeUndefined();
    expect(handle.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 408, 429])("retries HTTP %i", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("", { status }));
    const errors: EventStreamError[] = [];
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0]).toEqual(expect.objectContaining({ status, fatal: false, willRetry: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    handle.close();
  });

  it("treats a 200 that isn't text/event-stream as fatal", async () => {
    const errors: EventStreamError[] = [];
    openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      fetch: async () => new Response("<html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ status: 200, fatal: true, willRetry: false });
  });

  it("treats a runtime that can't stream a body as fatal", async () => {
    const errors: EventStreamError[] = [];
    const bodyless = { status: 200, headers: new Headers({ "Content-Type": "text/event-stream" }), body: null };
    openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      fetch: async () => bodyless as unknown as Response,
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ fatal: true, willRetry: false });
  });

  it("fails fatally without fetch", async () => {
    vi.stubGlobal("fetch", undefined);
    const errors: EventStreamError[] = [];
    openEventStream({ url: "https://flaggr.test/s", onEvent: () => undefined, onError: (e) => errors.push(e) });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ fatal: true, willRetry: false });
  });

  it("gives up after maxRetries consecutive failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const errors: EventStreamError[] = [];
    openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      reconnect: { maxRetries: 2 },
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errors.map((e) => [e.attempt, e.willRetry, e.fatal])).toEqual([
      [1, true, false],
      [2, true, false],
      [3, false, false],
    ]);
  });

  it("leaves retrying to the caller with reconnect: false", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    const errors: EventStreamError[] = [];
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      reconnect: false,
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([expect.objectContaining({ status: 503, fatal: false, willRetry: false })]);
    expect(handle.closed).toBe(true);
  });

  it("sends Last-Event-ID when it reconnects after the server sent an id", async () => {
    vi.useFakeTimers();
    const first = sseResponse();
    const fetchMock = vi
      .fn(async (_url: string, _init: RequestInit) => sseResponse().response)
      .mockResolvedValueOnce(first.response);
    const handle = openEventStream({ url: "https://flaggr.test/s", onEvent: () => undefined, fetch: fetchMock });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Last-Event-ID");
    first.send("id: 42\ndata: x\n\n");
    first.end();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ "Last-Event-ID": "42" });
    handle.close();
  });

  it("reads headers for every attempt, so a refreshed key is used", async () => {
    vi.useFakeTimers();
    let key = "fgr_old";
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 503 }));
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      headers: () => ({ Authorization: `Bearer ${key}` }),
      onEvent: () => undefined,
      fetch: fetchMock,
    });
    await vi.advanceTimersByTimeAsync(0);
    key = "fgr_new";
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual([
      "Bearer fgr_old",
      "Bearer fgr_new",
    ]);
    handle.close();
  });

  it("close() aborts the open stream and cancels a pending reconnect; nothing fires afterwards", async () => {
    vi.useFakeTimers();
    const stream = sseResponse();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => stream.response);
    const onEvent = vi.fn();
    const onError = vi.fn();
    const handle = openEventStream({ url: "https://flaggr.test/s", onEvent, onError, fetch: fetchMock });
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;

    handle.close();
    expect(handle.closed).toBe(true);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Closing during the backoff wait cancels the reconnect.
    const failing = vi.fn(async () => new Response("", { status: 503 }));
    const second = openEventStream({ url: "https://flaggr.test/s", onEvent, fetch: failing });
    await vi.advanceTimersByTimeAsync(0);
    second.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("keeps streaming when a listener throws", async () => {
    const stream = sseResponse();
    const seen: string[] = [];
    const handle = openEventStream({
      url: "https://flaggr.test/s",
      onEvent: (event) => {
        seen.push(event.data);
        if (event.data === "boom") throw new Error("listener bug");
      },
      fetch: async () => stream.response,
    });
    stream.send("data: boom\n\ndata: after\n\n");
    await vi.waitFor(() => expect(seen).toEqual(["boom", "after"]));
    await flush();
    expect(handle.closed).toBe(false);
    handle.close();
  });

  it("never calls back synchronously, even when fetch throws synchronously", () => {
    const onError = vi.fn();
    openEventStream({
      url: "https://flaggr.test/s",
      onEvent: () => undefined,
      onError,
      reconnect: false,
      fetch: () => {
        throw new TypeError("bad url");
      },
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
