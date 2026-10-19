import { MemoryCacheProvider } from "../src/cache/MemoryCacheProvider";
import { LocalStorageCacheProvider } from "../src/cache/LocalStorageCacheProvider";
import { ServerCacheAdapter } from "../src/cache/ServerCacheAdapter";
import { CacheNamespace, CacheEntry, StatusCacheValue } from "../src/cache/types";
import { ZKProofGenerator } from "../src/crypto/proofs";
import { PayrollError } from "../src/errors";

function witnessToCacheKey(witness: Record<string, unknown>): string {
  return `proof:${JSON.stringify(witness, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  )}`;
}

// ---------------------------------------------------------------------------
// MemoryCacheProvider
// ---------------------------------------------------------------------------
describe("MemoryCacheProvider", () => {
  let cache: MemoryCacheProvider<string>;

  beforeEach(() => {
    cache = new MemoryCacheProvider();
  });

  it("returns null for a missing key", async () => {
    expect(await cache.get("missing")).toBeNull();
  });

  it("stores and retrieves a value", async () => {
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v");
  });

  it("has() returns true for an existing key", async () => {
    await cache.set("k", "v");
    expect(await cache.has("k")).toBe(true);
  });

  it("has() returns false for a missing key", async () => {
    expect(await cache.has("nope")).toBe(false);
  });

  it("respects TTL and expires entries", async () => {
    jest.useFakeTimers();
    await cache.set("ttl", "val", 1); // 1 second TTL
    jest.advanceTimersByTime(1001);
    expect(await cache.get("ttl")).toBeNull();
    jest.useRealTimers();
  });

  it("returns value before TTL expires", async () => {
    jest.useFakeTimers();
    await cache.set("ttl", "val", 10);
    jest.advanceTimersByTime(5000);
    expect(await cache.get("ttl")).toBe("val");
    jest.useRealTimers();
  });

  it("returns age, expiry, stale state, and revision metadata", async () => {
    jest.useFakeTimers().setSystemTime(10_000);
    await cache.setWithMetadata("versioned", "value", { ttlSeconds: 10, revision: "r7" });
    jest.advanceTimersByTime(2_500);

    const result = await cache.getWithMetadata("versioned");
    expect(result?.value).toBe("value");
    expect(result?.metadata).toEqual({
      storedAt: 10_000,
      expiresAt: 20_000,
      ageMs: 2_500,
      stale: false,
      revision: "r7",
    });
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// LocalStorageCacheProvider
// ---------------------------------------------------------------------------
describe("LocalStorageCacheProvider", () => {
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
    };
  })();

  beforeAll(() => {
    Object.defineProperty(global, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
  });

  beforeEach(() => localStorageMock.clear());

  it("stores and retrieves a value", async () => {
    const cache = new LocalStorageCacheProvider();
    await cache.set("key", "val");
    expect(await cache.get("key")).toBe("val");
  });

  it("returns null for a missing key", async () => {
    const cache = new LocalStorageCacheProvider();
    expect(await cache.get("missing")).toBeNull();
  });

  it("uses the provided key prefix", async () => {
    const cache = new LocalStorageCacheProvider("myapp:");
    await cache.set("x", "1");
    expect(localStorageMock.getItem("myapp:x")).not.toBeNull();
  });

  it("expires entries after TTL", async () => {
    jest.useFakeTimers();
    const cache = new LocalStorageCacheProvider();
    await cache.set("t", "v", 1);
    jest.advanceTimersByTime(1001);
    expect(await cache.get("t")).toBeNull();
    jest.useRealTimers();
  });

  it("throws PayrollError(500) when localStorage is unavailable", () => {
    const original = global.localStorage;
    Object.defineProperty(global, "localStorage", {
      value: undefined,
      configurable: true,
    });
    expect(() => new LocalStorageCacheProvider()).toThrow(PayrollError);
    Object.defineProperty(global, "localStorage", {
      value: original,
      configurable: true,
    });
  });

  it("has() reflects stored state", async () => {
    const cache = new LocalStorageCacheProvider();
    expect(await cache.has("k")).toBe(false);
    await cache.set("k", "v");
    expect(await cache.has("k")).toBe(true);
  });

  it("returns freshness metadata and revision", async () => {
    jest.useFakeTimers().setSystemTime(20_000);
    const cache = new LocalStorageCacheProvider();
    await cache.setWithMetadata("versioned", "value", { ttlSeconds: 5, revision: "r3" });
    jest.advanceTimersByTime(1_500);

    const result = await cache.getWithMetadata("versioned");
    expect(result?.metadata.ageMs).toBe(1_500);
    expect(result?.metadata.revision).toBe("r3");
    expect(result?.metadata.stale).toBe(false);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// In-memory ServerCacheAdapter (used for conformance tests)
// ---------------------------------------------------------------------------

interface MemoryServerEntry<T> {
  value: T;
  namespace: CacheNamespace;
  expiresAt: number | null;
  storedAt: number;
}

class MemoryServerCacheAdapter<T = string> implements ServerCacheAdapter<T> {
  private store = new Map<string, MemoryServerEntry<T>>();

  private fullKey(namespace: CacheNamespace, key: string): string {
    return `${namespace}:${key}`;
  }

  private isExpired(entry: MemoryServerEntry<T>): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  async get(namespace: CacheNamespace, key: string): Promise<T | null> {
    const fk = this.fullKey(namespace, key);
    const entry = this.store.get(fk);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(fk);
      return null;
    }
    return entry.value;
  }

  async set(namespace: CacheNamespace, key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    const fk = this.fullKey(namespace, key);
    this.store.set(fk, {
      value,
      namespace,
      expiresAt,
      storedAt: Date.now(),
    });
  }

  async has(namespace: CacheNamespace, key: string): Promise<boolean> {
    return (await this.get(namespace, key)) !== null;
  }

  async del(namespace: CacheNamespace, key: string): Promise<void> {
    this.store.delete(this.fullKey(namespace, key));
  }

  async clearNamespace(namespace: CacheNamespace): Promise<void> {
    for (const [key, entry] of this.store.entries()) {
      if (entry.namespace === namespace) {
        this.store.delete(key);
      }
    }
  }

  async clearAll(): Promise<void> {
    this.store.clear();
  }

  async getRemainingTtl(namespace: CacheNamespace, key: string): Promise<number | null> {
    const fk = this.fullKey(namespace, key);
    const entry = this.store.get(fk);
    if (!entry) return null;
    if (entry.expiresAt === null) return null;
    const remaining = Math.max(0, entry.expiresAt - Date.now());
    return Math.ceil(remaining / 1000);
  }

  async keys(namespace: CacheNamespace): Promise<CacheEntry<T>[]> {
    this.purgeExpired();
    const result: CacheEntry<T>[] = [];
    for (const [key, entry] of this.store.entries()) {
      if (entry.namespace === namespace) {
        const relativeKey = key.slice(namespace.length + 1);
        result.push({
          key: relativeKey,
          value: entry.value,
          namespace: entry.namespace,
          expiresAt: entry.expiresAt,
          storedAt: entry.storedAt,
        });
      }
    }
    return result;
  }

  async size(namespace: CacheNamespace): Promise<number> {
    this.purgeExpired();
    let count = 0;
    for (const entry of this.store.values()) {
      if (entry.namespace === namespace) count++;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// ServerCacheAdapter conformance tests
// ---------------------------------------------------------------------------

describe("ServerCacheAdapter conformance", () => {
  let cache: MemoryServerCacheAdapter<string>;

  beforeEach(() => {
    cache = new MemoryServerCacheAdapter();
  });

  // ── Core CRUD ────────────────────────────────────────────────────────────

  it("returns null for a missing key", async () => {
    await expect(cache.get(CacheNamespace.PROOF, "nonexistent")).resolves.toBeNull();
  });

  it("stores and retrieves a value", async () => {
    await cache.set(CacheNamespace.ARTIFACT, "circuit:v1", "wasm-data");
    await expect(cache.get(CacheNamespace.ARTIFACT, "circuit:v1")).resolves.toBe("wasm-data");
  });

  it("returns null after deleting a key", async () => {
    await cache.set(CacheNamespace.STATUS, "tx:abc", "pending");
    await cache.del(CacheNamespace.STATUS, "tx:abc");
    await expect(cache.get(CacheNamespace.STATUS, "tx:abc")).resolves.toBeNull();
  });

  it("del on a missing key is a no-op", async () => {
    await expect(cache.del(CacheNamespace.DRAFT, "missing")).resolves.toBeUndefined();
  });

  it("has() returns true for an existing key", async () => {
    await cache.set(CacheNamespace.PROOF, "k1", "proof-data");
    await expect(cache.has(CacheNamespace.PROOF, "k1")).resolves.toBe(true);
  });

  it("has() returns false for a missing key", async () => {
    await expect(cache.has(CacheNamespace.PROOF, "nope")).resolves.toBe(false);
  });

  it("has() returns false after deletion", async () => {
    await cache.set(CacheNamespace.PROOF, "k", "v");
    await cache.del(CacheNamespace.PROOF, "k");
    await expect(cache.has(CacheNamespace.PROOF, "k")).resolves.toBe(false);
  });

  it("respects TTL and expires entries", async () => {
    jest.useFakeTimers();
    await cache.set(CacheNamespace.STATUS, "tx:1", "confirmed", 1);
    jest.advanceTimersByTime(1001);
    await expect(cache.get(CacheNamespace.STATUS, "tx:1")).resolves.toBeNull();
    jest.useRealTimers();
  });

  it("returns value before TTL expires", async () => {
    jest.useFakeTimers();
    await cache.set(CacheNamespace.STATUS, "tx:2", "pending", 10);
    jest.advanceTimersByTime(5000);
    await expect(cache.get(CacheNamespace.STATUS, "tx:2")).resolves.toBe("pending");
    jest.useRealTimers();
  });

  // ── Namespace isolation ──────────────────────────────────────────────────

  it("isolates entries by namespace", async () => {
    await cache.set(CacheNamespace.ARTIFACT, "k", "wasm");
    await cache.set(CacheNamespace.STATUS, "k", "tx-pending");
    await expect(cache.get(CacheNamespace.ARTIFACT, "k")).resolves.toBe("wasm");
    await expect(cache.get(CacheNamespace.STATUS, "k")).resolves.toBe("tx-pending");
  });

  it("clearNamespace removes only the targeted namespace", async () => {
    await cache.set(CacheNamespace.ARTIFACT, "a", "wasm");
    await cache.set(CacheNamespace.DRAFT, "b", "draft-data");
    await cache.clearNamespace(CacheNamespace.ARTIFACT);

    await expect(cache.get(CacheNamespace.ARTIFACT, "a")).resolves.toBeNull();
    await expect(cache.get(CacheNamespace.DRAFT, "b")).resolves.toBe("draft-data");
  });

  it("clearAll removes every entry across all namespaces", async () => {
    await cache.set(CacheNamespace.ARTIFACT, "a", "wasm");
    await cache.set(CacheNamespace.STATUS, "b", "confirmed");
    await cache.set(CacheNamespace.DRAFT, "c", "draft");
    await cache.clearAll();

    await expect(cache.size(CacheNamespace.ARTIFACT)).resolves.toBe(0);
    await expect(cache.size(CacheNamespace.STATUS)).resolves.toBe(0);
    await expect(cache.size(CacheNamespace.DRAFT)).resolves.toBe(0);
  });

  it("clearing an empty namespace is a no-op", async () => {
    await expect(cache.clearNamespace(CacheNamespace.IDEMPOTENCY)).resolves.toBeUndefined();
  });

  // ── TTL introspection ────────────────────────────────────────────────────

  it("getRemainingTtl returns null for missing keys", async () => {
    await expect(cache.getRemainingTtl(CacheNamespace.STATUS, "missing")).resolves.toBeNull();
  });

  it("getRemainingTtl returns null for keys without TTL", async () => {
    await cache.set(CacheNamespace.ARTIFACT, "perm", "data");
    await expect(cache.getRemainingTtl(CacheNamespace.ARTIFACT, "perm")).resolves.toBeNull();
  });

  it("getRemainingTtl returns positive remaining seconds", async () => {
    jest.useFakeTimers();
    await cache.set(CacheNamespace.STATUS, "tx:3", "pending", 60);
    jest.advanceTimersByTime(10_000);
    const ttl = await cache.getRemainingTtl(CacheNamespace.STATUS, "tx:3");
    expect(ttl).toBeGreaterThan(45);
    expect(ttl).toBeLessThanOrEqual(55);
    jest.useRealTimers();
  });

  // ── Entry inspection ─────────────────────────────────────────────────────

  it("keys returns entries with metadata", async () => {
    jest.useFakeTimers();
    await cache.set(CacheNamespace.PROOF, "p1", "proof1");
    await cache.set(CacheNamespace.PROOF, "p2", "proof2");

    const entries = await cache.keys(CacheNamespace.PROOF);
    expect(entries).toHaveLength(2);
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(["p1", "p2"]);

    for (const entry of entries) {
      expect(entry.namespace).toBe(CacheNamespace.PROOF);
      expect(entry.storedAt).toBeGreaterThan(0);
    }
    jest.useRealTimers();
  });

  it("keys returns empty array for empty namespace", async () => {
    await expect(cache.keys(CacheNamespace.PROOF)).resolves.toEqual([]);
  });

  it("size returns correct count", async () => {
    await cache.set(CacheNamespace.DRAFT, "d1", "draft-a");
    await cache.set(CacheNamespace.DRAFT, "d2", "draft-b");
    await expect(cache.size(CacheNamespace.DRAFT)).resolves.toBe(2);
  });

  it("size returns 0 for empty namespace", async () => {
    await expect(cache.size(CacheNamespace.PROOF)).resolves.toBe(0);
  });

  it("size excludes entries that have expired", async () => {
    jest.useFakeTimers();
    await cache.set(CacheNamespace.STATUS, "tx:e1", "done", 1);
    await cache.set(CacheNamespace.STATUS, "tx:e2", "pending"); // no TTL
    jest.advanceTimersByTime(1001);

    const count = await cache.size(CacheNamespace.STATUS);
    expect(count).toBe(1); // only the non-TTL entry survives
    jest.useRealTimers();
  });

  // ─── Artifact namespace integration ──────────────────────────────────────

  it("caches proof artifacts under ARTIFACT namespace", async () => {
    const wasmKey = "circuit:latest.wasm";
    const zkeyKey = "circuit:latest.zkey";

    await cache.set(CacheNamespace.ARTIFACT, wasmKey, "<binary-data>");
    await cache.set(CacheNamespace.ARTIFACT, zkeyKey, "<key-data>");

    await expect(cache.get(CacheNamespace.ARTIFACT, wasmKey)).resolves.toBe("<binary-data>");
    await expect(cache.get(CacheNamespace.ARTIFACT, zkeyKey)).resolves.toBe("<key-data>");
  });

  // ─── Status namespace integration ────────────────────────────────────────

  it("caches typed status values under STATUS namespace", async () => {
    const statusCache = new MemoryServerCacheAdapter<string>();
    const txKey = "exec:cycle-42";

    const status: StatusCacheValue = {
      status: "pending",
      updatedAt: Date.now(),
    };

    await statusCache.set(CacheNamespace.STATUS, txKey, JSON.stringify(status));
    const raw = await statusCache.get(CacheNamespace.STATUS, txKey);
    const parsed: StatusCacheValue = JSON.parse(raw!);

    expect(parsed.status).toBe("pending");
    expect(parsed.updatedAt).toBeGreaterThan(0);
    expect(parsed.error).toBeUndefined();
  });

  it("updates status from pending to confirmed", async () => {
    const statusCache = new MemoryServerCacheAdapter<string>();
    const txKey = "exec:cycle-7";

    // Write pending
    await statusCache.set(
      CacheNamespace.STATUS,
      txKey,
      JSON.stringify({ status: "pending", updatedAt: Date.now() } satisfies StatusCacheValue)
    );

    // Update to confirmed
    const confirmed: StatusCacheValue = {
      status: "confirmed",
      txHash: "0xabc123",
      updatedAt: Date.now(),
    };
    await statusCache.set(CacheNamespace.STATUS, txKey, JSON.stringify(confirmed));

    const raw = await statusCache.get(CacheNamespace.STATUS, txKey);
    const parsed: StatusCacheValue = JSON.parse(raw!);
    expect(parsed.status).toBe("confirmed");
    expect(parsed.txHash).toBe("0xabc123");
  });

  // ─── Draft namespace integration ─────────────────────────────────────────

  it("caches draft payloads under DRAFT namespace", async () => {
    const draftPayload = JSON.stringify({
      version: 1,
      label: "Q4 Payroll",
      entries: [{ recipientId: "GABC", amount: "1000", asset: "native" }],
    });

    await cache.set(CacheNamespace.DRAFT, "draft:q4", draftPayload);
    const retrieved = await cache.get(CacheNamespace.DRAFT, "draft:q4");

    expect(retrieved).toBe(draftPayload);
    const parsed = JSON.parse(retrieved!);
    expect(parsed.label).toBe("Q4 Payroll");
    expect(parsed.entries).toHaveLength(1);
  });

  // ─── Idempotency namespace integration ───────────────────────────────────

  it("caches idempotency results under IDEMPOTENCY namespace", async () => {
    const idempotencyKey = "pay:galice:1000:native";
    const result = JSON.stringify({ txHash: "0xabc", status: "success" });

    await cache.set(CacheNamespace.IDEMPOTENCY, idempotencyKey, result, 300);
    const retrieved = await cache.get(CacheNamespace.IDEMPOTENCY, idempotencyKey);

    expect(retrieved).toBe(result);
    const parsed = JSON.parse(retrieved!);
    expect(parsed.txHash).toBe("0xabc");
  });
});

// ---------------------------------------------------------------------------
// ZKProofGenerator cache integration
// ---------------------------------------------------------------------------
describe("ZKProofGenerator with cache", () => {
  it("generates a proof on cache miss and stores it", async () => {
    const cache = new MemoryCacheProvider<string>();
    const spy = jest.spyOn(cache, "set");

    const proof = await ZKProofGenerator.generateProof({ recipient: "r", amount: 100n }, cache);

    expect(proof).toBeInstanceOf(Uint8Array);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns cached proof on hit without re-generating", async () => {
    const cache = new MemoryCacheProvider<string>();
    const witness = { recipient: "r", amount: 100n };

    const first = await ZKProofGenerator.generateProof(witness, cache);
    const setSpy = jest.spyOn(cache, "set");
    const second = await ZKProofGenerator.generateProof(witness, cache);

    expect(setSpy).not.toHaveBeenCalled(); // no second write
    expect(first).toEqual(second);
  });

  it("generates a proof without a cache when none is provided", async () => {
    const proof = await ZKProofGenerator.generateProof({
      recipient: "r",
      amount: 50n,
    });
    expect(proof).toBeInstanceOf(Uint8Array);
  });

  it("different witnesses produce separately cached entries", async () => {
    const cache = new MemoryCacheProvider<string>();
    await ZKProofGenerator.generateProof({ recipient: "a", amount: 1n }, cache);
    await ZKProofGenerator.generateProof({ recipient: "b", amount: 2n }, cache);

    expect(await cache.has(witnessToCacheKey({ recipient: "a", amount: 1n }))).toBe(true);
    expect(await cache.has(witnessToCacheKey({ recipient: "b", amount: 2n }))).toBe(true);
  });
});
