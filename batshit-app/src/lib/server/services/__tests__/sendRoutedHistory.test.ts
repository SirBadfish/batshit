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
