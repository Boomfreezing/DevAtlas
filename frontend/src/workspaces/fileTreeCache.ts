type DirectoryEntry = { data?: { items: readonly unknown[] } };
type CachedValue<T> = { value: T; weight: number };

export type DirectoryCacheOptions = {
  maxInactiveItems?: number;
  maxInactiveDirectories?: number;
};

/**
 * An LRU budget for collapsed directories, not a limit on the visible tree.
 * Pinned directories (including pending page requests) cannot be evicted.
 * We count node records, not bytes: this is deliberately not an RSS estimate.
 */
export class BoundedDirectoryCache<T extends DirectoryEntry> {
  private readonly entries = new Map<string, CachedValue<T>>();
  private readonly inactive = new Map<string, CachedValue<T>>();
  private readonly pins = new Map<string, Set<symbol>>();
  private readonly maxInactiveItems: number;
  private readonly maxInactiveDirectories: number;
  private activeItems = 0;
  private inactiveItems = 0;

  constructor(options: DirectoryCacheOptions = {}) {
    this.maxInactiveItems = options.maxInactiveItems ?? 4000;
    this.maxInactiveDirectories = options.maxInactiveDirectories ?? 64;
    for (const limit of [this.maxInactiveItems, this.maxInactiveDirectories]) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Directory cache budgets must be non-negative safe integers.");
    }
  }

  get size() { return this.entries.size; }

  get stats() {
    return {
      directories: this.entries.size,
      activeDirectories: this.entries.size - this.inactive.size,
      inactiveDirectories: this.inactive.size,
      totalItems: this.activeItems + this.inactiveItems,
      activeItems: this.activeItems,
      inactiveItems: this.inactiveItems,
      pinnedPaths: this.pins.size,
    };
  }

  has(path: string) { return this.entries.has(path); }
  keys() { return this.entries.keys(); }

  get(path: string): T | undefined {
    const entry = this.entries.get(path);
    if (entry && this.inactive.has(path)) this.touch(path, entry);
    return entry?.value;
  }

  set(path: string, value: T): this {
    this.delete(path);
    const entry = { value, weight: value.data?.items.length ?? 0 };
    this.entries.set(path, entry);
    if (this.pins.has(path)) {
      this.activeItems += entry.weight;
    } else {
      this.inactiveItems += entry.weight;
      this.touch(path, entry);
      this.trimAfterUpdate(path, entry);
    }
    return this;
  }

  /** Recount an entry after its existing data object has been updated in place. */
  refresh(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    const weight = entry.value.data?.items.length ?? 0;
    const delta = weight - entry.weight;
    entry.weight = weight;
    if (this.pins.has(path)) {
      this.activeItems += delta;
    } else {
      this.inactiveItems += delta;
      this.touch(path, entry);
      this.trimAfterUpdate(path, entry);
    }
  }

  /**
   * The returned release callback is idempotent and tied to this exact pin.
   * Old cleanup callbacks therefore cannot release a new pin after clear().
   */
  pin(path: string): () => void {
    let leases = this.pins.get(path);
    if (!leases) {
      leases = new Set();
      this.pins.set(path, leases);
      const entry = this.inactive.get(path);
      if (entry) {
        this.inactive.delete(path);
        this.inactiveItems -= entry.weight;
        this.activeItems += entry.weight;
      }
    }
    const token = Symbol(path);
    leases.add(token);
    const ownedLeases = leases;
    return () => this.release(path, ownedLeases, token);
  }

  unpin(path: string): void {
    const leases = this.pins.get(path);
    const token = leases?.values().next().value;
    if (leases && token !== undefined) this.release(path, leases, token);
  }

  delete(path: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return false;
    if (this.inactive.delete(path)) this.inactiveItems -= entry.weight;
    else this.activeItems -= entry.weight;
    return this.entries.delete(path);
  }

  /** Invalidate exact descendants, without unpinning still-mounted readers. */
  deleteSubtree(path: string): void {
    for (const key of this.entries.keys()) {
      if (!path || key === path || key.startsWith(`${path}/`)) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inactive.clear();
    this.pins.clear();
    this.activeItems = 0;
    this.inactiveItems = 0;
  }

  private release(path: string, leases: Set<symbol>, token: symbol): void {
    if (this.pins.get(path) !== leases || !leases.delete(token) || leases.size) return;
    this.pins.delete(path);
    const entry = this.entries.get(path);
    if (entry) {
      this.activeItems -= entry.weight;
      this.inactiveItems += entry.weight;
      this.touch(path, entry);
      this.trimAfterUpdate(path, entry);
    }
  }

  private touch(path: string, entry: CachedValue<T>): void {
    this.inactive.delete(path);
    this.inactive.set(path, entry);
  }

  private trimAfterUpdate(path: string, entry: CachedValue<T>): void {
    // A single oversized page set can never fit; keep useful smaller entries.
    if (entry.weight > this.maxInactiveItems || this.maxInactiveDirectories === 0) {
      this.delete(path);
      return;
    }
    this.trim();
  }

  private trim(): void {
    while (this.inactiveItems > this.maxInactiveItems || this.inactive.size > this.maxInactiveDirectories) {
      const oldest = this.inactive.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
