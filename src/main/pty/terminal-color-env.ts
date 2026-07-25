import { cssColorToOscRgb } from '../../shared/terminal-osc-color-reply'

function backgroundIsLight(background: unknown): boolean | null {
  const osc = typeof background === 'string' ? cssColorToOscRgb(background) : null
  if (!osc) {
    return null
  }
  const [red, green, blue] = osc
    .slice('rgb:'.length)
    .split('/')
    .map((channel) => Number.parseInt(channel.slice(0, 2), 16))
  if (red === undefined || green === undefined || blue === undefined) {
    return null
  }
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 > 0.5
}

/**
 * Palette hints for TUIs that never issue an OSC 10/11 query, or whose query window closed
 * before an answer arrived. Codex ignores these (it reads the pseudoconsole palette on Windows),
 * but vim, termbg, and terminal-light consumers honor COLORFGBG.
 */
export function withTerminalPaletteEnv(
  env: Record<string, string> | undefined,
  colors: { foreground?: unknown; background?: unknown } | undefined
): Record<string, string> | undefined {
  const light = backgroundIsLight(colors?.background)
  if (light === null) {
    return env
  }
  return {
    ...env,
    // Why: rxvt's convention carries palette indices only, so map to the nearest black/white pair.
    COLORFGBG: light ? '0;15' : '15;0',
    ...(env?.CLICOLOR === undefined ? { CLICOLOR: '1' } : {})
  }
}

export function removeInheritedNoColor(env: Record<string, string>): void {
  // Why: Orca can be launched by agent/dev shells that disable color for their
  // own logs. A terminal emulator should not inherit that parent-only choice;
  // if the user's login shell exports these, startup files can still set them.
  delete env.NO_COLOR
  if (env.FORCE_COLOR === '0') {
    delete env.FORCE_COLOR
  }
  if (env.CLICOLOR === '0') {
    delete env.CLICOLOR
  }
}
