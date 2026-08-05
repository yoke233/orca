import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countUserTextOccurrences,
  reconcilePendingMessages
} from './mobile-native-chat-draft-reconcile'
import {
  NO_PENDING_MESSAGES,
  type MobileNativeChatPendingMessage,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-draft-contract'
import { useMobileNativeChatDraftMutations } from './mobile-native-chat-draft-state'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { useMobileNativeChatUnconfirmedSend } from './use-mobile-native-chat-unconfirmed-send'
import { useMobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

export type {
  MobileNativeChatPendingMessage,
  MobileNativeChatSendOrigin
} from './mobile-native-chat-draft-contract'

export function useMobileNativeChatDrafts(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  /** Host-provided launch context still parked as an unsent TUI-input draft. */
  launchDraft?: string | null
  launchDraftCreatedAt?: number | null
  /** Whether the tab is currently resolved to the chat view. Off-chat the
   *  launch-draft effects hold their state instead of acting on it. */
  chatActive?: boolean
  /** `messages` is not yet this session's real history (read in flight, or the
   *  transcript still belongs to the previously active tab), so it cannot be
   *  trusted to decline or retire the seed. */
  transcriptLoading?: boolean
}): {
  composerText: string
  setComposerText: Dispatch<SetStateAction<string>>
  pending: MobileNativeChatPendingMessage[]
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  /** Launch-context text still believed to be parked on the agent's TUI input
   *  line, or null once it has been declined or retired. Send paths size their
   *  pre-clear from it, since one Ctrl+U clears only one logical line. */
  readSeededLaunchDraft: () => string | null
  readSeededLaunchDraftSeed: () => MobileNativeChatLaunchDraftSeed | null
  /** Clear the composer at send time, before the RPC settles. */
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  /** Put the text back after a definite rejection, unless newer edits exist. */
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
} {
  const {
    hostId,
    worktreeId,
    tabId,
    sessionId,
    messages,
    launchDraft,
    launchDraftCreatedAt,
    chatActive = true,
    transcriptLoading
  } = args
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const pendingKey = draftKey && sessionId ? `${draftKey}\0${sessionId}` : null
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftsRef = useRef<Record<string, string>>({})
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const pendingCounterRef = useRef(0)
  const draftEditRevisionsRef = useRef<Record<string, number>>({})
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const updateDrafts = useCallback(
    (update: (previous: Record<string, string>) => Record<string, string>) => {
      const previous = draftsRef.current
      const next = update(previous)
      if (next === previous) {
        return
      }
      draftsRef.current = next
      setDrafts(next)
    },
    []
  )

  const { readSeededLaunchDraft, readSeededLaunchDraftSeed } = useMobileNativeChatLaunchDraftSeed({
    draftKey,
    messages,
    launchDraft,
    launchDraftCreatedAt,
    chatActive,
    transcriptLoading,
    updateDrafts
  })

  const setComposerText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      if (!draftKey) {
        return
      }
      updateDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        if (next === current) {
          return previous
        }
        draftEditRevisionsRef.current[draftKey] = (draftEditRevisionsRef.current[draftKey] ?? 0) + 1
        return { ...previous, [draftKey]: next }
      })
    },
    [draftKey, updateDrafts]
  )

  const captureSendOrigin = useCallback(
    (text: string) => {
      if (!draftKey) {
        return null
      }
      const normalizedText = text.trim()
      const currentMessages = messagesRef.current
      return {
        draftKey,
        pendingKey,
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(currentMessages, normalizedText),
        baselineTailMessageId: currentMessages[currentMessages.length - 1]?.id ?? null,
        draftEditRevision: draftEditRevisionsRef.current[draftKey] ?? 0
      }
    },
    [draftKey, pendingKey]
  )

  const { clearDraftForSend, restoreRejectedDraft } = useMobileNativeChatDraftMutations(
    updateDrafts,
    draftEditRevisionsRef
  )

  const acceptSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => {
      // Why: the first prompt can be sent before the provider reports a session
      // id; wait for an id before keying an optimistic echo.
      if (!origin.pendingKey) {
        return
      }
      const pendingKey = origin.pendingKey
      pendingCounterRef.current += 1
      setPendingBySession((previous) => {
        const current = previous[pendingKey] ?? NO_PENDING_MESSAGES
        const earlierOutstanding = current.filter(
          (pending) =>
            pending.text.trim() === origin.normalizedText &&
            pending.expectedOccurrence > origin.baselineOccurrences
        ).length
        // An empty-text send reconciles by image-echo ordinal: every outstanding
        // send's ridden-along images echo as `[Image: source: …]` turns after
        // this send's baseline tail, ahead of this send's own echo.
        const expectedImageEchoOrdinal =
          current.reduce(
            (sum, pending) =>
              sum + (pending.images?.length ?? (pending.text.trim() === '' ? 1 : 0)),
            0
          ) + Math.max(1, images?.length ?? 0)
        const pending: MobileNativeChatPendingMessage = {
          id: `pending-${pendingCounterRef.current}`,
          text,
          expectedOccurrence:
            origin.normalizedText === ''
              ? expectedImageEchoOrdinal
              : origin.baselineOccurrences + earlierOutstanding + 1,
          baselineTailMessageId: origin.baselineTailMessageId,
          ...(images && images.length > 0 ? { images } : {})
        }
        return { ...previous, [pendingKey]: [...current, pending] }
      })
    },
    []
  )

  const holdUnconfirmedSend = useMobileNativeChatUnconfirmedSend({
    draftKey,
    pendingKey,
    messages,
    updateDrafts,
    draftEditRevisionsRef
  })

  const pending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  useEffect(() => {
    if (!pendingKey || pending.length === 0) {
      return
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      const next = reconcilePendingMessages(messages, current)
      if (next === current) {
        return previous
      }
      if (next.length > 0) {
        return { ...previous, [pendingKey]: next }
      }
      const remaining = { ...previous }
      delete remaining[pendingKey]
      return remaining
    })
  }, [messages, pending, pendingKey])

  return {
    composerText: draftKey ? (drafts[draftKey] ?? '') : '',
    setComposerText,
    pending,
    captureSendOrigin,
    readSeededLaunchDraft,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  }
}
