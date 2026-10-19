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
 * In-memory cache provider for Node.js environments.
 * Data does not persist across process restarts.
 */
export class MemoryCacheProvider<T = string> implements MetadataCacheProvider<T> {
  private store = new Map<string, Entry<T>>();

  async get(key: string): Promise<T | null> {
    try {
      const entry = this.store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        this.store.delete(key);
        return null;
      }
      return entry.value;
    } catch (err) {
      throw new PayrollError(`MemoryCacheProvider.get failed: ${err}`, 501);
    }
  }

  async set(key: string, value: T, ttlSeconds?: number): Promise<void> {
    return this.setWithMetadata(key, value, { ttlSeconds });
  }

  async getWithMetadata(key: string, now = Date.now()): Promise<CacheReadResult<T> | null> {
    try {
      const entry = this.store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.store.delete(key);
        return null;
      }
      return createCacheReadResult(
        entry.value,
        entry.storedAt,
        entry.expiresAt,
        entry.revision,
        now
      );
    } catch (err) {
      throw new PayrollError(`MemoryCacheProvider.getWithMetadata failed: ${err}`, 501);
    }
  }

  async setWithMetadata(key: string, value: T, options: CacheMetadataOptions = {}): Promise<void> {
    try {
      const storedAt = Date.now();
      const expiresAt = options.ttlSeconds ? storedAt + options.ttlSeconds * 1000 : null;
      this.store.set(key, { value, storedAt, expiresAt, revision: options.revision });
    } catch (err) {
      throw new PayrollError(`MemoryCacheProvider.set failed: ${err}`, 502);
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }
}
