import { afterEach, describe, expect, it } from 'vitest'
import {
  OMP_17_1_0_COLOR_STARTUP_BYTES,
  OMP_17_1_0_DA1_SENTINEL,
  OMP_17_1_0_MODE_2031_SUBSCRIBE
} from '../../shared/omp-startup-probe.test-fixture'
import { Session } from './session'

describe('daemon Session OMP startup ordering', () => {
  let session: Session | null = null

  afterEach(() => {
    session?.dispose()
    session = null
  })

  it('queues the OSC 11 reply before fanout can expose the following DA1', () => {
    const written: string[] = []
    let emitOutput = (_data: string): void => {
      throw new Error('Session did not attach its subprocess output listener')
    }
    const subprocess = {
      pid: 12345,
      write: (data: string) => written.push(data),
      resize: () => {},
      pause: () => {},
      resume: () => {},
      clear: () => {},
      kill: () => {},
      getForegroundProcess: () => null,
      onData: (callback: (data: string) => void) => {
        emitOutput = callback
      },
      onExit: () => {}
    }
    session = new Session({
      sessionId: 'omp-startup-order',
      cols: 80,
      rows: 24,
      subprocess: subprocess as never,
      ownerBackend: 'posix-pty',
      shellReadySupported: false,
      startupIngress: {
        colors: { foreground: '#2e3434', background: '#ffffff' },
        deadlineMs: 5_000
      }
    })
    session.closeStartupQueryAuthority()
    const received: string[] = []
    session.attachClient({
      onData: (data) => {
        if (data.includes(OMP_17_1_0_DA1_SENTINEL)) {
          expect(written).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
        }
        received.push(data)
      },
      onExit: () => {}
    })

    emitOutput(OMP_17_1_0_COLOR_STARTUP_BYTES)

    expect(written).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
    expect(received.join('')).toBe(OMP_17_1_0_DA1_SENTINEL + OMP_17_1_0_MODE_2031_SUBSCRIBE)
    expect(session.getSnapshot()?.snapshotAnsi).not.toContain(']11;rgb')
    expect(session.getSnapshot()?.snapshotAnsi).not.toContain('?997')
  })
})
