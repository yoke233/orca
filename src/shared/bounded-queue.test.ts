import { describe, expect, it, vi } from 'vitest'
import { BoundedQueue } from './bounded-queue'

describe('BoundedQueue', () => {
  it('FIFO enqueue/dequeue and size accounting', () => {
    const q = new BoundedQueue<number>({ maxItems: 3 })
    expect(q.enqueue(1)).toBe(true)
    expect(q.enqueue(2)).toBe(true)
    expect(q.peek()).toBe(1)
    expect(q.dequeue()).toBe(1)
    expect(q.dequeue()).toBe(2)
    expect(q.dequeue()).toBeUndefined()
    expect(q.size).toBe(0)
  })

  it("overflow 'reject' refuses at the item ceiling (limit and limit+1)", () => {
    const onDrop = vi.fn()
    const q = new BoundedQueue<number>({ maxItems: 2, overflow: 'reject', onDrop })
    expect(q.enqueue(1)).toBe(true)
    expect(q.enqueue(2)).toBe(true) // exactly at cap
    expect(q.enqueue(3)).toBe(false) // limit+1 rejected
    expect(q.size).toBe(2)
    expect(onDrop).toHaveBeenCalledWith(3, 'rejected')
    expect([...q]).toEqual([1, 2])
  })

  it("overflow 'drop-oldest' sheds the head to keep a bounded live tail", () => {
    const dropped: number[] = []
    const q = new BoundedQueue<number>({
      maxItems: 2,
      overflow: 'drop-oldest',
      onDrop: (item) => dropped.push(item)
    })
    q.enqueue(1)
    q.enqueue(2)
    q.enqueue(3) // sheds 1
    q.enqueue(4) // sheds 2
    expect(dropped).toEqual([1, 2])
    expect([...q]).toEqual([3, 4])
  })

  it('bounds aggregate retained bytes', () => {
    const q = new BoundedQueue<string>({ maxItems: 100, maxBytes: 5, sizeOf: (s) => s.length })
    expect(q.enqueue('abc')).toBe(true) // 3
    expect(q.enqueue('de')).toBe(true) // 5 total, at cap
    expect(q.enqueue('f')).toBe(false) // would be 6
    expect(q.retainedBytes).toBe(5)
    q.dequeue() // remove 'abc' (3)
    expect(q.retainedBytes).toBe(2)
    expect(q.enqueue('gh')).toBe(true)
  })

  it('always rejects a single item larger than maxBytes', () => {
    const q = new BoundedQueue<string>({ maxItems: 10, maxBytes: 4, sizeOf: (s) => s.length })
    expect(q.enqueue('toolong')).toBe(false)
    expect(q.size).toBe(0)
  })
})
