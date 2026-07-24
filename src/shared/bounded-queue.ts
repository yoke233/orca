// A count- and byte-bounded FIFO queue. Replaces bespoke "array + length check + manual byte tally"
// producer queues. Overflow policy is explicit: 'reject' refuses the new item (backpressure) or
// 'drop-oldest' sheds the head (bounded live tail) — the two behaviors #10179 hand-rolled per site.

export type BoundedQueueOverflow = 'reject' | 'drop-oldest'

export type BoundedQueueOptions<T> = {
  maxItems: number
  // Aggregate retained-byte ceiling; omit for count-only bounding.
  maxBytes?: number
  sizeOf?: (item: T) => number
  // Default 'reject' (fail-closed backpressure).
  overflow?: BoundedQueueOverflow
  // Called for each item shed by 'drop-oldest' (or rejected when reason==='rejected').
  onDrop?: (item: T, reason: 'evicted' | 'rejected') => void
}

export class BoundedQueue<T> {
  private readonly items: T[] = []
  private readonly sizes: number[] = []
  private readonly maxItems: number
  private readonly maxBytes: number
  private readonly sizeOf: (item: T) => number
  private readonly overflow: BoundedQueueOverflow
  private readonly onDrop?: (item: T, reason: 'evicted' | 'rejected') => void
  private retained = 0

  constructor(options: BoundedQueueOptions<T>) {
    if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1) {
      throw new RangeError('BoundedQueue maxItems must be a positive safe integer')
    }
    if (options.maxBytes !== undefined && !options.sizeOf) {
      throw new Error('BoundedQueue requires sizeOf when maxBytes is set')
    }
    this.maxItems = options.maxItems
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
    this.sizeOf = options.sizeOf ?? (() => 0)
    this.overflow = options.overflow ?? 'reject'
    this.onDrop = options.onDrop
  }

  get size(): number {
    return this.items.length
  }

  get retainedBytes(): number {
    return this.retained
  }

  // Returns true if enqueued. A single item larger than maxBytes is always rejected.
  enqueue(item: T): boolean {
    const bytes = Math.max(0, this.sizeOf(item))
    if (bytes > this.maxBytes) {
      this.onDrop?.(item, 'rejected')
      return false
    }
    if (this.overflow === 'reject') {
      if (this.items.length + 1 > this.maxItems || this.retained + bytes > this.maxBytes) {
        this.onDrop?.(item, 'rejected')
        return false
      }
    }
    this.items.push(item)
    this.sizes.push(bytes)
    this.retained += bytes
    if (this.overflow === 'drop-oldest') {
      while (this.items.length > this.maxItems || this.retained > this.maxBytes) {
        const dropped = this.items.shift() as T
        this.retained -= this.sizes.shift() ?? 0
        this.onDrop?.(dropped, 'evicted')
      }
    }
    return true
  }

  dequeue(): T | undefined {
    if (this.items.length === 0) {
      return undefined
    }
    this.retained -= this.sizes.shift() ?? 0
    return this.items.shift()
  }

  peek(): T | undefined {
    return this.items[0]
  }

  clear(): void {
    this.items.length = 0
    this.sizes.length = 0
    this.retained = 0
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]()
  }
}
