import { describe, expect, it } from 'vitest'
import { resolveSseEventId, SseEventDeduper } from './sseEventDedupe'

describe('sseEventDedupe', () => {
  it('resolves stream event ids from current and legacy shapes', () => {
    expect(resolveSseEventId({ sseEventId: 'message-1:1' })).toBe('message-1:1')
    expect(resolveSseEventId({ sse_event_id: 'message-1:2' })).toBe('message-1:2')
    expect(resolveSseEventId({ metadata: { sseEventId: 'message-1:3' } })).toBe('message-1:3')
    expect(resolveSseEventId({ metadata: { sse_event_id: 'message-1:4' } })).toBe('message-1:4')
  })

  it('skips duplicate event ids only within the owning session', () => {
    const deduper = new SseEventDeduper()
    const event = { sseEventId: 'message-1:1', type: 'chunk' }

    expect(deduper.shouldProcess('session-a', event)).toBe(true)
    expect(deduper.shouldProcess('session-a', event)).toBe(false)
    expect(deduper.shouldProcess('session-b', event)).toBe(true)
  })

  it('continues processing untracked events', () => {
    const deduper = new SseEventDeduper()
    expect(deduper.shouldProcess('session-a', { type: 'connected' })).toBe(true)
    expect(deduper.shouldProcess('session-a', { type: 'connected' })).toBe(true)
  })
})
