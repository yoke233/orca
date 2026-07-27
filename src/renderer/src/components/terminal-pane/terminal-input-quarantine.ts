// A replaced daemon endpoint may reattach to a fresh shell while the tail of
// an interrupted compound command is still arriving.
const QUARANTINE_MAX_MS = 5_000
const QUARANTINE_IDLE_MS = 700
const LINE_TERMINATORS = ['\r', '\n', '\x03']

type QuarantineEntry = {
  armedAt: number
  lastInputAt: number | null
}

const quarantineByTabId = new Map<string, QuarantineEntry>()

function containsLineTerminator(data: string): boolean {
  return LINE_TERMINATORS.some((terminator) => data.includes(terminator))
}

export function armTerminalInputQuarantine(tabId: string, now: number = Date.now()): void {
  for (const [otherTabId, entry] of quarantineByTabId) {
    if (now - entry.armedAt >= QUARANTINE_MAX_MS) {
      quarantineByTabId.delete(otherTabId)
    }
  }
  quarantineByTabId.set(tabId, { armedAt: now, lastInputAt: null })
}

export function isTerminalInputQuarantined(tabId: string): boolean {
  return quarantineByTabId.has(tabId)
}

export function shouldDropQuarantinedTerminalInput(
  tabId: string,
  data: string,
  now: number = Date.now()
): boolean {
  const entry = quarantineByTabId.get(tabId)
  if (!entry) {
    return false
  }
  if (now - entry.armedAt >= QUARANTINE_MAX_MS) {
    quarantineByTabId.delete(tabId)
    return false
  }
  if (entry.lastInputAt !== null && now - entry.lastInputAt >= QUARANTINE_IDLE_MS) {
    quarantineByTabId.delete(tabId)
    return false
  }
  entry.lastInputAt = now
  if (containsLineTerminator(data)) {
    quarantineByTabId.delete(tabId)
  }
  return true
}

export function _resetTerminalInputQuarantineForTests(): void {
  quarantineByTabId.clear()
}
