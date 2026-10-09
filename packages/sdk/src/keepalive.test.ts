import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyBytes, fetchWithKeepalive, fitsKeepaliveBudget, KEEPALIVE_BUDGET_BYTES } from "./keepalive";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fetch whose requests the test answers (resolve) or fails (reject), in order. */
function heldFetch() {
  const pending: Array<{ resolve(): void; reject(): void }> = [];
  const fetchMock = vi.fn(
    (_url: string | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve, reject) =>
        pending.push({
          resolve: () => resolve(new Response(null, { status: 202 })),
          reject: () => reject(new TypeError("Failed to fetch")),
        })
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pending, keepalive: () => fetchMock.mock.calls.map(([, init]) => init?.keepalive) };
}

const KIB = 1024;

describe("fetchWithKeepalive", () => {
  it("keeps this SDK's keepalive bodies in flight within 64 KiB, freeing a request's share once it's answered", async () => {
    const { pending, keepalive } = heldFetch();
    const body = "x".repeat(40 * KIB);

    const first = fetchWithKeepalive("https://flaggr.test/a", { method: "POST", body });
    const second = fetchWithKeepalive("https://flaggr.test/b", { method: "POST", body }); // 80 KiB in flight: too much
    expect(keepalive()).toEqual([true, false]);
    expect(fitsKeepaliveBudget("x".repeat(24 * KIB))).toBe(true);
    expect(fitsKeepaliveBudget("x".repeat(25 * KIB))).toBe(false);

    pending[0].resolve();
    await first;
    const third = fetchWithKeepalive("https://flaggr.test/c", { method: "POST", body });
    expect(keepalive()).toEqual([true, false, true]);

    // A failed request frees its share too.
    pending[2].reject();
    await expect(third).rejects.toThrow("Failed to fetch");
    pending[1].resolve();
    await second;
    expect(fitsKeepaliveBudget("x".repeat(KEEPALIVE_BUDGET_BYTES))).toBe(true);
  });

  it("sends a body over 64 KiB on its own as a plain request", async () => {
    const { pending, keepalive } = heldFetch();
    const response = fetchWithKeepalive("https://flaggr.test/a", { method: "POST", body: "x".repeat(KEEPALIVE_BUDGET_BYTES + 1) });
    expect(keepalive()).toEqual([false]);
    pending[0].resolve();
    await response;
  });

  it("frees the share of a request fetch threw for", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new TypeError("fetch threw");
      })
    );
    const body = "x".repeat(40 * KIB);
    expect(() => fetchWithKeepalive("https://flaggr.test/a", { method: "POST", body })).toThrow("fetch threw");
    expect(fitsKeepaliveBudget("x".repeat(KEEPALIVE_BUDGET_BYTES))).toBe(true);
  });
});

describe("bodyBytes", () => {
  it("counts UTF-8 bytes, as the budget does", () => {
    expect(bodyBytes("abc")).toBe(3);
    expect(bodyBytes("é")).toBe(2);
    expect(bodyBytes("€")).toBe(3);
    expect(bodyBytes("😀")).toBe(4);
  });

  it("counts the same without TextEncoder", () => {
    vi.stubGlobal("TextEncoder", undefined);
    expect([bodyBytes("abc"), bodyBytes("é"), bodyBytes("€"), bodyBytes("😀"), bodyBytes("a😀b")]).toEqual([3, 2, 3, 4, 6]);
  });
});
