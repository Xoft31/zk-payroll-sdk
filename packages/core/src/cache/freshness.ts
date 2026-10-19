import { CacheProvider } from "./CacheProvider";
import type { CacheEntry } from "./types";

/** Options used when writing an entry through the metadata-aware API. */
export interface CacheMetadataOptions {
  /** Optional TTL in seconds. */
  ttlSeconds?: number;
  /** Application-defined revision of the cached value. */
  revision?: string;
}

/** Freshness information returned with a cached value. */
export interface CacheFreshnessMetadata {
  /** Epoch-millis timestamp at which the value was stored. */
  storedAt: number;
  /** Epoch-millis expiration timestamp, or null for an unbounded entry. */
  expiresAt: number | null;
  /** Age of the value in milliseconds at read time. */
  ageMs: number;
  /** Whether the value is at or past its expiration time. */
  stale: boolean;
  /** Optional application-defined revision supplied at write time. */
  revision?: string;
}

/** A cached value together with the information needed to decide whether to refresh it. */
export interface CacheReadResult<T> {
  value: T;
  metadata: CacheFreshnessMetadata;
}

/** Optional extension implemented by providers that can expose cache freshness. */
export interface MetadataCacheProvider<T = string> extends CacheProvider<T> {
  getWithMetadata(key: string, now?: number): Promise<CacheReadResult<T> | null>;
  setWithMetadata(key: string, value: T, options?: CacheMetadataOptions): Promise<void>;
}

/**
 * Builds a consistent freshness result for local providers and distributed-cache adapters.
 * `now` is injectable to make consumers' refresh policies deterministic in tests.
 */
export function createCacheReadResult<T>(
  value: T,
  storedAt: number,
  expiresAt: number | null,
  revision?: string,
  now = Date.now()
): CacheReadResult<T> {
  const ageMs = Math.max(0, now - storedAt);
  return {
    value,
    metadata: {
      storedAt,
      expiresAt,
      ageMs,
      stale: expiresAt !== null && now >= expiresAt,
      ...(revision === undefined ? {} : { revision }),
    },
  };
}

/** Convert a distributed-cache scan entry into the same freshness shape. */
export function cacheEntryToReadResult<T>(
  entry: Pick<CacheEntry<T>, "value" | "storedAt" | "expiresAt">,
  now = Date.now(),
  revision?: string
): CacheReadResult<T> {
  return createCacheReadResult(entry.value, entry.storedAt, entry.expiresAt, revision, now);
}
