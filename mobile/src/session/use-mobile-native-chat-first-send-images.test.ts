import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { userTextMessage } from './mobile-native-chat-message-test-fixtures'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

describe('first native-chat image send', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatDrafts> | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({
    sessionId,
    messages = []
  }: {
    sessionId: string | null
    messages?: NativeChatMessage[]
  }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId,
      messages
    })
    return null
  }

  it('preserves images through session assignment and transcript replacement', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(createElement(Harness, { sessionId: null }))
    })
    const images = ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']
    act(() => state?.setComposerText('look'))

    const origin = state?.captureSendOrigin('look')
    expect(origin).toMatchObject({ pendingKey: null })
    act(() => {
      if (origin) {
        state?.clearDraftForSend(origin, 'look')
        state?.acceptSend(origin, 'look', images)
      }
    })
    expect(state?.pending.map((pending) => pending.images)).toEqual([images])

    await act(async () => renderer?.update(createElement(Harness, { sessionId: 'assigned' })))
    expect(state?.pending.map((pending) => pending.images)).toEqual([images])

    const sourceMessages = [
      userTextMessage('source-1', '[Image: source: /tmp/a.png]'),
      userTextMessage('source-2', '[Image: source: /tmp/b.png]'),
      userTextMessage('source-3', '[Image: source: /tmp/c.png]')
    ]
    await act(async () =>
      renderer?.update(createElement(Harness, { sessionId: 'assigned', messages: sourceMessages }))
    )
    expect(state?.pending.map((pending) => pending.images)).toEqual([images])

    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          sessionId: 'assigned',
          messages: [
            ...sourceMessages,
            userTextMessage('prompt', '[Image #1] [Image #2] [Image #3] look')
          ]
        })
      )
    )
    expect(state?.pending).toEqual([])
    expect(state?.imagePreviewsByMessageId).toEqual({ prompt: images })
  })
})
