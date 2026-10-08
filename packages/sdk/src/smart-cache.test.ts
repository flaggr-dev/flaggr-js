import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartCache } from "./smart-cache";

afterEach(() => {
  vi.useRealTimers();
});

describe("SmartCache", () => {
  it("partitions cache keys by relevant context fields only", () => {
    const cache = new SmartCache({ freshTtl: 1000, staleTtl: 1000, maxEntries: 10, contextPartitioning: true });
    cache.setRelevantFields("checkout", ["country"]);
    cache.set("checkout", { value: "au", reason: "TARGETING_MATCH" }, { country: "AU", plan: "pro" });

    expect(cache.get("checkout", { country: "AU", plan: "free" }).value?.value).toBe("au");
    expect(cache.get("checkout", { country: "US", plan: "pro" }).status).toBe("miss");
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new SmartCache({ freshTtl: 1000, staleTtl: 1000, maxEntries: 2, contextPartitioning: true });
    cache.set("a", { value: true, reason: "STATIC" });
    cache.set("b", { value: false, reason: "STATIC" });
    expect(cache.get("a").status).toBe("fresh");

    cache.set("c", { value: "new", reason: "STATIC" });

    expect(cache.get("a").status).toBe("fresh");
    expect(cache.get("b").status).toBe("miss");
    expect(cache.getStats()).toMatchObject({ evictions: 1, size: 2 });
  });

  it("serves stale values while revalidating in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const cache = new SmartCache({ freshTtl: 10, staleTtl: 100, maxEntries: 10, contextPartitioning: true });
    const revalidator = vi.fn().mockResolvedValue({ value: true, reason: "STATIC" });
    cache.setRevalidator(revalidator);
    cache.set("flag", { value: false, reason: "STATIC" });

    vi.setSystemTime(20);
    const result = cache.get("flag");

    expect(result.status).toBe("stale");
    expect(result.value?.value).toBe(false);
    expect(revalidator).toHaveBeenCalledWith("flag", undefined);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(cache.get("flag").value?.value).toBe(true);
  });
});
