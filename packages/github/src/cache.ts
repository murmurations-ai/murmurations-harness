/**
 * ETag-based cache for GitHub responses. Minimal interface — a future
 * disk-backed implementation (e.g. `SqliteGithubCache`) slots in
 * without changing callers.
 */

export interface GithubCacheEntry {
  readonly etag: string;
  readonly body: unknown;
  readonly fetchedAt: Date;
  readonly url: string;
}

export interface GithubCache {
  get(url: string): GithubCacheEntry | null;
  set(url: string, entry: GithubCacheEntry): void;
  delete(url: string): void;
  size(): number;
}

/**
 * In-memory LRU using `Map` insertion order. On `get`, the hit entry
 * is deleted and re-set to move it to the newest slot. On `set`, if
 * the size exceeds the cap, the oldest entry (first in iteration
 * order) is evicted.
 */
export class LruGithubCache implements GithubCache {
  readonly #maxEntries: number;
  readonly #store = new Map<string, GithubCacheEntry>();

  public constructor(maxEntries = 500) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`LruGithubCache maxEntries must be >= 1, got ${String(maxEntries)}`);
    }
    this.#maxEntries = maxEntries;
  }

  public get(url: string): GithubCacheEntry | null {
    const entry = this.#store.get(url);
    if (!entry) return null;
    // Touch recency: delete + re-insert places it at the newest slot.
    this.#store.delete(url);
    this.#store.set(url, entry);
    return entry;
  }

  public set(url: string, entry: GithubCacheEntry): void {
    if (this.#store.has(url)) {
      this.#store.delete(url);
    }
    this.#store.set(url, entry);
    while (this.#store.size > this.#maxEntries) {
      const oldest = this.#store.keys().next().value;
      if (oldest === undefined) break;
      this.#store.delete(oldest);
    }
  }

  public delete(url: string): void {
    this.#store.delete(url);
  }

  public size(): number {
    return this.#store.size;
  }
}
