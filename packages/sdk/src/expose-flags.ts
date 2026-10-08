/**
 * Publishes the flag values a page resolves, for Flaggr browser analytics
 * (`https://cdn.flaggr.dev/a.js`, packages/analytics). The script tags every
 * event with a map of flag key → value, which it reads from
 * `window.__FLAGGR_FLAGS__` (falling back to `window.__FLAGGR_BOOTSTRAP__`,
 * the server-rendered `{ key: { value } }` map) and then replaces with the
 * `detail` of each `flaggr:flags-changed` event. So each event dispatched
 * here carries the full map, never a delta.
 *
 * Each value is published as a detached JSON copy of what Flaggr resolved,
 * taken when a client first queues it, so code that changes an object the
 * SDK returned can't change or break the published map, then or when the
 * value is put back later. The script derives a variant string from
 * whatever it finds, so an object or array value goes out as its variant
 * name when the evaluation has one, and a value over MAX_JSON characters of
 * JSON, or one that can't be serialized, is kept off the page: the script
 * sends the whole map with every event. `_flaggr_analytics` is always
 * published in full, since the script reads its level string or config
 * object to set what it collects.
 *
 * See `FlaggrConfig.exposeFlags` for which values a client publishes.
 */

type FlagsWindow = {
  __FLAGGR_FLAGS__?: Record<string, unknown>;
  __FLAGGR_BOOTSTRAP__?: Record<string, { value?: unknown } | undefined>;
};

/** The flag the analytics script reads its collection settings from. */
const ANALYTICS_FLAG = "_flaggr_analytics";
/** Longest value published, in UTF-16 characters of JSON (1 KB of ASCII). */
const MAX_JSON = 1024;
/** Script tags that keep flag values off the page. */
const OPT_OUT = 'script[data-expose-flags="false"]';

/** Values waiting for the next flush, by flag key (last write wins). */
let pending: Map<string, unknown> | undefined;
/** The records (see exposeFlag) of the clients that queued them. */
let queuedBy: Set<Map<string, unknown>> | undefined;
/** Keys whose latest value was kept off the page: too big, unserializable, or a deleted flag's. */
const withheld = new Set<string>();
/** The page's map as each client's record (see exposeFlag) last saw it. */
const seen = new WeakMap<Map<string, unknown>, unknown>();
/**
 * Each object value's JSON as a client first queued it: what Flaggr
 * resolved, whatever the app did to the object since. Undefined when it
 * can't be published (unserializable, or too big for the key it was queued
 * under), so the page never holds on to the JSON of a value it won't send.
 */
const copies = new WeakMap<object, string | undefined>();
/** Whether an opt-out tag was on the page when the browser bundle loaded. */
let optedOutAtLoad = false;

/**
 * Whether `map` has `key` as its own property: a flag keyed `constructor`
 * or `toString` isn't on the page just because every object inherits one.
 * Throws only for an exotic map, such as a revoked Proxy.
 */
function has(map: unknown, key: string): boolean {
  return {}.hasOwnProperty.call(Object(map), key);
}

/**
 * Whether a new client publishes: as its `exposeFlags` option says when
 * that's set, otherwise yes unless a script tag on the page has
 * `data-expose-flags="false"`, or had one when the browser bundle loaded
 * (see recordOptOut).
 *
 * Never outside a browser page: on a server, in a worker or in another
 * runtime without a DOM, and also on a server that installs a DOM shim. In
 * a page, `window` is the global object, while domino and global-jsdom
 * hang a separate window object on Node's global. happy-dom's global
 * registrator does make `window` the global object, so it's recognised by
 * the `happyDOM` global it adds. jsdom test environments (vitest, jest)
 * make `window` the global object too, so they count as a page. Neither is
 * a runtime where `window` is the global object without a working DOM
 * (Deno 1.x, hand-rolled test globals, a `document` stub).
 */
export function shouldExpose(option?: boolean): boolean {
  try {
    if ((globalThis.window as unknown) !== globalThis || "happyDOM" in globalThis) {
      return false;
    }
    // Throws without a working DOM: no document, or a stub without querySelector.
    const optedOut = document.querySelector(OPT_OUT) || optedOutAtLoad;
    return option ?? !optedOut;
  } catch {
    // Not a page, and creating a client must never fail over analytics glue.
    return false;
  }
}

/**
 * Remember, as the browser bundle loads, whether a script tag on the page
 * has `data-expose-flags="false"`. The script-tag client is created at the
 * first `flaggr.flag()`, and by then a loader may have removed the bundle's
 * own tag, or a single-page app swapped the document's head or body.
 */
export function recordOptOut(): void {
  try {
    optedOutAtLoad = !!document.querySelector(OPT_OUT);
  } catch {
    // No working DOM: nothing to record, and shouldExpose says no anyway.
  }
}

/**
 * Queue a value one client resolved for the page. `last` is that client's
 * record of the value it queued per key. A value the client already queued
 * is skipped only while its key is still on the page (or was deliberately
 * kept off it), so repeat evaluations cost a lookup and two clients can't
 * keep overwriting each other. When other code has replaced (or deleted)
 * the map, every value of this client's that the new map dropped is put
 * back, whichever flag is being evaluated; a key the new map holds with
 * another value is left as it is, and so is one the client forgot (see
 * forgetFlags). Every value queued in the same burst of synchronous work is
 * written in one microtask, followed by at most one `flaggr:flags-changed`
 * event.
 */
export function exposeFlag(
  last: Map<string, unknown>,
  key: string,
  value: unknown,
  variant?: string
): void {
  try {
    if (key !== ANALYTICS_FLAG && variant && typeof value === "object") {
      value = variant;
    }
    const map = (window as unknown as FlagsWindow).__FLAGGR_FLAGS__;
    if (seen.get(last) !== map) {
      // A map this client hasn't seen: another client's flush, or other
      // code replacing (or deleting) it, such as glue written for SDK 0.4.0
      // or the OpenFeature web provider.
      seen.set(last, map);
      for (const [k, v] of last) {
        if (v !== undefined && !withheld.has(k) && !has(map, k)) queue(last, k, v);
      }
    }
    if (last.get(key) === value && (withheld.has(key) || has(map, key))) return;
    last.set(key, value);
    queue(last, key, value);
  } catch {
    // Analytics glue must never break flag evaluation: a map that can't be
    // read (a revoked Proxy, a throwing getter) just isn't written to.
  }
}

/**
 * A client's context changed: forget the values it published, keeping
 * their keys. Each key's next value is then published even when it's the
 * same as before, none of them is put back after other code replaces the
 * map, and withdrawFlag can still take any of them off the page.
 */
export function forgetFlags(last: Map<string, unknown>): void {
  for (const key of last.keys()) last.set(key, undefined);
}

/**
 * Take a flag a client published (with its current context or an earlier
 * one) off the page: the flag no longer exists. Kept off the page like a
 * value too big to publish, so no client puts an older value back.
 */
export function withdrawFlag(last: Map<string, unknown>, key: string): void {
  if (last.delete(key)) queue(last, key, undefined);
}

/** Add a client's value to the next flush, scheduling one when none is pending. */
function queue(last: Map<string, unknown>, key: string, value: unknown): void {
  if (!pending) {
    pending = new Map();
    queuedBy = new Set();
    queueMicrotask(flush);
  }
  // Copied now, as resolved: by the flush, the app may have changed it.
  if (value && typeof value === "object" && !copies.has(value)) {
    const json = toJSON(value);
    copies.set(value, fits(key, json) ? json : undefined);
  }
  pending.set(key, value);
  queuedBy!.add(last);
}

/** The value as JSON, or undefined when it can't be serialized. */
function toJSON(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Whether a value, as JSON, goes on the page: one that could be serialized,
 * and no longer than MAX_JSON unless it's `_flaggr_analytics`.
 */
function fits(key: string, json: string | undefined): json is string {
  return !!json && (json.length <= MAX_JSON || key === ANALYTICS_FLAG);
}

/**
 * Merge the queued values into a copy of `window.__FLAGGR_FLAGS__`, keeping
 * every key someone else put there, and announce the new map, but only when
 * something actually changed.
 */
function flush(): void {
  const updates = pending!;
  const clients = queuedBy!;
  pending = queuedBy = undefined;
  try {
    const w = window as unknown as FlagsWindow;
    const start = w.__FLAGGR_FLAGS__;
    let flags = start;
    let changed = false;
    const boot = !flags && w.__FLAGGR_BOOTSTRAP__;
    if (boot) {
      // Nothing published yet: start from the server-rendered values the
      // script reads until __FLAGGR_FLAGS__ exists, so they aren't lost.
      // The same rules as the SDK's own values: copies, within the size
      // limit, and not a key whose latest value was kept off the page.
      flags = {};
      for (const key of Object.keys(boot)) {
        const json = withheld.has(key) ? undefined : toJSON(boot[key]?.value ?? boot[key]);
        if (fits(key, json)) flags[key] = JSON.parse(json);
        // Left out, so the map differs from the values the script read.
        else changed = true;
      }
    }
    flags = { ...flags };
    for (const [key, value] of updates) {
      const json = value && typeof value === "object" ? copies.get(value) : toJSON(value);
      if (!fits(key, json)) {
        // Kept off the page, and so is the older value it replaces: events
        // mustn't carry a value the page has moved on from.
        withheld.add(key);
        if (has(flags, key)) {
          delete flags[key];
          changed = true;
        }
      } else {
        withheld.delete(key);
        // By content: remote results and pushes bring new object instances.
        if (toJSON(flags[key]) !== json) {
          flags[key] = JSON.parse(json);
          changed = true;
        }
      }
    }
    // Also written when the server-rendered values only carried over, with
    // nothing to announce: the script reads the same values either way, and
    // the next evaluations find their keys on the page and stay a lookup.
    if (changed || boot) w.__FLAGGR_FLAGS__ = flags;
    // A client that had seen the map this flush started from has now seen
    // the one it leaves, which holds every value the client published (bar
    // those kept off the page), so its next evaluation notices any later
    // change, deleting the whole map included. One that hadn't (other code
    // swapped the map in between) takes a fresh look then: NaN is no map.
    for (const last of clients) {
      seen.set(last, seen.get(last) === start ? w.__FLAGGR_FLAGS__ : NaN);
    }
    if (changed) {
      window.dispatchEvent(new CustomEvent("flaggr:flags-changed", { detail: flags }));
    }
  } catch {
    // Analytics glue must never break flag evaluation or the page.
  }
}
