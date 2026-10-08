/**
 * Server-sent events over fetch.
 *
 * Browsers' EventSource can't send request headers, so an EventSource client
 * has to put its credential in the stream URL (?token=), where platform,
 * proxy and CDN request logs keep it. openEventStream reads the same
 * text/event-stream format over fetch, so the key travels in the
 * Authorization header instead. Flaggr's clients use it whenever an API key
 * is configured and keep EventSource for keyless streams.
 *
 * Like EventSource it handles event, data, id and retry fields and comments,
 * with CRLF, LF or CR line ends, and sends Last-Event-ID on reconnect once
 * the server has sent an id. (Flaggr's streams send no ids today, so that
 * header, which a CORS preflight would have to allow, never goes out.)
 * Unlike EventSource it tells the caller why a connection failed:
 *
 * - transient (a network error, the stream ending, 5xx, 408, 429): reconnects
 *   with exponential backoff (1 s doubling to 30 s by default, or from the
 *   server's retry: value), unless `reconnect: false` leaves that to the
 *   caller;
 * - fatal (401, 403 and other 4xx, a 200 that isn't text/event-stream, a
 *   runtime whose fetch can't stream a body): it stops for good, so the
 *   caller can fall back to polling.
 */

/** One dispatched server-sent event. */
export interface ServerSentEvent {
  /** The event's `event:` field, or "message" when it has none. */
  type: string;
  /** The event's `data:` lines, joined with "\n". */
  data: string;
  /** The stream's last event ID (the `id:` field), "" before any. */
  lastEventId: string;
}

/**
 * Incremental text/event-stream parser — the WHATWG "interpret an event
 * stream" steps. Feed it decoded text in any chunking with push(); call end()
 * when the body ends: an event still missing its closing blank line is
 * dropped, as EventSource drops it.
 */
export class EventStreamParser {
  /** Set from `id:` fields when an event is dispatched. */
  lastEventId: string;
  private idBuffer: string;
  /** Pieces of the current, unfinished line. */
  private line: string[] = [];
  /** The previous chunk ended in CR: an LF opening the next one belongs to it. */
  private afterCR = false;
  private data: string[] = [];
  private eventType = "";

  constructor(
    private readonly onEvent: (event: ServerSentEvent) => void,
    private readonly onRetry?: (ms: number) => void,
    lastEventId = ""
  ) {
    this.lastEventId = lastEventId;
    this.idBuffer = lastEventId;
  }

  push(text: string): void {
    let start = 0;
    if (this.afterCR) {
      this.afterCR = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      this.line.push(text.slice(start, i));
      const line = this.line.length === 1 ? this.line[0] : this.line.join("");
      this.line = [];
      if (code === 13) {
        if (i + 1 === text.length) this.afterCR = true;
        else if (text.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
      this.processLine(line);
    }
    if (start < text.length) this.line.push(text.slice(start));
  }

  /** The body ended: drop the unfinished line and event. */
  end(): void {
    this.line = [];
    this.afterCR = false;
    this.data = [];
    this.eventType = "";
  }

  private processLine(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ":" — a comment (keep-alive pings)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) this.idBuffer = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.onRetry?.(Number(value));
        break;
      default:
        break; // unknown fields are ignored
    }
  }

  private dispatch(): void {
    this.lastEventId = this.idBuffer;
    if (this.data.length === 0) {
      this.eventType = "";
      return;
    }
    const event: ServerSentEvent = {
      type: this.eventType || "message",
      data: this.data.join("\n"),
      lastEventId: this.lastEventId,
    };
    this.data = [];
    this.eventType = "";
    this.onEvent(event);
  }
}

/** Why a connection attempt failed or the stream dropped. */
export interface EventStreamError {
  /** HTTP status when the server answered (401, 403, 503, …). */
  status?: number;
  /**
   * Retrying can't help: an auth refusal or another 4xx (but 408 and 429), a
   * 200 that isn't text/event-stream, or a runtime that can't stream a body.
   */
  fatal: boolean;
  /** openEventStream reconnects after `retryInMs`; false means the stream is closed. */
  willRetry: boolean;
  /** Consecutive failed attempts, this one included (reset by a received event). */
  attempt: number;
  retryInMs?: number;
  message: string;
}

export interface EventStreamReconnect {
  /** First reconnect delay in ms, doubling per consecutive failure. Default 1000 (or the server's retry: value). */
  initialDelayMs?: number;
  /** Longest reconnect delay in ms. Default 30000. */
  maxDelayMs?: number;
  /** Consecutive failures to retry before giving up. Default: keep retrying. */
  maxRetries?: number;
}

export interface EventStreamOptions {
  url: string;
  /** Request headers (Authorization), read for every attempt so a refreshed key is used. */
  headers?: () => Record<string, string>;
  /** The server answered 200 text/event-stream. */
  onOpen?: () => void;
  onEvent: (event: ServerSentEvent) => void;
  onError?: (error: EventStreamError) => void;
  /** Reconnect policy; false makes every failure final and leaves retrying to the caller. */
  reconnect?: false | EventStreamReconnect;
  /** fetch to use. Default: the global fetch at call time. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** A running stream. */
export interface EventStream {
  /** Stop for good: aborts the open request and any pending reconnect. No callbacks follow. */
  close(): void;
  readonly closed: boolean;
}

/** The shortest reconnect delay, whatever the server's retry: says. */
const MIN_RETRY_MS = 250;

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function isEventStreamType(contentType: string | null | undefined): boolean {
  return !!contentType && contentType.split(";")[0].trim().toLowerCase() === "text/event-stream";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function discardBody(response: Response): void {
  try {
    const cancelled = response.body?.cancel();
    if (cancelled) cancelled.catch(() => undefined);
  } catch {
    // already locked or consumed
  }
}

/**
 * Open a server-sent event stream over fetch (see the module comment). The
 * first request goes out a microtask later; callbacks are never synchronous.
 */
export function openEventStream(options: EventStreamOptions): EventStream {
  const reconnect =
    options.reconnect === false
      ? null
      : {
          initialDelayMs: options.reconnect?.initialDelayMs ?? 1000,
          maxDelayMs: options.reconnect?.maxDelayMs ?? 30_000,
          maxRetries: options.reconnect?.maxRetries ?? Number.POSITIVE_INFINITY,
        };
  const doFetch = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  let closed = false;
  let attempt = 0;
  let lastEventId = "";
  let serverRetryMs: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopConnection: (() => void) | undefined;

  // A listener's error never breaks the stream.
  const safely = (callback: () => void) => {
    try {
      callback();
    } catch {
      // ignored
    }
  };

  const fail = (status: number | undefined, fatal: boolean, message: string) => {
    if (closed) return;
    stopConnection = undefined;
    attempt += 1;
    const willRetry = !fatal && reconnect !== null && attempt <= reconnect.maxRetries;
    const error: EventStreamError = { fatal, willRetry, attempt, message };
    if (status !== undefined) error.status = status;
    if (willRetry && reconnect) {
      const base = Math.max(serverRetryMs ?? reconnect.initialDelayMs, MIN_RETRY_MS);
      error.retryInMs = Math.min(reconnect.maxDelayMs, base * 2 ** (attempt - 1));
    } else {
      closed = true;
    }
    safely(() => options.onError?.(error));
    if (willRetry && !closed) {
      timer = setTimeout(() => {
        timer = undefined;
        connect().catch(() => undefined);
      }, error.retryInMs);
    }
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    if (!options.fetch && typeof fetch !== "function") {
      fail(undefined, true, "This runtime has no fetch");
      return;
    }
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    // The body reader, once there is one — close() cancels it too.
    const active: { reader?: ReadableStreamDefaultReader<Uint8Array> } = {};
    let stopped = false;
    stopConnection = () => {
      stopped = true;
      controller?.abort();
      active.reader?.cancel().catch(() => undefined);
    };

    let response: Response;
    try {
      const headers: Record<string, string> = { Accept: "text/event-stream", ...(options.headers?.() ?? {}) };
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;
      response = await doFetch(options.url, { method: "GET", headers, signal: controller?.signal });
    } catch (error) {
      if (!stopped) fail(undefined, false, `Stream connection failed: ${errorMessage(error)}`);
      return;
    }
    if (stopped) {
      if (response) discardBody(response);
      return;
    }
    if (!response || typeof response.status !== "number") {
      fail(undefined, true, "The stream request returned no response");
      return;
    }
    if (response.status !== 200) {
      discardBody(response);
      fail(response.status, !isRetryableStatus(response.status), `Stream refused: HTTP ${response.status}`);
      return;
    }
    if (!isEventStreamType(response.headers?.get("content-type"))) {
      discardBody(response);
      fail(response.status, true, "The stream answered with something other than text/event-stream");
      return;
    }
    const body = response.body;
    if (!body || typeof body.getReader !== "function" || typeof TextDecoder !== "function") {
      fail(response.status, true, "This runtime can't read a streaming response body");
      return;
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = body.getReader();
    } catch (error) {
      fail(response.status, true, `Can't read the stream body: ${errorMessage(error)}`);
      return;
    }
    active.reader = reader;
    const decoder = new TextDecoder();
    let received = false;
    const parser = new EventStreamParser(
      (event) => {
        if (stopped) return;
        if (!received) {
          received = true;
          attempt = 0;
        }
        safely(() => options.onEvent(event));
      },
      (ms) => {
        serverRetryMs = ms;
      },
      lastEventId
    );
    safely(() => options.onOpen?.());

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        if (value) parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      lastEventId = parser.lastEventId;
      if (!stopped) fail(undefined, false, `Stream interrupted: ${errorMessage(error)}`);
      return;
    }
    lastEventId = parser.lastEventId;
    if (stopped) return;
    parser.push(decoder.decode());
    parser.end();
    lastEventId = parser.lastEventId;
    fail(undefined, false, "Stream ended");
  };

  // Started a microtask later, so no callback runs before the caller holds the handle.
  Promise.resolve()
    .then(connect)
    .catch(() => undefined);

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      stopConnection?.();
      stopConnection = undefined;
    },
    get closed() {
      return closed;
    },
  };
}
