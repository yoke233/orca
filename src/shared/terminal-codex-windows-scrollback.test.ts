import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'

import { installTerminalCodexWindowsScrollbackCompatibility } from './terminal-codex-windows-scrollback'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function bufferLines(terminal: Terminal): string[] {
  const buffer = terminal.buffer.normal
  return Array.from(
    { length: buffer.length },
    (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
  )
}

async function createScrolledTerminal(
  compatible: boolean,
  sequence = '\x1b[2S'
): Promise<Terminal> {
  const terminal = new Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true })
  if (compatible) {
    installTerminalCodexWindowsScrollbackCompatibility({
      terminal,
      shouldHandle: () => true
    })
  }
  await writeTerminal(terminal, 'A01\r\nA02\r\nA03\r\nA04\r\nA05\r\nA06')
  await writeTerminal(terminal, `\x1b[1;4r${sequence}\x1b[r`)
  return terminal
}

function cursorPosition(terminal: Terminal): [number, number] {
  return [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]
}

describe('Codex Windows scrollback compatibility', () => {
  it('preserves rows discarded by SU while keeping the visible screen equivalent', async () => {
    const defaultTerminal = await createScrolledTerminal(false)
    const compatibleTerminal = await createScrolledTerminal(true)
    try {
      expect(bufferLines(defaultTerminal)).not.toContain('A01')
      expect(bufferLines(compatibleTerminal)).toEqual(expect.arrayContaining(['A01', 'A02']))
      expect(compatibleTerminal.buffer.normal.baseY).toBe(2)
      expect(bufferLines(compatibleTerminal).slice(compatibleTerminal.buffer.normal.baseY)).toEqual(
        bufferLines(defaultTerminal)
      )
      expect(cursorPosition(compatibleTerminal)).toEqual(cursorPosition(defaultTerminal))
    } finally {
      defaultTerminal.dispose()
      compatibleTerminal.dispose()
    }
  })

  it('leaves alternate-screen SU on xterm default behavior', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true })
    installTerminalCodexWindowsScrollbackCompatibility({
      terminal,
      shouldHandle: () => true
    })
    try {
      await writeTerminal(terminal, '\x1b[?1049hB01\r\nB02\r\nB03\r\nB04\r\nB05\r\nB06')
      await writeTerminal(terminal, '\x1b[1;4r\x1b[2S\x1b[r')

      expect(terminal.buffer.active.type).toBe('alternate')
      expect(terminal.buffer.active.baseY).toBe(0)
      expect(
        Array.from(
          { length: terminal.buffer.active.length },
          (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? ''
        )
      ).not.toContain('B01')
    } finally {
      terminal.dispose()
    }
  })

  it('leaves a region below the first row on xterm default behavior', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true })
    installTerminalCodexWindowsScrollbackCompatibility({
      terminal,
      shouldHandle: () => true
    })
    try {
      await writeTerminal(terminal, 'C01\r\nC02\r\nC03\r\nC04\r\nC05\r\nC06')
      await writeTerminal(terminal, '\x1b[2;4r\x1b[2S\x1b[r')

      expect(terminal.buffer.normal.baseY).toBe(0)
      expect(bufferLines(terminal)).not.toContain('C02')
    } finally {
      terminal.dispose()
    }
  })

  it('clamps SU to the region height', async () => {
    const terminal = await createScrolledTerminal(true, '\x1b[999S')
    try {
      expect(terminal.buffer.normal.baseY).toBe(4)
      expect(bufferLines(terminal)).toEqual(
        expect.arrayContaining(['A01', 'A02', 'A03', 'A04', 'A05', 'A06'])
      )
    } finally {
      terminal.dispose()
    }
  })

  it('falls through to xterm when the compatibility is disabled', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true })
    installTerminalCodexWindowsScrollbackCompatibility({
      terminal,
      shouldHandle: () => false
    })
    try {
      await writeTerminal(terminal, 'D01\r\nD02\r\nD03\r\nD04\r\nD05\r\nD06')
      await writeTerminal(terminal, '\x1b[1;4r\x1b[2S\x1b[r')

      expect(terminal.buffer.normal.baseY).toBe(0)
      expect(bufferLines(terminal)).not.toContain('D01')
    } finally {
      terminal.dispose()
    }
  })

  it('falls through for nonstandard SU parameters', async () => {
    const terminal = await createScrolledTerminal(true, '\x1b[2;3S')
    try {
      expect(terminal.buffer.normal.baseY).toBe(0)
      expect(bufferLines(terminal)).not.toContain('A01')
    } finally {
      terminal.dispose()
    }
  })
})
