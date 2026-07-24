import { BoundedMap } from './bounded-map'

export type SecurePathHardeningCacheBounds = {
  maxEntries: number
  maxKeyBytes: number
  maxTotalKeyBytes: number
}

// Backed by the shared BoundedMap key-byte-weighted LRU. The wrapper keeps this cache's two quirks a
// generic map does not model: rejecting a single path over EITHER the per-key or aggregate ceiling,
// and being fully disabled when maxEntries <= 0.
export class SecurePathHardeningCache<T> {
  private readonly disabled: boolean
  private readonly map: BoundedMap<string, T>

  constructor(bounds: SecurePathHardeningCacheBounds) {
    this.disabled = bounds.maxEntries <= 0
    this.map = new BoundedMap<string, T>({
      maxEntries: Math.max(1, bounds.maxEntries),
      maxBytes: bounds.maxTotalKeyBytes,
      maxEntryBytes: Math.min(bounds.maxKeyBytes, bounds.maxTotalKeyBytes),
      sizeOf: (_value, path) => Buffer.byteLength(path, 'utf8')
    })
  }

  get(path: string): T | undefined {
    return this.map.get(path)
  }

  set(path: string, value: T): boolean {
    if (this.disabled) {
      return false
    }
    return this.map.set(path, value)
  }

  delete(path: string): void {
    this.map.delete(path)
  }

  clear(): void {
    this.map.clear()
  }

  state(): { entries: number; keyBytes: number; paths: string[] } {
    return {
      entries: this.map.size,
      keyBytes: this.map.retainedBytes,
      paths: [...this.map.keys()]
    }
  }
}
