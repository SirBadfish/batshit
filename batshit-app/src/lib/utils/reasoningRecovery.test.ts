import { describe, expect, it } from 'vitest'
import {
  buildInterruptedReasoningRecovery,
  calculateInterruptedReasoningRecoveryActiveByIndex,
  getActiveInterruptedReasoningRecoveryBlock,
  readInterruptedReasoningRecovery,
  type ReasoningRecoveryMessage
} from './reasoningRecovery'

function interruptedMessage(
  agentId: string,
  reasoning = 'I was checking the streaming contract.',
  plan = '- Verify the next boundary'
): ReasoningRecoveryMessage {
  const recovery = buildInterruptedReasoningRecovery({
    agentId,
    reasoningSummary: reasoning,
    planSummary: plan
  })
  if (!recovery) throw new Error('Expected an interruption recovery fixture')

  return {
    role: 'assistant',
    agent_id: agentId,
    status: 'error',
    metadata: {
      interrupted: true,
      interruptedReasoningRecovery: recovery
    }
  }
}

describe('interrupted reasoning recovery', () => {
  it('renders the captured payload once and replays the stored block byte-for-byte', () => {
    const first = buildInterruptedReasoningRecovery({
      agentId: ' agent-a ',
      reasoningSummary: '  First thought.\n\nSecond thought.  ',
      planSummary: '  - [ ] Finish the check  '
    })
    const second = buildInterruptedReasoningRecovery({
      agentId: 'agent-a',
      reasoningSummary: 'First thought.\n\nSecond thought.',
      planSummary: '- [ ] Finish the check'
    })

    expect(first).toEqual(second)
    expect(first?.renderedBlock).toBe(
      [
        'The previous response was interrupted before it finished. Continue from this unfinished work, verify it against the current request, and do not treat it as a final conclusion.',
        '==== RECOVERY REASONING FROM INTERRUPTED RESPONSE ====\nFirst thought.\n\nSecond thought.',
        '==== RECOVERY PLAN FROM INTERRUPTED RESPONSE ====\n- [ ] Finish the check'
      ].join('\n\n')
    )
    expect(JSON.stringify(first)).not.toMatch(/timestamp|createdAt|counter/i)
  })

  it('rejects blank captures and malformed or cross-agent records', () => {
    expect(
      buildInterruptedReasoningRecovery({
        agentId: 'agent-a',
        reasoningSummary: '   ',
        planSummary: ''
      })
    ).toBeNull()

    const message = interruptedMessage('agent-a')
    expect(readInterruptedReasoningRecovery(message)?.agentId).toBe('agent-a')
    expect(
      readInterruptedReasoningRecovery({
        ...message,
        agent_id: 'agent-b'
      })
    ).toBeNull()
    expect(
      readInterruptedReasoningRecovery({
        ...message,
        metadata: {
          ...message.metadata,
          interrupted: false
        }
      })
    ).toBeNull()
  })

  it('stays active through other agents and unsuccessful retries, then expires on exact-agent success', () => {
    const messages: ReasoningRecoveryMessage[] = [
      interruptedMessage('agent-a'),
      { role: 'user', content: 'Please continue.' },
      {
        role: 'assistant',
        agent_id: 'agent-b',
        content: 'A different agent completed a turn.'
      },
      {
        role: 'assistant',
        agent_id: 'agent-a',
        content: 'Another partial attempt.',
        status: 'error',
        metadata: { response_failed: true }
      },
      {
        role: 'assistant',
        agent_id: 'agent-a',
        content: 'Interrupted again.',
        metadata: { interrupted: true }
      }
    ]

    expect(calculateInterruptedReasoningRecoveryActiveByIndex(messages)).toEqual([
      true,
      false,
      false,
      false,
      false
    ])

    const completed = [
      ...messages,
      { role: 'user', content: 'One more time.' },
      {
        role: 'assistant',
        agent_id: 'agent-a',
        content: 'This response completed successfully.'
      }
    ]
    expect(calculateInterruptedReasoningRecoveryActiveByIndex(completed)[0]).toBe(false)
  })

  it('fails closed when a later successful response has no exact agent attribution', () => {
    const messages: ReasoningRecoveryMessage[] = [
      interruptedMessage('agent-a'),
      {
        role: 'assistant',
        content: 'A legacy unattributed response.'
      }
    ]

    expect(calculateInterruptedReasoningRecoveryActiveByIndex(messages)[0]).toBe(true)
  })

  it('returns an active block only to its exact agent', () => {
    const message = interruptedMessage('agent-a')
    const active = calculateInterruptedReasoningRecoveryActiveByIndex([message])
    const stored = readInterruptedReasoningRecovery(message)

    expect(
      getActiveInterruptedReasoningRecoveryBlock({
        message,
        currentAgentId: 'agent-a',
        active: active[0]
      })
    ).toBe(stored?.renderedBlock)
    expect(
      getActiveInterruptedReasoningRecoveryBlock({
        message,
        currentAgentId: 'agent-b',
        active: active[0]
      })
    ).toBe('')
    expect(
      getActiveInterruptedReasoningRecoveryBlock({
        message,
        currentAgentId: 'agent-a',
        active: false
      })
    ).toBe('')
  })
})
