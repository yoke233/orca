import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import { repositionOverlay, stopEdgeScroll } from './selection-overlay'
import { seedWordSelection } from './selection-range'

export function cancelSelect(scope: TerminalDocumentScope) {
  scope.selMode = 'navigate'
  scope.sel = null
  stopEdgeScroll(scope)
  if (scope.term) {
    try {
      scope.term.clearSelection()
    } catch {}
    // Why: some xterm renderers cache cells and skip repaint on
    // clearSelection alone, leaving the previously-highlighted cells
    // visually selected. Force a full refresh so the selection layer
    // actually clears on screen.
    try {
      scope.term.refresh(0, scope.term.rows - 1)
    } catch {}
  }
  scope.selectionOverlay!.classList.remove('active')
  notify(scope, { type: 'set-select-mode', enabled: false })
}

export function enterSelect(scope: TerminalDocumentScope, col: number, absRow: number) {
  scope.selMode = 'select'
  seedWordSelection(scope, col, absRow)
  scope.selectionOverlay!.classList.add('active')
  notify(scope, { type: 'set-select-mode', enabled: true })
  notify(scope, { type: 'haptic', kind: 'selection' })
  repositionOverlay(scope)
}
