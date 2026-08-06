import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatPendingItem } from './mobile-native-chat-render-data'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import type { AskAnswerSelection, AskPrompt } from './mobile-native-chat-ask'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

export type MobileNativeChatViewProps = {
  sessionKey: string
  messages: NativeChatMessage[]
  folded: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  agent?: string | null
  agentWorking?: boolean
  onStop?: () => void
  streaming: string | null
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
  onSend: (text: string) => Promise<boolean>
  pending: MobileNativeChatPendingItem[]
  imagePreviewsByMessageId?: Record<string, string[]>
  composerText: string
  onComposerTextChange: (text: string) => void
  onAttachImage?: () => void
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  dictationMode?: 'toggle' | 'hold'
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  inputLockReason?: MobileNativeChatInputLockReason | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  ask?: AskPrompt | null
  askKey?: string | null
  onDismissAsk?: () => void
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  onCancelAsk?: () => Promise<boolean>
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => Promise<boolean>
  permission?: MobileChatPermission | null
  onRespondPermission?: (send: string) => Promise<boolean>
  onOpenFile?: (relativePath: string) => void
  keyboardInset?: number
}
