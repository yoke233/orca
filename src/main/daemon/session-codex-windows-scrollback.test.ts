import { afterEach, describe, expect, it } from 'vitest'

import { Session } from './session'

function createSubprocess() {
  let emitData: ((data: string) => void) | null = null
  return {
    pid: 12345,
    write() {},
    resize() {},
    pause() {},
    resume() {},
    clear() {},
    kill() {},
    forceKill() {},
    signal() {},
    dispose() {},
    getForegroundProcess: () => null,
    onData(callback: (data: string) => void) {
      emitData = callback
    },
    onExit() {},
    emit(data: string) {
      emitData?.(data)
    }
  }
}

describe('Session Codex Windows scrollback compatibility', () => {
  let session: Session | null = null

  afterEach(() => {
    session?.dispose()
    session = null
  })

  it.each([
    ['Codex on native ConPTY', 'codex', 'windows-conpty', 2],
    ['Codex on a POSIX PTY', 'codex', 'posix-pty', 0],
    ['another TUI on native ConPTY', 'claude', 'windows-conpty', 0]
  ] as const)('gates compatibility for %s', async (_label, launchAgent, ownerBackend, expected) => {
    const subprocess = createSubprocess()
    session = new Session({
      sessionId: 'scrollback-test',
      cols: 20,
      rows: 6,
      launchAgent,
      ownerBackend,
      subprocess,
      shellReadySupported: false
    })
    subprocess.emit('A01\r\nA02\r\nA03\r\nA04\r\nA05\r\nA06')
    subprocess.emit('\x1b[1;4r\x1b[2S\x1b[r')
    await Promise.resolve()
    await Promise.resolve()

    expect(session.getSnapshot()?.scrollbackLines).toBe(expected)
  })
})
