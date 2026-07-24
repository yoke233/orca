// Count- and byte-bounded admission with LEASE-based release. Generalizes the acquire/release idiom
// #10179 wrote once and never shared — the source of the fd-leak (session-jsonl-line-reader) and the
// watcher claim-leak, which were both an acquire whose release was skipped by an early return/throw.
//
// acquire() returns a lease with an idempotent release(). Prefer withAdmission(), which runs work
// under a lease and releases in finally, so no code path can strand a reservation.

export class AdmissionCapacityError extends Error {
  constructor(readonly reason: 'count' | 'bytes') {
    super(`admission capacity reached (${reason})`)
    this.name = 'AdmissionCapacityError'
  }
}

export type AdmissionLimits = {
  maxCount: number
  // Aggregate reserved-byte ceiling; omit for count-only admission.
  maxBytes?: number
}

export type AdmissionLease = {
  readonly bytes: number
  readonly released: boolean
  // Idempotent: safe to call from multiple cleanup paths; only the first call releases capacity.
  release(): void
}

export class AdmissionController {
  private readonly maxCount: number
  private readonly maxBytes: number
  private count = 0
  private reserved = 0

  constructor(limits: AdmissionLimits) {
    if (!Number.isSafeInteger(limits.maxCount) || limits.maxCount < 1) {
      throw new RangeError('AdmissionController maxCount must be a positive safe integer')
    }
    this.maxCount = limits.maxCount
    this.maxBytes = limits.maxBytes ?? Number.POSITIVE_INFINITY
  }

  get activeCount(): number {
    return this.count
  }

  get reservedBytes(): number {
    return this.reserved
  }

  // Returns a lease, or null if admitting `bytes` would exceed a ceiling (non-throwing).
  tryAcquire(bytes = 0): AdmissionLease | null {
    const reserve = Math.max(0, bytes)
    if (this.count + 1 > this.maxCount || this.reserved + reserve > this.maxBytes) {
      return null
    }
    this.count += 1
    this.reserved += reserve
    return this.makeLease(reserve)
  }

  // Throwing variant for call sites that treat overload as an error to surface.
  acquire(bytes = 0): AdmissionLease {
    const reserve = Math.max(0, bytes)
    if (this.count + 1 > this.maxCount) {
      throw new AdmissionCapacityError('count')
    }
    if (this.reserved + reserve > this.maxBytes) {
      throw new AdmissionCapacityError('bytes')
    }
    this.count += 1
    this.reserved += reserve
    return this.makeLease(reserve)
  }

  private makeLease(reserve: number): AdmissionLease {
    let released = false
    // Arrow keeps `this` bound to the controller without aliasing it (oxlint no-this-alias).
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      this.count -= 1
      this.reserved -= reserve
    }
    return {
      bytes: reserve,
      get released() {
        return released
      },
      release
    }
  }
}

// Run `fn` under an admission lease, releasing in finally so no throw/return can strand the reservation.
export async function withAdmission<T>(
  controller: AdmissionController,
  bytes: number,
  fn: () => Promise<T> | T
): Promise<T> {
  const lease = controller.acquire(bytes)
  try {
    return await fn()
  } finally {
    lease.release()
  }
}
