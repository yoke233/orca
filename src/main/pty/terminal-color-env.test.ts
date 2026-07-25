import { describe, expect, it } from 'vitest'
import { removeInheritedNoColor, withTerminalPaletteEnv } from './terminal-color-env'

describe('terminal color env', () => {
  it('removes inherited color-disable variables from spawned terminal env', () => {
    const env = {
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CLICOLOR: '0',
      TERM: 'xterm-256color'
    }

    removeInheritedNoColor(env)

    expect(env).toEqual({ TERM: 'xterm-256color' })
  })

  it('preserves explicit color-enable variables', () => {
    const env = {
      FORCE_COLOR: '1',
      CLICOLOR: '1'
    }

    removeInheritedNoColor(env)

    expect(env).toEqual({
      FORCE_COLOR: '1',
      CLICOLOR: '1'
    })
  })

  it('maps the pane background to COLORFGBG indices for TUIs that never query', () => {
    expect(withTerminalPaletteEnv({ TERM: 'xterm-256color' }, { background: '#ffffff' })).toEqual({
      TERM: 'xterm-256color',
      COLORFGBG: '0;15',
      CLICOLOR: '1'
    })
    expect(withTerminalPaletteEnv(undefined, { background: 'rgb(30, 30, 30)' })).toEqual({
      COLORFGBG: '15;0',
      CLICOLOR: '1'
    })
  })

  it('leaves env untouched without a usable background and never overrides CLICOLOR', () => {
    expect(withTerminalPaletteEnv({ TERM: 'dumb' }, undefined)).toEqual({ TERM: 'dumb' })
    expect(withTerminalPaletteEnv({ TERM: 'dumb' }, { background: 'var(--bg)' })).toEqual({
      TERM: 'dumb'
    })
    expect(withTerminalPaletteEnv({ CLICOLOR: '0' }, { background: '#ffffff' })).toEqual({
      CLICOLOR: '0',
      COLORFGBG: '0;15'
    })
  })
})
