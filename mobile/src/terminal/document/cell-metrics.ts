import type { TerminalDocumentScope } from './document-scope'

export function getCellHeight(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.term._core) {
    return 15
  }
  const core = scope.term._core
  if (core._renderService && core._renderService.dimensions) {
    return core._renderService.dimensions.css.cell.height || 15
  }
  return 15
}

export function getCellWidth(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.term._core) {
    return 0
  }
  const core = scope.term._core
  if (core._renderService && core._renderService.dimensions) {
    return core._renderService.dimensions.css.cell.width || 0
  }
  return 0
}

export function getTotalScale(scope: TerminalDocumentScope) {
  return scope.currentScale * scope.userScale
}
