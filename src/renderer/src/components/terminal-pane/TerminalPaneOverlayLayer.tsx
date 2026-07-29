import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup, TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { shouldMountBackgroundWorktreeTab } from '../terminal/background-terminal-worktree-mount'
import { useNativeChatToggleShortcut } from '../native-chat/use-native-chat-toggle-shortcut'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
import { useTerminalOverlayPresentation } from './use-terminal-overlay-presentation'
import { buildTerminalOverlayAssignments } from './terminal-overlay-assignments'
import { TerminalOverlaySlot } from './TerminalOverlaySlot'

const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_ACTIVITY_PORTALS: ActivityTerminalPortalTarget[] = []

const TerminalPaneOverlayLayer = memo(function TerminalPaneOverlayLayer({
  worktreeId,
  worktreePath,
  isWorktreeActive,
  isWorktreePresented = isWorktreeActive,
  coldParkTerminalPanes = false,
  isForceParked = false,
  shouldMeasureHiddenWorktree = false,
  activityTerminalPortals = EMPTY_ACTIVITY_PORTALS,
  backgroundMountTabIds = null,
  activationDeferredMountTabIds = null,
  onInitialTerminalRenderSettled
}: {
  worktreeId: string
  worktreePath: string
  isWorktreeActive: boolean
  isWorktreePresented?: boolean
  coldParkTerminalPanes?: boolean
  /** Retention-budget force-park (C1 slice B): eviction-exempt tabs keep their mounted panes. */
  isForceParked?: boolean
  shouldMeasureHiddenWorktree?: boolean
  activityTerminalPortals?: ActivityTerminalPortalTarget[]
  /** Non-null for targeted background mounts: only these terminal tabs get a
   *  TerminalPane, so waking one slept agent does not connect every saved tab. */
  backgroundMountTabIds?: ReadonlySet<string> | null
  /** Only cold-activation deferred tabs receive immediate parked watcher
   *  coverage; targeted mounts keep their existing delayed parking policy. */
  activationDeferredMountTabIds?: ReadonlySet<string> | null
  onInitialTerminalRenderSettled?: (tabId: string) => void
}): React.JSX.Element | null {
  const { terminalTabs, unifiedTabs, groups, activeGroupId } = useAppStore(
    useShallow((state) => ({
      terminalTabs: state.tabsByWorktree[worktreeId] ?? EMPTY_TERMINAL_TABS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      activeGroupId: state.activeGroupIdByWorktree[worktreeId]
    }))
  )
  const focusGroup = useAppStore((state) => state.focusGroup)
  const consumeSuppressedPtyExit = useAppStore((state) => state.consumeSuppressedPtyExit)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const reconcileWorktreeTabModel = useAppStore((state) => state.reconcileWorktreeTabModel)

  useNativeChatToggleShortcut(worktreeId, isWorktreeActive)

  // Why: legacy TabGroupPanel routed terminal closes through
  // commands.closeItem → leaveWorktreeIfEmpty, which deselected the worktree
  // when the last renderable tab closed and sent the user back to Landing.
  // Run this only after the guarded close resolves; a pending/cancelled pinned
  // close must leave the worktree and paired-web mirror selected.
  const leaveWorktreeIfEmpty = useCallback(() => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    const { renderableTabCount } = reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }, [reconcileWorktreeTabModel, setActiveWorktree, worktreeId])

  const focusOwningGroup = useCallback(
    (groupId: string) => focusGroup(worktreeId, groupId),
    [focusGroup, worktreeId]
  )

  const assignments = useMemo(
    () => buildTerminalOverlayAssignments(groups, unifiedTabs),
    [groups, unifiedTabs]
  )

  const { parkedTerminalTabIds, coldParkedTerminalTabIds } = useTerminalTabColdParking({
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    coldParkTerminalPanes,
    isForceParked,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds
  })
  const { presentedTerminalTabIdByGroup: presentationByScope, handleInitialRenderSettled } =
    useTerminalOverlayPresentation({
      groups,
      terminalTabs,
      assignments,
      coldParkedTerminalTabIds,
      isWorktreeActive,
      activeGroupId,
      onInitialTerminalRenderSettled
    })

  if (!worktreePath) {
    return null
  }

  return (
    <>
      {terminalTabs
        .filter((terminalTab) =>
          shouldMountBackgroundWorktreeTab(backgroundMountTabIds, terminalTab.id)
        )
        .map((terminalTab) => {
          const assignment = assignments.get(terminalTab.id)
          const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
          const isActive = Boolean(isVisible && assignment && assignment.groupId === activeGroupId)
          const isPresented = Boolean(
            assignment && presentationByScope.get(assignment.groupId) === terminalTab.id
          )
          const activityTerminalPortal = findActivityTerminalPortal(activityTerminalPortals, {
            worktreeId,
            tabId: terminalTab.id
          })
          // Why: parking unmounts only the view; the parked watcher owns exit
          // and side-effect handling until this tab is eligible to remount.
          if (parkedTerminalTabIds.has(terminalTab.id)) {
            return null
          }
          return (
            <TerminalOverlaySlot
              key={terminalTab.id}
              terminalTabId={terminalTab.id}
              terminalGeneration={terminalTab.generation}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
              startupCwd={terminalTab.startupCwd}
              groupId={assignment?.groupId}
              isWorktreeActive={isWorktreeActive}
              isWorktreePresented={isWorktreePresented}
              isVisible={isVisible}
              isPresented={isPresented}
              isActive={isActive}
              activityTerminalPortal={activityTerminalPortal}
              onFocusOwningGroup={focusOwningGroup}
              consumeSuppressedPtyExit={consumeSuppressedPtyExit}
              leaveWorktreeIfEmpty={leaveWorktreeIfEmpty}
              onInitialRenderSettled={() => handleInitialRenderSettled(terminalTab.id)}
            />
          )
        })}
    </>
  )
})

export default TerminalPaneOverlayLayer
