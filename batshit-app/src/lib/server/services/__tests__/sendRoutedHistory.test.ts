import { describe, expect, it } from 'vitest'

import { prepareManagedHistoryMessages } from '../sendRoutedHistory'

describe('prepareManagedHistoryMessages', () => {
  it('removes the current user turn after the API/CLI waiting placeholder', () => {
    const history = prepareManagedHistoryMessages({
      currentUserMessage: 'Read README.md',
      assistantMessageId: 'assistant-current',
      messages: [
        {
          id: 'user-previous',
          role: 'user',
          content: 'Earlier question'
        },
        {
          id: 'assistant-previous',
          role: 'assistant',
          content: 'Earlier answer',
          status: 'complete'
        },
        {
          id: 'user-current',
          role: 'user',
          content: 'Read README.md',
          metadata: {
            client_sent: true
          }
        },
        {
          id: 'assistant-current',
          role: 'assistant',
          content: '',
          status: 'in_progress',
          metadata: {
            client_waiting_placeholder: true
          }
        }
      ]
    })

    expect(history.map((message) => message.id)).toEqual([
      'user-previous',
      'assistant-previous'
    ])
  })

  it('removes the current user turn when no placeholder is present', () => {
    const history = prepareManagedHistoryMessages({
      currentUserMessage: 'Voice transcript',
      messages: [
        {
          id: 'user-previous',
          role: 'user',
          content: 'Earlier question'
        },
        {
          id: 'user-current',
          role: 'user',
          content: 'Voice transcript',
          metadata: {
            source: 'livekit'
          }
        }
      ]
    })

    expect(history.map((message) => message.id)).toEqual(['user-previous'])
  })

  it('preserves all messages for tool approval resumes', () => {
    const messages = [
      {
        id: 'assistant-current',
        role: 'assistant',
        content: '',
        status: 'in_progress',
        metadata: {
          client_waiting_placeholder: true
        }
      }
    ]

    expect(
      prepareManagedHistoryMessages({
        messages,
        currentUserMessage: '',
        assistantMessageId: 'assistant-current',
        preserveAllMessages: true
      })
    ).toEqual(messages)
  })

  it('SA-120 P9: drops a spoken turn that was only a quick action (it never reached the agent), keeps a mixed one, even on an approval resume', () => {
    const swallowed = { id: 'u-qa', role: 'user', content: 'open the voice settings', metadata: { quickAction: { id: 'open_settings', tab: 'voice', confidence: 0.9, onlyThis: true } } }
    const mixed = { id: 'u-mixed', role: 'user', content: 'open the dock and tell me a joke', metadata: { quickAction: { id: 'open_goon_dock', tab: null, confidence: 0.98, onlyThis: false } } }
    const plain = { id: 'u-plain', role: 'user', content: 'hello' }
    const reply = { id: 'a-1', role: 'assistant', content: 'hi', status: 'complete' }
    const history = prepareManagedHistoryMessages({ currentUserMessage: 'next', messages: [plain, reply, swallowed, mixed, { id: 'u-next', role: 'user', content: 'next' }] })
    expect(history.map((m) => m.id)).toEqual(['u-plain', 'a-1', 'u-mixed'])
    const resume = prepareManagedHistoryMessages({ currentUserMessage: 'next', preserveAllMessages: true, messages: [plain, reply, swallowed, mixed] })
    expect(resume.map((m) => m.id)).toEqual(['u-plain', 'a-1', 'u-mixed'])
    // A mark that is not a real action is not a quick action at all: the message stays.
    const odd = { id: 'u-odd', role: 'user', content: 'x', metadata: { quickAction: { id: 'launch_missiles', onlyThis: true } } }
    expect(prepareManagedHistoryMessages({ messages: [odd] }).map((m) => m.id)).toEqual(['u-odd'])
  })

  it('does not remove a real assistant message with content', () => {
    const history = prepareManagedHistoryMessages({
      currentUserMessage: 'Next question',
      assistantMessageId: 'assistant-previous',
      messages: [
        {
          id: 'assistant-previous',
          role: 'assistant',
          content: 'A real answer',
          status: 'in_progress'
        }
      ]
    })

    expect(history.map((message) => message.id)).toEqual(['assistant-previous'])
  })
})
