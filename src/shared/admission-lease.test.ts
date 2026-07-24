import { describe, expect, it } from 'vitest'
import { AdmissionCapacityError, AdmissionController, withAdmission } from './admission-lease'

describe('AdmissionController', () => {
  it('admits up to the count ceiling, rejects the next, and releases capacity', () => {
    const c = new AdmissionController({ maxCount: 2 })
    const a = c.acquire()
    const b = c.acquire()
    expect(c.activeCount).toBe(2)
    expect(() => c.acquire()).toThrow(AdmissionCapacityError)
    a.release()
    expect(c.activeCount).toBe(1)
    expect(() => c.acquire()).not.toThrow()
    b.release()
  })

  it('bounds reserved bytes at the exact limit and rejects limit+1', () => {
    const c = new AdmissionController({ maxCount: 100, maxBytes: 10 })
    const a = c.acquire(6)
    const b = c.acquire(4) // total 10, exactly at cap
    expect(c.reservedBytes).toBe(10)
    expect(() => c.acquire(1)).toThrow(AdmissionCapacityError)
    a.release()
    expect(c.reservedBytes).toBe(4)
    expect(() => c.acquire(6)).not.toThrow()
    b.release()
  })

  it('tryAcquire returns null instead of throwing on overload', () => {
    const c = new AdmissionController({ maxCount: 1 })
    expect(c.tryAcquire()).not.toBeNull()
    expect(c.tryAcquire()).toBeNull()
  })

  it('release() is idempotent — double release does not under-count', () => {
    const c = new AdmissionController({ maxCount: 3, maxBytes: 30 })
    const lease = c.acquire(10)
    expect(lease.released).toBe(false)
    lease.release()
    lease.release()
    lease.release()
    expect(lease.released).toBe(true)
    expect(c.activeCount).toBe(0)
    expect(c.reservedBytes).toBe(0)
  })

  it('withAdmission releases even when the work throws', async () => {
    const c = new AdmissionController({ maxCount: 1, maxBytes: 10 })
    await expect(
      withAdmission(c, 5, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    // capacity fully returned despite the throw -> the leak class this primitive prevents
    expect(c.activeCount).toBe(0)
    expect(c.reservedBytes).toBe(0)
    // and the controller is reusable
    await expect(withAdmission(c, 10, () => 'ok')).resolves.toBe('ok')
    expect(c.reservedBytes).toBe(0)
  })
})
