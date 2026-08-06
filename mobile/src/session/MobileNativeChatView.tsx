import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { ArrowDown, ChevronsDownUp, ChevronsUpDown, Square } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { colors } from '../theme/mobile-theme'
import { useMobileLocale } from '../localization/mobile-locale-provider'
import { styles } from './mobile-native-chat-view-styles'
import {
  buildMobileNativeChatTransientData,
  mobileNativeChatEmptyState
} from './mobile-native-chat-render-data'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import { useMobileNativeChatScroll } from './use-mobile-native-chat-scroll'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { mobileChatQuestionKey } from './mobile-native-chat-question'
import type { MobileNativeChatViewProps } from './mobile-native-chat-view-contract'

export type { MobileNativeChatInputLockReason } from './mobile-native-chat-view-contract'

const INPUT_LOCK_SETTLE_MS = 600

export function MobileNativeChatView({
  sessionKey,
  messages,
  folded,
  status,
  error,
  agent,
  agentWorking,
  onStop,
  streaming,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  onSend,
  pending,
  imagePreviewsByMessageId,
  composerText,
  onComposerTextChange,
  onAttachImage,
  attachments,
  onRemoveAttachment,
  isAttaching,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  sendErrorMessage,
  onClearSendError,
  filePaths,
  onNeedFiles,
  sessionOptions,
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  onCancelAsk,
  question,
  onAnswerQuestion,
  permission,
  onRespondPermission,
  onOpenFile,
  keyboardInset = 0
}: MobileNativeChatViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const { t } = useMobileLocale()
  const listRef = useRef<FlatList<NativeChatMessage>>(null)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  // Lift the composer clear of the keyboard, plus the bottom safe-area so it
  // never sits under the home indicator / nav bar (mirrors the terminal dock).
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()

  const pendingIds = useMemo(() => new Set(pending.map((p) => p.id)), [pending])
  // `data` is the list source: folded transcript + synthetic streaming bubble +
  // route-owned optimistic queued messages. Memoize on the same deps so the
  // downstream autoscroll effects/`renderItem` keep referential stability.
  const { data } = useMemo(
    () =>
      buildMobileNativeChatTransientData({
        folded,
        streaming,
        pending,
        imagePreviewsByMessageId
      }),
    [folded, streaming, pending, imagePreviewsByMessageId]
  )
  const {
    showJumpToLatest,
    followLatest,
    onScroll: updateScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onLayout,
    onContentSizeChange
  } = useMobileNativeChatScroll({
    sessionKey,
    hasData: data.length > 0,
    listRef
  })

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const accepted = await onSend(text)
      if (!accepted) {
        return false
      }
      // The route-owned banner outlives this send; a success must retire it too,
      // or a stale "Message not sent" sits above the delivered message.
      onClearSendError?.()
      followLatest()
      return true
    },
    [followLatest, onClearSendError, onSend]
  )

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = e.nativeEvent
      updateScroll(e)
      // Near the top — page in older history.
      if (contentOffset.y < 60 && hasMore && !loadingEarlier) {
        onLoadEarlier?.()
      }
    },
    [hasMore, loadingEarlier, onLoadEarlier, updateScroll]
  )

  // Align a single message's top to the top of the viewport.
  const onScrollToMessage = useCallback((index: number) => {
    listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true })
  }, [])

  const renderItem = useCallback(
    ({ item, index }: { item: NativeChatMessage; index: number }) => (
      <MobileNativeChatMessage
        message={item}
        queued={pendingIds.has(item.id)}
        toolsExpanded={toolsExpanded}
        fontScale={fontScale}
        messageIndex={index}
        onScrollToMessage={onScrollToMessage}
        onOpenFile={onOpenFile}
      />
    ),
    [pendingIds, toolsExpanded, fontScale, onScrollToMessage, onOpenFile]
  )

  const emptyState = mobileNativeChatEmptyState(status, agent ?? null, error)
  const showLoading = status === 'loading' && messages.length === 0

  // A dead PTY emits subscribed→end; settle both edges so its false lease cannot flash the composer enabled.
  const rawLockReason = inputLockReason ?? null
  const rawLockHeld = rawLockReason !== null
  const [lockHeld, setLockHeld] = useState(false)
  useEffect(() => {
    if (rawLockHeld === lockHeld) {
      return
    }
    const timer = setTimeout(() => setLockHeld(rawLockHeld), INPUT_LOCK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [lockHeld, rawLockHeld])
  const lockReason = lockHeld ? (rawLockReason ?? 'waiting') : null

  return (
    <View style={[styles.root, { paddingBottom: bottomPad }]}>
      {showLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : (
        <GestureHandlerRootView style={styles.listWrap}>
          <GestureDetector gesture={pinchGesture}>
            <FlatList
              ref={listRef}
              style={styles.list}
              data={data}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              contentContainerStyle={styles.listContent}
              // Let link/file taps land while the composer keyboard is up
              // instead of being swallowed by the dismiss gesture.
              keyboardShouldPersistTaps="handled"
              onScroll={onScroll}
              onScrollBeginDrag={onScrollBeginDrag}
              onScrollEndDrag={onScrollEndDrag}
              onMomentumScrollBegin={onMomentumScrollBegin}
              onMomentumScrollEnd={onMomentumScrollEnd}
              onLayout={onLayout}
              scrollEventThrottle={32}
              onContentSizeChange={onContentSizeChange}
              maintainVisibleContentPosition={
                showJumpToLatest ? { minIndexForVisible: 0 } : undefined
              }
              // scrollToIndex can fail before an off-screen row is measured —
              // fall back to an estimated offset, then retry once it's laid out.
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: true
                })
                setTimeout(() => {
                  listRef.current?.scrollToIndex({
                    index: info.index,
                    viewPosition: 0,
                    animated: true
                  })
                }, 120)
              }}
              ListHeaderComponent={
                hasMore ? (
                  <Pressable
                    style={styles.loadEarlier}
                    onPress={onLoadEarlier}
                    disabled={loadingEarlier}
                  >
                    {loadingEarlier ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Text style={styles.loadEarlierText}>Load earlier messages</Text>
                    )}
                  </Pressable>
                ) : null
              }
              ListEmptyComponent={
                emptyState ? (
                  <View style={styles.center}>
                    <Text style={styles.emptyTitle}>{emptyState.title}</Text>
                    <Text style={styles.emptySubtitle}>{emptyState.subtitle}</Text>
                  </View>
                ) : null
              }
            />
          </GestureDetector>
          {/* Jump-to-latest control. The scroll-to-top affordance now lives
              per-message (the up-arrow in each agent message's controls). */}
          {showJumpToLatest ? (
            <Pressable
              accessibilityLabel={t('chat.scrollToLatest')}
              style={[styles.fab, styles.fabBottom]}
              onPress={followLatest}
            >
              <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </GestureHandlerRootView>
      )}
      {/* Pending agent prompt: a structured AskUserQuestion wins, then a
          heuristic permission, then a heuristic question. The controller owns
          dismissal so it survives chat/terminal view toggles. */}
      <View style={styles.composerWrap}>
        {ask ? (
          <MobileNativeChatAsk
            key={askKey ?? 'ask'}
            prompt={ask}
            onAnswer={async (selections) => {
              const accepted = (await onAnswerAsk?.(ask, selections)) ?? false
              if (accepted) {
                onDismissAsk?.()
              }
              return accepted
            }}
            onCancel={async () => {
              const accepted = (await onCancelAsk?.()) ?? false
              if (accepted) {
                onDismissAsk?.()
              }
              return accepted
            }}
          />
        ) : permission ? (
          <MobileNativeChatPermission
            key={JSON.stringify(permission)}
            permission={permission}
            onRespond={async (send) => (await onRespondPermission?.(send)) ?? false}
          />
        ) : question ? (
          <MobileNativeChatQuestion
            key={mobileChatQuestionKey(question)}
            question={question}
            onAnswer={async (text) => (await onAnswerQuestion?.(text)) ?? false}
          />
        ) : null}
        {/* Chrome row above the composer: the working indicator and the global
            tool-calls expand/collapse toggle on the left, Stop in the far corner. */}
        <View style={styles.chromeRow}>
          <View style={styles.chromeLeft}>
            {agentWorking ? <MobileAgentWorkingIndicator /> : null}
            <Pressable
              style={({ pressed }) => [styles.chromeToggle, pressed && styles.pressed]}
              onPress={() => setToolsExpanded((v) => !v)}
              hitSlop={8}
            >
              {toolsExpanded ? (
                <ChevronsDownUp size={14} color={colors.textMuted} strokeWidth={2} />
              ) : (
                <ChevronsUpDown size={14} color={colors.textMuted} strokeWidth={2} />
              )}
              <Text style={styles.chromeToggleLabel}>
                {t(toolsExpanded ? 'chat.collapseTools' : 'chat.tools')}
              </Text>
            </Pressable>
          </View>
          {agentWorking ? (
            <Pressable
              style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
              onPress={onStop}
              hitSlop={8}
              accessibilityLabel={t('chat.stopAgent')}
            >
              <Square
                size={13}
                color={colors.statusRed}
                strokeWidth={2.4}
                fill={colors.statusRed}
              />
              <Text style={styles.stopLabel}>{t('chat.stop')}</Text>
            </Pressable>
          ) : null}
        </View>
        {sendErrorMessage ? (
          // This banner is the only channel for a send failure — announce it.
          <View
            style={styles.sendError}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            <Text style={styles.sendErrorText}>{sendErrorMessage}</Text>
          </View>
        ) : null}
        <MobileNativeChatComposer
          value={composerText}
          onChangeText={onComposerTextChange}
          onSend={handleSend}
          agent={agent}
          sessionOptions={sessionOptions}
          onAttachImage={onAttachImage}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          isAttaching={isAttaching}
          onMicPress={onMicPress}
          micActive={micActive}
          dictationMode={dictationMode}
          onMicPressIn={onMicPressIn}
          onMicPressOut={onMicPressOut}
          disabled={lockReason !== null}
          placeholder={
            lockReason === 'disconnected'
              ? t('chat.reconnecting')
              : lockReason === 'waiting'
                ? t('chat.waitingForTerminal')
                : t('chat.composerPlaceholder')
          }
          filePaths={filePaths}
          onNeedFiles={onNeedFiles}
        />
      </View>
    </View>
  )
}
