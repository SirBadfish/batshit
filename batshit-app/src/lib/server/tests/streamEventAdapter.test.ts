import { describe, it, expect } from 'vitest'
import { StreamEventAdapter } from '$lib/server/services/streamEventAdapter'

describe('StreamEventAdapter messageId behavior', () => {
  it('reuses set messageId for structured object events', async () => {
    const events: any[] = []
    const adapter = new StreamEventAdapter({
      sessionId: 'sess_123',
      forward: (event) => {
        events.push(event)
      }
    })

    adapter.setMessageId('msg_reserved')

    await adapter.emitObjectPartial({
      object: { shouldSpeak: true },
      index: 0,
      metadata: { purpose: 'group_decision' }
    })

    await adapter.emitObjectFinal({
      object: { shouldSpeak: true },
      metadata: { purpose: 'group_decision' }
    })

    expect(events).toHaveLength(2)
    expect(events[0].messageId).toBe('msg_reserved')
    expect(events[1].messageId).toBe('msg_reserved')
    expect(events[0].sessionId).toBe('sess_123')
  })

  it('honors explicit messageId in emitStart', async () => {
    const events: any[] = []
    const adapter = new StreamEventAdapter({
      sessionId: 'sess_456',
      forward: (event) => {
        events.push(event)
      }
    })

    await adapter.emitStart({ messageId: 'msg_start' })
    await adapter.emitChunk({ content: 'Hello' })

    expect(events).toHaveLength(2)
    expect(events[0].messageId).toBe('msg_start')
    expect(events[1].messageId).toBe('msg_start')
  })
})
