import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countUserTextOccurrences,
  findLandedImagePreviewEchoes,
  mergeLandedImagePreviewEchoes,
  migrateImagePreviewMessageIds,
  reconcilePendingMessages
} from './mobile-native-chat-draft-reconcile'
import {
  NO_PENDING_MESSAGES,
  type MobileNativeChatPendingMessage,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-draft-contract'
import { useMobileNativeChatDraftMutations } from './mobile-native-chat-draft-state'
import {
  appendMobileNativeChatPending,
  combineMobileNativeChatPending,
  mergeWaitingSessionPending,
  removeWaitingSessionPending
} from './mobile-native-chat-pending-echo'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { useMobileNativeChatUnconfirmedSend } from './use-mobile-native-chat-unconfirmed-send'
import { useMobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

export type {
  MobileNativeChatPendingMessage,
  MobileNativeChatSendOrigin
} from './mobile-native-chat-draft-contract'

const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

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
  /** Phone-local previews rebound to the transcript message that replaced the
   *  optimistic echo, keyed by authoritative message id. */
  imagePreviewsByMessageId: Record<string, string[]>
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
  const [pendingWaitingForSession, setPendingWaitingForSession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
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
      if (!origin.pendingKey && !images?.length) {
        return
      }
      pendingCounterRef.current += 1
      const id = `pending-${pendingCounterRef.current}`
      const key = origin.pendingKey
      if (key) {
        setPendingBySession((previous) =>
          appendMobileNativeChatPending(previous, key, id, origin, text, images)
        )
      } else {
        setPendingWaitingForSession((previous) =>
          appendMobileNativeChatPending(previous, origin.draftKey, id, origin, text, images)
        )
      }
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

  const waitingForSession = draftKey
    ? (pendingWaitingForSession[draftKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  useEffect(() => {
    if (!draftKey || !pendingKey || waitingForSession.length === 0) {
      return
    }
    const movedIds = new Set(waitingForSession.map((item) => item.id))
    setPendingBySession((previous) =>
      mergeWaitingSessionPending(previous, pendingKey, waitingForSession)
    )
    setPendingWaitingForSession((previous) =>
      removeWaitingSessionPending(previous, draftKey, movedIds)
    )
  }, [draftKey, pendingKey, waitingForSession])

  const sessionPending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  const pending = combineMobileNativeChatPending(sessionPending, waitingForSession)
  useEffect(() => {
    if (!pendingKey) {
      return
    }
    setImagePreviewsBySession((previous) =>
      migrateImagePreviewMessageIds(previous, pendingKey, messages)
    )
    if (pending.length === 0) {
      return
    }
    const landedImagePreviews = findLandedImagePreviewEchoes(messages, pending)
    const landedImagePendingIds = new Set(landedImagePreviews.map((preview) => preview.pendingId))
    if (landedImagePreviews.length > 0) {
      setImagePreviewsBySession((previous) =>
        mergeLandedImagePreviewEchoes(previous, pendingKey, landedImagePreviews)
      )
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      const reconciled = new Set(reconcilePendingMessages(messages, current))
      const next = current.filter((item) => {
        if (landedImagePendingIds.has(item.id)) {
          return false
        }
        if (item.images?.length && item.text.trim() !== '') {
          return true
        }
        return reconciled.has(item)
      })
      if (next.length === current.length) {
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
    imagePreviewsByMessageId: pendingKey
      ? (imagePreviewsBySession[pendingKey] ?? NO_IMAGE_PREVIEWS)
      : NO_IMAGE_PREVIEWS,
    captureSendOrigin,
    readSeededLaunchDraft,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  }
}
