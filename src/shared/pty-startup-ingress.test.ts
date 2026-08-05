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
const FOREGROUND_REPLY = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
const BACKGROUND_REPLY = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
// The two echo shapes a cooked POSIX tty produces for a written reply: ECHOCTL
// caret forms, and readline eating `ESC ]` / ST while self-inserting the rest.
const POSIX_COOKED_ECHOES = [
  (reply: string): string => reply.replaceAll('\x1b', '^['),
  (reply: string): string => reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
]

function createHarness(
  options: {
    projection?: boolean
    nested?: (data: string) => void
  } = {}
) {
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

  it('recognizes BEL/ST queries at every split and defers canonical replies', () => {
    vi.useFakeTimers()
    const query = '\x1b]10;?\x07\x1b]11;?\x1b\\'
    for (let split = 0; split <= query.length; split += 1) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept(query.slice(0, split))
      ingress.accept(query.slice(split))
      // Why: answering inside the query's own turn beats the querying program's
      // tcsetattr, so a cooked tty echoes the reply as text instead (#12112).
      expect(writes, `split ${split}`).toEqual([])
      vi.advanceTimersByTime(0)
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
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    let ingress!: PtyStartupIngress
    ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      write: () => ingress.accept('nested'),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('before\x1b]10;?\x07after')
    vi.advanceTimersByTime(0)
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
                  ownerBackend: 'windows-conpty',
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

  it('answers both Codex color slots after startup query authority close is requested', () => {
    const queries = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
    for (let split = 0; split <= queries.length; split += 1) {
      const { ingress, writes, emissions } = createHarness({ projection: true })
      ingress.closeQueryAuthority()

      ingress.accept(queries.slice(0, split))
      ingress.accept(queries.slice(split))

      expect(writes, `split ${split}`).toEqual([
        '\x1b]10;rgb:2e2e/3434/3434\x1b\\',
        '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
      ])
      expect(visible(emissions), `split ${split}`).toBe('')
    }
  })

  it('releases an unanswerable native ConPTY color query to the downstream responder at every split', () => {
    // Why: bundled ConPTY forwards the query instead of answering it. Consuming a query this
    // transaction cannot answer leaves the agent with the pseudoconsole palette (#0c0c0c).
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
      expect(visible(emissions), `split ${split}`).toBe(query)
    }
  })

  it('releases native ConPTY queries after the startup deadline and after both slots are answered', () => {
    vi.useFakeTimers()
    const expired = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: () => {},
      onEmission: () => {}
    })
    const expiredEmissions: PtyIngressEmission[] = []
    const expiredWrites: string[] = []
    const lateIngress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => expiredWrites.push(data),
      onEmission: (emission) => expiredEmissions.push(emission)
    })
    expired.drainAndClose()
    vi.advanceTimersByTime(5_001)
    lateIngress.accept('\x1b]11;?\x1b\\')

    expect(expiredWrites).toEqual([])
    expect(visible(expiredEmissions)).toBe('\x1b]11;?\x1b\\')

    const secondWrites: string[] = []
    const secondEmissions: PtyIngressEmission[] = []
    const answered = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => secondWrites.push(data),
      onEmission: (emission) => secondEmissions.push(emission)
    })
    answered.accept('\x1b]10;?\x1b\\\x1b]11;?\x1b\\')
    const answeredWrites = [...secondWrites]
    secondEmissions.length = 0
    answered.accept('\x1b]11;?\x1b\\')

    expect(answeredWrites).toEqual([
      '\x1b]10;rgb:2e2e/3434/3434\x1b\\',
      '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
    ])
    expect(secondWrites).toEqual(answeredWrites)
    expect(visible(secondEmissions)).toBe('\x1b]11;?\x1b\\')
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

  it('releases a split native ConPTY query losslessly across close, expiry, and snapshot barriers', () => {
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

      ingress.accept('?\x07')

      expect(visible(emissions), barrier).toBe('\x1b]10;?\x07')
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
    vi.useFakeTimers()
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
    vi.advanceTimersByTime(0)

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
    expect(visible(emissions)).toBe(`${input}\x1b]10;?\x07`)
  })

  it('swallows a cooked POSIX echo of its own reply without re-sending it', () => {
    // Why never re-send: POSIX ECHO copies the reply to the master but leaves it in
    // the slave input queue, so the program still reads it; a second write would
    // arrive on its stdin as unsolicited input once it is raw.
    vi.useFakeTimers()
    for (const echoOf of POSIX_COOKED_ECHOES) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      let ingress!: PtyStartupIngress
      ingress = new PtyStartupIngress({
        intent: { colors: COLORS, deadlineMs: 5_000 },
        ownerBackend: 'posix-pty',
        write: (data) => {
          writes.push(data)
          ingress.accept(echoOf(data))
        },
        onEmission: (emission) => emissions.push(emission)
      })

      ingress.accept('\x1b]10;?\x07')
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([FOREGROUND_REPLY])
      expect(visible(emissions)).toBe('')

      vi.advanceTimersByTime(5_000)
      expect(writes).toEqual([FOREGROUND_REPLY])
      expect(visible(emissions)).toBe('')
      ingress.drainAndClose()
    }
  })

  it('swallows a cooked POSIX echo coalesced behind earlier program output', () => {
    // Why this shape: an agent pane is launched by writing a command into an interactive
    // shell, so the tty echo of Orca's reply never arrives at the head of a read (#12112).
    vi.useFakeTimers()
    for (const echoOf of POSIX_COOKED_ECHOES) {
      const replies: string[] = []
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        intent: { colors: COLORS, deadlineMs: 5_000 },
        ownerBackend: 'posix-pty',
        write: (data) => replies.push(data),
        onEmission: (emission) => emissions.push(emission)
      })

      ingress.accept('\x1b]10;?\x07\x1b]11;?\x07')
      vi.advanceTimersByTime(0)
      expect(replies).toHaveLength(2)

      // A read with no echo in it must not retire the projections either.
      ingress.accept('booting...\r\n')
      ingress.accept(`\x1b[2JFRAME${replies.map((reply) => echoOf(reply)).join('')}`)
      ingress.drainAndClose()

      expect(visible(emissions)).toBe('booting...\r\n\x1b[2JFRAME')
    }
  })

  it('answers both slots when the deferred write lands between two reads of the burst', () => {
    // Why between: a pty read boundary is a macrotask, so the deferred reply is written
    // while the rest of the burst is still unread. A `\x07` head-of-echo guess taken then
    // steals the OSC 11 terminator, leaving the slot unanswered and its bytes emitted
    // after the BEL — which parks xterm in an OSC that never terminates.
    vi.useFakeTimers()
    const burst = '\x1b]10;?\x07\x1b]11;?\x07'
    for (let split = 0; split <= burst.length; split += 1) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept(burst.slice(0, split))
      vi.advanceTimersByTime(0)
      ingress.accept(burst.slice(split))
      vi.advanceTimersByTime(0)
      ingress.drainAndClose()

      expect(writes, `split ${split}`).toEqual([FOREGROUND_REPLY, BACKGROUND_REPLY])
      expect(visible(emissions), `split ${split}`).toBe('')
    }
  })

  it('keeps raw ranges disjoint when an echo lands on a retained torn query', () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    ingress.accept('\x1b]10;?\x07\x1b]11;?')
    vi.advanceTimersByTime(0)
    ingress.accept(`${writes[0]?.replaceAll('\x1b', '^[')}tail`)
    const accepted = ingress.drainAndClose()

    expect(visible(emissions)).toBe('\x1b]11;?tail')
    // Why exact ranges: a candidate carried across the suppressed echo re-emits its own
    // bytes on a span whose end no longer matches its data, so ranges start to overlap.
    expect(emissions.map((item) => [item.rawStartSeq, item.rawEndSeq])).toEqual([
      [0, 7],
      [7, 13],
      [13, 40],
      [40, accepted]
    ])
  })

  it('releases a partial echo hold long before the startup deadline', () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([FOREGROUND_REPLY])

    // Why a range and not the exact hold: what matters is that the guess outlasts
    // relay jitter yet still resolves without the deadline's help. Pinning the exact
    // value would fail on any honest retune while teaching the retuner nothing.
    const RELAY_JITTER_MS = 400
    const WELL_BELOW_DEADLINE_MS = 1_500

    // A lone BEL is the head of the readline echo projection, so it is held.
    ingress.accept('\x07')
    expect(visible(emissions)).toBe('')
    vi.advanceTimersByTime(RELAY_JITTER_MS)
    expect(visible(emissions)).toBe('')
    vi.advanceTimersByTime(WELL_BELOW_DEADLINE_MS - RELAY_JITTER_MS)

    expect(visible(emissions)).toBe('\x07')
    ingress.drainAndClose()
  })

  it('still swallows the echo of a reply the startup deadline raced', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    vi.advanceTimersByTime(4_999)
    ingress.accept('\x1b]10;?\x07')
    // The deferred write flushes at 4_999, then the deadline expires at 5_000.
    vi.advanceTimersByTime(2)
    expect(writes).toEqual([FOREGROUND_REPLY])

    ingress.accept(FOREGROUND_REPLY.replaceAll('\x1b', '^['))
    ingress.drainAndClose()
    expect(visible(emissions)).toBe('')
  })

  it('writes a reply the startup deadline raced instead of dropping it', () => {
    // Why: the query span was already consumed, so nobody downstream can answer it.
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    vi.advanceTimersByTime(4_999)
    ingress.accept('\x1b]10;?\x07')
    expect(writes).toEqual([])
    vi.advanceTimersByTime(1)

    expect(visible(emissions)).toBe('')
    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.drainAndClose()
  })

  it('keeps the synchronous write for ConPTY-hosted wsl.exe panes', () => {
    // Why: a Windows-hosted pty must be answered before conhost's own responder.
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-wsl',
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    ingress.accept('\x1b]10;?\x07')
    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.drainAndClose()
  })
})
