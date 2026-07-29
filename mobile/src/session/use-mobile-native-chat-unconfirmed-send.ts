import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  UNCONFIRMED_SEND_DEADLINE_MS,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-draft-contract'
import {
  findLandedUnconfirmedSends,
  type UnconfirmedSend
} from './mobile-native-chat-draft-reconcile'
import { isDraftRev } from './mobile-native-chat-draft-state'

type UpdateDrafts = (update: (previous: Record<string, string>) => Record<string, string>) => void

export function useMobileNativeChatUnconfirmedSend(args: {
  draftKey: string | null
  pendingKey: string | null
  messages: readonly NativeChatMessage[]
  updateDrafts: UpdateDrafts
  draftEditRevisionsRef: RefObject<Record<string, number>>
}): (origin: MobileNativeChatSendOrigin, text: string, onUnconfirmed: () => void) => void {
  const { draftKey, pendingKey, messages, updateDrafts, draftEditRevisionsRef } = args
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeDraftKeyRef = useRef(draftKey)
  activeDraftKeyRef.current = draftKey
  const activePendingKeyRef = useRef(pendingKey)
  activePendingKeyRef.current = pendingKey
  const mountedRef = useRef(false)
  const unconfirmedRef = useRef<UnconfirmedSend[]>([])

  const surfaceUnconfirmedSend = useCallback(
    (entry: UnconfirmedSend) => {
      if (entry.text.length > 0) {
        updateDrafts((previous) =>
          isDraftRev(draftEditRevisionsRef.current, entry) &&
          (previous[entry.draftKey] ?? '') === ''
            ? { ...previous, [entry.draftKey]: entry.text }
            : previous
        )
      }
      entry.onUnconfirmed()
    },
    [draftEditRevisionsRef, updateDrafts]
  )

  const holdUnconfirmedSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, onUnconfirmed: () => void) => {
      if (!mountedRef.current) {
        return
      }
      const isActiveTranscript =
        activeDraftKeyRef.current === origin.draftKey &&
        (origin.pendingKey === null || activePendingKeyRef.current === origin.pendingKey)
      const entry: UnconfirmedSend = {
        draftKey: origin.draftKey,
        pendingKey: origin.pendingKey,
        text,
        normalizedText: origin.normalizedText,
        baselineTailMessageId: origin.baselineTailMessageId,
        draftEditRevision: origin.draftEditRevision,
        deadline: null,
        expired: false,
        surfaced: false,
        onUnconfirmed
      }
      updateDrafts((previous) =>
        isDraftRev(draftEditRevisionsRef.current, origin) &&
        (previous[origin.draftKey] ?? '').trim() === text.trim()
          ? { ...previous, [origin.draftKey]: '' }
          : previous
      )
      if (
        isActiveTranscript &&
        findLandedUnconfirmedSends(messagesRef.current, [entry]).length > 0
      ) {
        return
      }
      entry.deadline = setTimeout(() => {
        entry.deadline = null
        const isOriginActive =
          activeDraftKeyRef.current === origin.draftKey &&
          (origin.pendingKey === null || activePendingKeyRef.current === origin.pendingKey)
        if (!isOriginActive) {
          entry.expired = true
          return
        }
        entry.expired = true
        entry.surfaced = true
        surfaceUnconfirmedSend(entry)
      }, UNCONFIRMED_SEND_DEADLINE_MS)
      unconfirmedRef.current = [...unconfirmedRef.current, entry]
    },
    [draftEditRevisionsRef, surfaceUnconfirmedSend, updateDrafts]
  )

  useEffect(() => {
    const stale = unconfirmedRef.current.filter(
      (entry) =>
        entry.draftKey === draftKey && entry.pendingKey !== null && entry.pendingKey !== pendingKey
    )
    if (stale.length === 0) {
      return
    }
    const staleSet = new Set(stale)
    for (const entry of stale) {
      if (entry.deadline !== null) {
        clearTimeout(entry.deadline)
      }
    }
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !staleSet.has(entry))
  }, [draftKey, pendingKey])

  useEffect(() => {
    if (!draftKey || unconfirmedRef.current.length === 0) {
      return
    }
    const relevant = unconfirmedRef.current.filter(
      (entry) =>
        entry.draftKey === draftKey &&
        (entry.pendingKey === null || entry.pendingKey === pendingKey)
    )
    const landed = findLandedUnconfirmedSends(messages, relevant)
    const landedSet = new Set(landed)
    const expired = relevant.filter(
      (entry) => entry.expired && !entry.surfaced && !landedSet.has(entry)
    )
    if (landed.length === 0 && expired.length === 0) {
      return
    }
    const completed = new Set([...landed, ...expired])
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !completed.has(entry))
    for (const entry of landed) {
      if (entry.deadline !== null) {
        clearTimeout(entry.deadline)
      }
      updateDrafts((previous) =>
        isDraftRev(draftEditRevisionsRef.current, entry) &&
        (previous[entry.draftKey] ?? '').trim() === entry.text.trim()
          ? { ...previous, [entry.draftKey]: '' }
          : previous
      )
    }
    for (const entry of expired) {
      entry.surfaced = true
      surfaceUnconfirmedSend(entry)
    }
  }, [draftEditRevisionsRef, draftKey, messages, pendingKey, surfaceUnconfirmedSend, updateDrafts])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of unconfirmedRef.current) {
        if (entry.deadline !== null) {
          clearTimeout(entry.deadline)
        }
      }
      unconfirmedRef.current = []
    }
  }, [])

  return holdUnconfirmedSend
}
