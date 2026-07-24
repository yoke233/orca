import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from './pty-startup-ingress'
import {
  OMP_17_1_0_COLOR_STARTUP_BYTES,
  OMP_17_1_0_DA1_SENTINEL,
  OMP_17_1_0_MODE_2031_SUBSCRIBE,
  OMP_17_1_0_OSC11_QUERY
} from './omp-startup-probe.test-fixture'

const COLORS = { foreground: '#2e3434', background: '#ffffff' }

function createHarness(options: { projection?: boolean; nested?: (data: string) => void } = {}) {
  const emissions: PtyIngressEmission[] = []
  let ingress!: PtyStartupIngress
  const writes: string[] = []
  ingress = new PtyStartupIngress({
    intent: {
      colors: COLORS,
      deadlineMs: 5_000
    },
    ...(options.projection ? { ownerBackend: 'windows-conpty' as const } : {}),
    write: (data) => {
      writes.push(data)
      options.nested?.(data)
    },
    onEmission: (emission) => emissions.push(emission)
  })
  return { ingress, writes, emissions }
}

function visible(emissions: readonly PtyIngressEmission[]): string {
  return emissions.map((emission) => emission.data).join('')
}

describe('PtyStartupIngress', () => {
  afterEach(() => vi.useRealTimers())

  it('validates intent colors and deadline bounds', () => {
    const intent = {
      colors: COLORS,
      deadlineMs: 5_000
    }
    expect(parsePtyStartupIngressIntent(intent)).toEqual(intent)
    expect(parsePtyStartupIngressIntent({ ...intent, deadlineMs: 30_001 })).toBeUndefined()
  })

  it('recognizes BEL/ST queries at every split and emits canonical replies', () => {
    const query = '\x1b]10;?\x07\x1b]11;?\x1b\\'
    for (let split = 0; split <= query.length; split += 1) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept(query.slice(0, split))
      ingress.accept(query.slice(split))
      ingress.drainAndClose()
      expect(visible(emissions), `split ${split}`).toBe('')
      expect(writes, `split ${split}`).toEqual([
        '\x1b]10;rgb:2e2e/3434/3434\x1b\\',
        '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
      ])
      expect(emissions.reduce((sum, item) => sum + item.rawEndSeq - item.rawStartSeq, 0)).toBe(
        query.length
      )
    }
  })

  it('suppresses the first echo immediately and keeps a later exact collision', () => {
    const { ingress, emissions } = createHarness({ projection: true })
    ingress.accept('\x1b]10;?\x07')
    const projected = ']10;rgb:2e2e/3434/3434\\'
    ingress.accept(projected)
    ingress.accept(projected)
    ingress.drainAndClose()
    expect(visible(emissions)).toBe(projected)
  })

  it('matches each echo across every split without skipping an earlier FIFO candidate', () => {
    const foregroundEcho = ']10;rgb:2e2e/3434/3434\\'
    const backgroundEcho = ']11;rgb:ffff/ffff/ffff\\'
    for (const projected of [foregroundEcho, backgroundEcho]) {
      for (let split = 0; split <= projected.length; split += 1) {
        const { ingress, emissions } = createHarness({ projection: true })
        ingress.accept(projected === foregroundEcho ? '\x1b]10;?\x07' : '\x1b]11;?\x1b\\')
        ingress.accept(projected.slice(0, split))
        ingress.accept(projected.slice(split))
        ingress.drainAndClose()
        expect(visible(emissions), `${projected.slice(0, 3)} split ${split}`).toBe('')
      }
    }

    const fifo = createHarness({ projection: true })
    fifo.ingress.accept('\x1b]10;?;?\x1b\\')
    fifo.ingress.accept(backgroundEcho)
    fifo.ingress.accept(backgroundEcho)
    fifo.ingress.drainAndClose()
    expect(visible(fifo.emissions)).toBe(backgroundEcho)
  })

  it('releases partial echo bytes on mismatch, timeout, and snapshot barrier', () => {
    vi.useFakeTimers()
    const mismatch = createHarness({ projection: true })
    mismatch.ingress.accept('\x1b]10;?\x07')
    mismatch.ingress.accept(']10;rgb:2e2e/nope')
    expect(visible(mismatch.emissions)).toBe(']10;rgb:2e2e/nope')

    const timeout = createHarness({ projection: true })
    timeout.ingress.accept('\x1b]10;?\x07')
    timeout.ingress.accept(']10;rgb:2e2e/')
    vi.advanceTimersByTime(5_000)
    expect(visible(timeout.emissions)).toBe(']10;rgb:2e2e/')

    const snapshot = createHarness({ projection: true })
    snapshot.ingress.accept('\x1b]10;?\x07')
    snapshot.ingress.accept(']10;rgb:2e2e/')
    snapshot.ingress.snapshotBarrier()
    expect(visible(snapshot.emissions)).toBe(']10;rgb:2e2e/')

    snapshot.ingress.accept('\x1b]11;?\x07')
    expect(snapshot.writes.at(-1)).toBe('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
  })

  it('serializes a synchronous nested provider callback after the consumed query span', () => {
    const emissions: PtyIngressEmission[] = []
    let ingress!: PtyStartupIngress
    ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      write: () => ingress.accept('nested'),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('before\x1b]10;?\x07after')
    ingress.drainAndClose()
    expect(emissions.map(({ data, transformed }) => ({ data, transformed }))).toEqual([
      { data: 'before', transformed: false },
      { data: '', transformed: true },
      { data: 'after', transformed: false },
      { data: 'nested', transformed: false }
    ])
  })

  it('keeps the OMP OSC 11 reply ahead of DA1 across startup perturbations', () => {
    vi.useFakeTimers()
    const delays = [0, 25, 75, 150] as const
    const themes = [
      { colors: COLORS, reply: '\x1b]11;rgb:ffff/ffff/ffff\x1b\\' },
      {
        colors: { foreground: '#f5f5f4', background: '#111827' },
        reply: '\x1b]11;rgb:1111/1818/2727\x1b\\'
      }
    ] as const

    for (const [themeIndex, theme] of themes.entries()) {
      for (const terminator of ['\x07', '\x1b\\']) {
        const probe = OMP_17_1_0_COLOR_STARTUP_BYTES.replace(
          OMP_17_1_0_OSC11_QUERY,
          `\x1b]11;?${terminator}`
        )
        for (const split of [false, true]) {
          for (let repetition = 0; repetition < 20; repetition += 1) {
            const events: string[] = []
            const emissions: PtyIngressEmission[] = []
            const heldOutput: string[] = []
            let closeRequested = false
            let ingress: PtyStartupIngress | null = null
            const acceptOutput = (data: string): void => {
              if (ingress) {
                ingress.accept(data)
              } else {
                heldOutput.push(data)
              }
            }

            setTimeout(
              () => {
                ingress = new PtyStartupIngress({
                  intent: { colors: theme.colors, deadlineMs: 5_000 },
                  write: (data) => events.push(`input:${data}`),
                  onEmission: (emission) => {
                    emissions.push(emission)
                    if (emission.data.includes(OMP_17_1_0_DA1_SENTINEL)) {
                      events.push('output:DA1')
                    }
                  }
                })
                if (closeRequested) {
                  ingress.closeQueryAuthority()
                }
                for (const data of heldOutput) {
                  ingress.accept(data)
                }
              },
              delays[(repetition + themeIndex + 2) % delays.length]
            )
            setTimeout(
              () => {
                if (ingress) {
                  ingress.closeQueryAuthority()
                } else {
                  closeRequested = true
                }
              },
              delays[(repetition + 1) % delays.length]
            )
            setTimeout(
              () => {
                if (split) {
                  const boundary = probe.indexOf(OMP_17_1_0_DA1_SENTINEL)
                  acceptOutput(probe.slice(0, boundary))
                  acceptOutput(probe.slice(boundary))
                } else {
                  acceptOutput(probe)
                }
              },
              delays[repetition % delays.length]
            )

            vi.runAllTimers()

            expect(events, `${terminator} split=${split} run=${repetition}`).toEqual([
              `input:${theme.reply}`,
              'output:DA1'
            ])
            const visibleOutput = visible(emissions)
            expect(visibleOutput).toBe(OMP_17_1_0_DA1_SENTINEL + OMP_17_1_0_MODE_2031_SUBSCRIBE)
            expect(visibleOutput).not.toContain(']11;rgb')
            expect(visibleOutput).not.toContain('?997')
          }
        }
      }
    }
  })

  it('consumes a native ConPTY color query before any downstream responder at every split', () => {
    const query = '\x1b]11;?\x1b\\'
    for (let split = 0; split <= query.length; split += 1) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ownerBackend: 'windows-conpty',
        write: (data) => writes.push(data),
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.closeQueryAuthority()
      ingress.accept(query.slice(0, split))
      ingress.accept(query.slice(split))
      ingress.drainAndClose()

      expect(writes, `split ${split}`).toEqual([])
      expect(visible(emissions), `split ${split}`).toBe('')
      expect(emissions, `split ${split}`).toEqual([
        { data: '', rawStartSeq: 0, rawEndSeq: query.length, transformed: true }
      ])
    }
  })

  it('keeps native ConPTY startup authority until it can answer with owner-supplied colors', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;')
    ingress.closeQueryAuthority()
    ingress.accept('?\x07')

    expect(writes).toEqual(['\x1b]10;rgb:2e2e/3434/3434\x1b\\'])
    expect(visible(emissions)).toBe('')
  })

  it('keeps a split native ConPTY query private across close, expiry, and snapshot barriers', () => {
    vi.useFakeTimers()
    for (const barrier of ['close', 'expire', 'snapshot'] as const) {
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ...(barrier === 'expire' ? { intent: { colors: COLORS, deadlineMs: 5_000 } } : {}),
        ownerBackend: 'windows-conpty',
        write: () => {},
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.accept('\x1b]10;')
      if (barrier === 'close') {
        ingress.closeQueryAuthority()
      } else if (barrier === 'expire') {
        vi.advanceTimersByTime(5_000)
      } else {
        ingress.snapshotBarrier()
      }
      expect(emissions, barrier).toEqual([])

      ingress.accept('?\x07')

      expect(visible(emissions), barrier).toBe('')
      expect(emissions, barrier).toEqual([
        { data: '', rawStartSeq: 0, rawEndSeq: '\x1b]10;?\x07'.length, transformed: true }
      ])
    }

    const malformedEmissions: PtyIngressEmission[] = []
    const malformed = new PtyStartupIngress({
      ownerBackend: 'windows-conpty',
      write: () => {},
      onEmission: (emission) => malformedEmissions.push(emission)
    })
    malformed.accept('\x1b]10;')
    malformed.snapshotBarrier()
    malformed.accept('not-a-query\x07')

    expect(visible(malformedEmissions)).toBe('\x1b]10;not-a-query\x07')
  })

  it('finishes a partial startup query after source authority close is requested', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;')
    expect(emissions).toEqual([])
    ingress.closeQueryAuthority()
    ingress.accept('?\x07')

    expect(writes).toEqual(['\x1b]10;rgb:2e2e/3434/3434\x1b\\'])
    expect(visible(emissions)).toBe('')
  })

  it('keeps POSIX, WSL, malformed, and unrelated output unchanged', () => {
    const input = 'typed\x1b[A\x1b]12;?\x1b\\\x1b]10;not-a-query\x07'
    vi.useFakeTimers()
    for (const ownerBackend of ['posix-pty', 'windows-wsl'] as const) {
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ownerBackend,
        write: () => {},
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.accept(`\x1b]10;?\x07${input}`)
      expect(visible(emissions)).toBe(`\x1b]10;?\x07${input}`)
    }

    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const nativeIngress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    vi.advanceTimersByTime(5_001)
    nativeIngress.accept(`${input}\x1b]10;?\x07`)

    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(input)
  })

  it('ignores callbacks after teardown without recreating the raw sequence domain', () => {
    const { ingress, emissions } = createHarness({ projection: true })
    ingress.accept('\x1b]10;?\x07')
    ingress.accept(']10;rgb:2e2e/')
    const closedAt = ingress.drainAndClose()
    ingress.accept('late')
    expect(ingress.acceptedRawSequence).toBe(closedAt)
    expect(visible(emissions)).toBe(']10;rgb:2e2e/')
  })
})
