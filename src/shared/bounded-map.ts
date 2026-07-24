// A count- and byte-bounded, insertion-ordered LRU map. Replaces the recurring bespoke
// "Map + entry counter + retained-byte ledger + evict-oldest" pattern with one tested primitive so
// the eviction policy is structural, not re-implemented (and re-mis-implemented) per site.
//
// Semantics: get()/set() mark a key most-recently-used. When maxEntries or maxBytes is exceeded on
// set, the least-recently-used entries are evicted (onEvict fired) until both bounds hold. Explicit
// delete()/clear() are caller-initiated and do NOT fire onEvict — only involuntary LRU eviction does.

export type BoundedMapOptions<K, V> = {
  maxEntries: number
  // Aggregate retained-byte ceiling across all values; omit for count-only bounding.
  maxBytes?: number
  // Per-entry ceiling: a single entry whose sizeOf exceeds this is rejected by set() (returns false)
  // instead of being admitted or evicting the rest of the map. Defaults to maxBytes.
  maxEntryBytes?: number
  // Retained bytes for a value; required when maxBytes or maxEntryBytes is set. Stable for a value.
  sizeOf?: (value: V, key: K) => number
  // Called when an entry is involuntarily evicted to satisfy a bound (dispose hook).
  onEvict?: (value: V, key: K) => void
}

export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>()
  private readonly bytesByKey = new Map<K, number>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly maxEntryBytes: number
  private readonly sizeOf: (value: V, key: K) => number
  private readonly onEvict?: (value: V, key: K) => void
  private retained = 0

  constructor(options: BoundedMapOptions<K, V>) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError('BoundedMap maxEntries must be a positive safe integer')
    }
    if (
      (options.maxBytes !== undefined || options.maxEntryBytes !== undefined) &&
      !options.sizeOf
    ) {
      throw new Error('BoundedMap requires sizeOf when maxBytes or maxEntryBytes is set')
    }
    this.maxEntries = options.maxEntries
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
    this.maxEntryBytes = options.maxEntryBytes ?? this.maxBytes
    this.sizeOf = options.sizeOf ?? (() => 0)
    this.onEvict = options.onEvict
  }

  get size(): number {
    return this.map.size
  }

  get retainedBytes(): number {
    return this.retained
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined && !this.map.has(key)) {
      return undefined
    }
    // Why: re-insert to move to the most-recently-used end of the insertion-ordered Map.
    this.map.delete(key)
    this.map.set(key, value as V)
    return value
  }

  // Insert or update. A single value larger than maxBytes is rejected (returns false) rather than
  // evicting the whole map to make room for something that still won't fit.
  set(key: K, value: V): boolean {
    const bytes = Math.max(0, this.sizeOf(value, key))
    if (bytes > this.maxEntryBytes) {
      return false
    }
    if (this.map.has(key)) {
      this.retained -= this.bytesByKey.get(key) ?? 0
      this.map.delete(key)
    }
    this.map.set(key, value)
    this.bytesByKey.set(key, bytes)
    this.retained += bytes
    this.evictToFit()
    return true
  }

  delete(key: K): boolean {
    if (!this.map.has(key)) {
      return false
    }
    this.retained -= this.bytesByKey.get(key) ?? 0
    this.bytesByKey.delete(key)
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
    this.bytesByKey.clear()
    this.retained = 0
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  values(): IterableIterator<V> {
    return this.map.values()
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  private evictToFit(): void {
    while (this.map.size > this.maxEntries || this.retained > this.maxBytes) {
      const oldest = this.map.keys().next()
      if (oldest.done) {
        break
      }
      const key = oldest.value
      const value = this.map.get(key) as V
      this.retained -= this.bytesByKey.get(key) ?? 0
      this.bytesByKey.delete(key)
      this.map.delete(key)
      this.onEvict?.(value, key)
    }
  }
}
