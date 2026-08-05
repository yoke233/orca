export type HomeWorktreeSummary = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  isActive?: boolean
  lastOutputAt?: number
}

export type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: HomeWorktreeSummary | null
  catalogUnavailable?: boolean
  // The counts are the last proven ones, kept across a failed refresh.
  staleCounts?: boolean
  // When the host last answered with these counts (ms epoch); absent in snapshots an older
  // build persisted, which is why an unstamped count counts as expired rather than fresh.
  countsProvenAt?: number
}

// Why: the home snapshot is persisted across launches, so counts could otherwise be rendered as
// live while describing a workspace set proven days ago. Past this window they are only history.
export const HOME_WORKTREE_COUNTS_LIVE_MAX_AGE_MS = 10 * 60_000

export type HomeHostWorktreeSummaryFormatter = {
  unavailable: string
  worktrees: (count: number) => string
  active: (count: number) => string
  lastKnown: (summary: string) => string
}

const DEFAULT_HOME_HOST_WORKTREE_SUMMARY_FORMATTER: HomeHostWorktreeSummaryFormatter = {
  unavailable: 'Worktree list unavailable',
  worktrees: (count) => `${count} worktree${count === 1 ? '' : 's'}`,
  active: (count) => ` · ${count} active`,
  lastKnown: (summary) => `Last known: ${summary}`
}

export function markHomeWorktreeCatalogUnavailable(
  current: HostWorktreeInfo | undefined,
  hostId: string
): HostWorktreeInfo {
  if (current?.catalogUnavailable) {
    return current
  }
  if (current) {
    // Why: `current` predates this failure, so its counts are proven host truth — a dropped
    // socket must not erase them, only flag them as no longer live.
    return { ...current, catalogUnavailable: true, staleCounts: true }
  }
  return {
    hostId,
    totalWorktrees: 0,
    activeCount: 0,
    lastActiveWorktree: null,
    catalogUnavailable: true
  }
}

/** The host card's worktree line, or null when nothing is known yet. */
export function homeHostWorktreeSummary(
  info: HostWorktreeInfo | undefined,
  now: number = Date.now(),
  formatter: HomeHostWorktreeSummaryFormatter = DEFAULT_HOME_HOST_WORKTREE_SUMMARY_FORMATTER
): string | null {
  if (!info) {
    return null
  }
  // Why (STA-3123): a catalog that never loaded must not assert a count the host has not proven.
  if (info.catalogUnavailable && !info.staleCounts) {
    return formatter.unavailable
  }
  const counts = `${formatter.worktrees(info.totalWorktrees)}${
    info.activeCount > 0 ? formatter.active(info.activeCount) : ''
  }`
  // Age bounds liveness, not the counts themselves: a failed refresh — or a rehydrated snapshot the
  // host has not re-confirmed — is still the last thing it told us, so keep it and drop the claim
  // that it is current.
  return info.staleCounts || !provenRecently(info, now) ? formatter.lastKnown(counts) : counts
}

function provenRecently(info: HostWorktreeInfo, now: number): boolean {
  // A snapshot written before countsProvenAt existed has an unknowable age; treat it as expired.
  return (
    typeof info.countsProvenAt === 'number' &&
    now - info.countsProvenAt <= HOME_WORKTREE_COUNTS_LIVE_MAX_AGE_MS
  )
}
