import type { IDisposable, IParser } from '@xterm/xterm'

type InternalBuffer = {
  scrollTop: number
  scrollBottom: number
}

type TerminalWithScrollInternals = {
  parser: Pick<IParser, 'registerCsiHandler'>
  _core?: {
    _bufferService?: {
      buffer: InternalBuffer
      buffers: { normal: InternalBuffer }
      scroll: (eraseAttr: unknown) => void
    }
    _inputHandler?: {
      _eraseAttrData?: () => unknown
    }
  }
}

type TerminalCodexScrollbackCompatibilityOptions = {
  terminal: TerminalWithScrollInternals
  shouldHandle: () => boolean
}

export function installTerminalCodexWindowsScrollbackCompatibility(
  options: TerminalCodexScrollbackCompatibilityOptions
): IDisposable {
  return options.terminal.parser.registerCsiHandler({ final: 'S' }, (params) => {
    let mutated = false
    try {
      if (!options.shouldHandle()) {
        return false
      }
      const core = options.terminal._core
      // Why: xterm exposes interception publicly but not the scrollback-preserving primitive.
      const bufferService = core?._bufferService
      const inputHandler = core?._inputHandler
      const buffer = bufferService?.buffer
      if (
        !bufferService ||
        !inputHandler?._eraseAttrData ||
        !buffer ||
        buffer !== bufferService.buffers.normal ||
        buffer.scrollTop !== 0
      ) {
        return false
      }
      const regionRows = buffer.scrollBottom - buffer.scrollTop + 1
      if (!Number.isInteger(regionRows) || regionRows <= 0) {
        return false
      }
      const firstParam = params[0]
      if (params.length > 1 || Array.isArray(firstParam)) {
        return false
      }
      const requested = typeof firstParam === 'number' && firstParam > 0 ? firstParam : 1
      const amount = Math.min(Math.floor(requested), regionRows)
      const eraseAttr = inputHandler._eraseAttrData()
      for (let index = 0; index < amount; index += 1) {
        bufferService.scroll(eraseAttr)
        mutated = true
      }
      return true
    } catch {
      return mutated
    }
  })
}
