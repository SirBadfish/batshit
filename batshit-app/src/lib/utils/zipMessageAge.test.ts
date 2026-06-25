import { describe, expect, it } from 'vitest'
import {
  calculateAgentMessagesFromEnd,
  calculateAgentMessagesFromEndByIndex,
  calculateRecoveryHoldByIndex,
  isCountableAgentMessage
} from './zipMessageAge'

describe('zipMessageAge', () => {
  it('counts assistant responses after a message, not user messages', () => {
    const messages = [
      { role: 'assistant', content: 'first tool output', agent_id: 'agent-a' },
      { role: 'user', content: 'follow-up one' },
      { role: 'user', content: 'follow-up two' },
      { role: 'assistant', content: 'second tool output', agent_id: 'agent-a' },
      { role: 'user', content: 'next prompt' }
    ]

    expect(calculateAgentMessagesFromEndByIndex(messages)).toEqual([1, 1, 1, 0, 0])
    expect(calculateAgentMessagesFromEnd(messages, 0)).toBe(1)
    expect(calculateAgentMessagesFromEnd(messages, 3)).toBe(0)
  })

  it('counts only later responses from the same agent when messages have agent ids', () => {
    const messages = [
      { role: 'assistant', content: 'agent a first', agent_id: 'agent-a' },
      { role: 'assistant', content: 'agent b first', agent_id: 'agent-b' },
      { role: 'user', content: 'group reply' },
      { role: 'assistant', content: 'agent a second', agent_id: 'agent-a' }
    ]

    expect(calculateAgentMessagesFromEndByIndex(messages)).toEqual([1, 0, 1, 0])
  })

  it('does not count in-progress or empty assistant placeholders', () => {
    const messages = [
      { role: 'assistant', content: 'finished', agent_id: 'agent-a' },
      { role: 'assistant', content: '', status: 'in_progress', agent_id: 'agent-a' },
      { role: 'assistant', content: '', agent_id: 'agent-a' },
      { role: 'user', content: 'next prompt' }
    ]

    expect(isCountableAgentMessage(messages[0])).toBe(true)
    expect(isCountableAgentMessage(messages[1])).toBe(false)
    expect(isCountableAgentMessage(messages[2])).toBe(false)
    expect(calculateAgentMessagesFromEndByIndex(messages)).toEqual([0, 0, 0, 0])
  })
})

describe('calculateRecoveryHoldByIndex', () => {
  it('holds a trailing failed run with no completion after it', () => {
    const messages = [
      { role: 'assistant', content: 'finished work', agent_id: 'agent-a' },
      { role: 'user', content: 'big task please' },
      {
        role: 'assistant',
        content: 'partial work',
        agent_id: 'agent-a',
        metadata: { response_failed: true }
      },
      { role: 'user', content: 'continue' }
    ]

    expect(calculateRecoveryHoldByIndex(messages)).toEqual([false, false, true, false])
  })

  it('holds the whole trailing failure chain (consecutive failed continuations)', () => {
    const messages = [
      { role: 'user', content: 'big task' },
      {
        role: 'assistant',
        content: 'attempt one',
        agent_id: 'agent-a',
        metadata: { response_failed: true }
      },
      {
        role: 'assistant',
        content: 'attempt two',
        agent_id: 'agent-a',
        metadata: { response_failed: true }
      }
    ]

    expect(calculateRecoveryHoldByIndex(messages)).toEqual([false, true, true])
  })

  it('clears the hold once the same agent completes a turn', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'partial work',
        agent_id: 'agent-a',
        metadata: { response_failed: true }
      },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'all done now', agent_id: 'agent-a' }
    ]

    expect(calculateRecoveryHoldByIndex(messages)).toEqual([false, false, false])
  })

  it('does not let another agent completion clear the hold (group chat)', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'partial work',
        agent_id: 'agent-a',
        metadata: { response_failed: true }
      },
      { role: 'assistant', content: 'different agent reply', agent_id: 'agent-b' }
    ]

    expect(calculateRecoveryHoldByIndex(messages)).toEqual([true, false])
  })

  it('conservatively clears holds on completions without an agent id', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'partial work',
        agent_id: 'agent-a',
        metadata: { response_failed: true }
      },
      { role: 'assistant', content: 'completed reply with no agent id' }
    ]

    expect(calculateRecoveryHoldByIndex(messages)).toEqual([false, false])
  })

  it('holds interrupted runs the same way as failed runs', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'stopped mid-flight',
        agent_id: 'agent-a',
        metadata: { interrupted: true }
      },
      { role: 'user', content: 'keep going' }
    ]

    expect(calculateRecoveryHoldByIndex(messages)).toEqual([true, false])
  })

  it('ignores failed runs that are not assistant messages or have no content', () => {
    const messages = [
      { role: 'user', content: 'hello', metadata: { response_failed: true } },
      {
        role: 'assistant',
        content: '',
        agent_id: 'agent-a',
        metadata: { response_failed: true }
      }
    ]

    expect(calculateRecoveryHoldByIndex(messages)).toEqual([false, false])
  })
})
