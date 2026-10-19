import { CacheProvider } from "./CacheProvider";
import {
  CacheMetadataOptions,
  CacheReadResult,
  createCacheReadResult,
  MetadataCacheProvider,
} from "./freshness";
import { PayrollError } from "../errors";

interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number | null;
  revision?: string;
}

/**
 * Browser-side cache provider backed by localStorage.
 * Throws PayrollError(500) if localStorage is unavailable.
 */
export class LocalStorageCacheProvider<T = string> implements MetadataCacheProvider<T> {
  private readonly prefix: string;

  constructor(prefix = "zk-payroll:") {
    if (typeof localStorage === "undefined") {
      throw new PayrollError("LocalStorageCacheProvider requires a browser environment", 500);
    }
    this.prefix = prefix;
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get(key: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem(this.key(key));
      if (raw === null) return null;
      const entry: Entry<T> = JSON.parse(raw);
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        localStorage.removeItem(this.key(key));
        return null;
      }
      return entry.value;
    } catch (err) {
      throw new PayrollError(`LocalStorageCacheProvider.get failed: ${err}`, 503);
    }
  }

  async set(key: string, value: T, ttlSeconds?: number): Promise<void> {
    return this.setWithMetadata(key, value, { ttlSeconds });
  }

  async getWithMetadata(key: string, now = Date.now()): Promise<CacheReadResult<T> | null> {
    try {
      const raw = localStorage.getItem(this.key(key));
      if (raw === null) return null;
      const entry: Entry<T> = JSON.parse(raw);
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        localStorage.removeItem(this.key(key));
        return null;
      }
      // Entries written by older SDK versions have no storedAt field. Treat
      // their first metadata read as the migration point rather than exposing
      // NaN/Infinity to refresh policies.
      const storedAt = Number.isFinite(entry.storedAt) ? entry.storedAt : now;
      return createCacheReadResult(entry.value, storedAt, entry.expiresAt, entry.revision, now);
    } catch (err) {
      throw new PayrollError(`LocalStorageCacheProvider.getWithMetadata failed: ${err}`, 503);
    }
  }

  async setWithMetadata(key: string, value: T, options: CacheMetadataOptions = {}): Promise<void> {
    try {
      const storedAt = Date.now();
      const expiresAt = options.ttlSeconds ? storedAt + options.ttlSeconds * 1000 : null;
      const entry: Entry<T> = { value, storedAt, expiresAt, revision: options.revision };
      localStorage.setItem(this.key(key), JSON.stringify(entry));
    } catch (err) {
      throw new PayrollError(`LocalStorageCacheProvider.set failed: ${err}`, 504);
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }
}
