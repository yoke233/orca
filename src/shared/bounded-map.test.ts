import { describe, expect, it, vi } from 'vitest'
import { BoundedMap } from './bounded-map'

describe('BoundedMap', () => {
  it('rejects an invalid maxEntries', () => {
    expect(() => new BoundedMap<string, number>({ maxEntries: 0 })).toThrow(RangeError)
    expect(() => new BoundedMap<string, number>({ maxEntries: 4, maxBytes: 10 })).toThrow(/sizeOf/)
  })

  it('evicts the least-recently-used entry past the count ceiling', () => {
    const evicted: string[] = []
    const m = new BoundedMap<string, number>({ maxEntries: 3, onEvict: (_v, k) => evicted.push(k) })
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3)
    expect(m.size).toBe(3)
    m.set('d', 4) // count+1 -> evict oldest 'a'
    expect(m.size).toBe(3)
    expect(evicted).toEqual(['a'])
    expect(m.has('a')).toBe(false)
    expect([...m.keys()]).toEqual(['b', 'c', 'd'])
  })

  it('get() marks recently-used so it survives eviction', () => {
    const m = new BoundedMap<string, number>({ maxEntries: 3 })
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3)
    expect(m.get('a')).toBe(1) // 'a' now most-recent
    m.set('d', 4) // evicts oldest, which is now 'b' not 'a'
    expect(m.has('a')).toBe(true)
    expect(m.has('b')).toBe(false)
  })

  it('bounds aggregate retained bytes and evicts to fit', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 100,
      maxBytes: 10,
      sizeOf: (v) => v.length
    })
    m.set('a', 'xxxxx') // 5
    m.set('b', 'yyyyy') // 5 -> total 10 (exactly at cap)
    expect(m.retainedBytes).toBe(10)
    expect(m.size).toBe(2)
    m.set('c', 'z') // 11 > 10 -> evict oldest until <= 10
    expect(m.retainedBytes).toBeLessThanOrEqual(10)
    expect(m.has('a')).toBe(false)
    expect(m.has('c')).toBe(true)
  })

  it('rejects a single value larger than maxBytes without wiping the map', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 4,
      sizeOf: (v) => v.length
    })
    expect(m.set('a', 'ok')).toBe(true)
    expect(m.set('big', 'toolong')).toBe(false)
    expect(m.has('a')).toBe(true)
    expect(m.has('big')).toBe(false)
  })

  it('updates retained bytes on overwrite and delete', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 100,
      sizeOf: (v) => v.length
    })
    m.set('a', 'xxx') // 3
    m.set('a', 'x') // overwrite -> 1
    expect(m.retainedBytes).toBe(1)
    m.delete('a')
    expect(m.retainedBytes).toBe(0)
    expect(m.size).toBe(0)
  })

  it('maxEntryBytes rejects an oversized single entry independent of the aggregate', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 100,
      maxEntryBytes: 4,
      sizeOf: (v) => v.length
    })
    expect(m.set('a', 'ok')).toBe(true)
    expect(m.set('b', 'toolong')).toBe(false) // 7 > maxEntryBytes 4, though aggregate has room
    expect(m.has('a')).toBe(true)
    expect(m.retainedBytes).toBe(2)
  })

  it('does not fire onEvict on explicit delete/clear', () => {
    const onEvict = vi.fn()
    const m = new BoundedMap<string, number>({ maxEntries: 5, onEvict })
    m.set('a', 1)
    m.delete('a')
    m.set('b', 2)
    m.clear()
    expect(onEvict).not.toHaveBeenCalled()
  })
})
