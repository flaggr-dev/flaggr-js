/**
 * Requests that outlive the page.
 *
 * A fetch with `keepalive: true` keeps going after the page is hidden or
 * unloaded, as navigator.sendBeacon does, but can carry headers (an
 * Authorization bearer: the browser sends the CORS preflight first). The
 * Fetch standard caps the bodies of a page's keepalive requests in flight at
 * 64 KiB in total, and a request over that fails as a network error
 * (Chromium, Firefox and WebKit all enforce it). This module keeps the SDK's
 * own keepalive requests within that budget: a body that doesn't fit what's
 * left goes on a plain request, which arrives as long as the page stays open.
 */

/** The bytes a page's keepalive request bodies in flight may add up to. */
export const KEEPALIVE_BUDGET_BYTES = 64 * 1024;

/** Body bytes of this SDK's keepalive requests still in flight (one budget per page). */
let inflightBytes = 0;

/** A request body's size in bytes (UTF-8), as the keepalive budget counts it. */
export function bodyBytes(body: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(body).length;
  // No TextEncoder: count UTF-8 bytes by hand (a surrogate pair is 4).
  let bytes = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < body.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Whether a keepalive request with this body fits what's left of the page's
 * budget, as far as this SDK knows (other scripts' keepalive requests count
 * too, but can't be seen).
 */
export function fitsKeepaliveBudget(body: string): boolean {
  return bodyBytes(body) <= KEEPALIVE_BUDGET_BYTES - inflightBytes;
}

/**
 * Send `init` with fetch as a keepalive request when its body fits the
 * budget left, else as a plain request. Returns, resolves, rejects or throws
 * as fetch does.
 */
export function fetchWithKeepalive(url: string, init: RequestInit & { body: string }): Promise<Response> {
  const bytes = bodyBytes(init.body);
  if (bytes > KEEPALIVE_BUDGET_BYTES - inflightBytes) {
    return fetch(url, { ...init, keepalive: false });
  }
  inflightBytes += bytes;
  const release = () => {
    inflightBytes -= bytes;
  };
  let response: Promise<Response>;
  try {
    response = fetch(url, { ...init, keepalive: true });
  } catch (error) {
    release();
    throw error;
  }
  return response.then(
    (res) => {
      release();
      return res;
    },
    (error: unknown) => {
      release();
      throw error;
    }
  );
}

/** POST a JSON body (see fetchWithKeepalive). */
export function postWithKeepalive(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<Response> {
  return fetchWithKeepalive(url, { method: "POST", headers, body });
}
