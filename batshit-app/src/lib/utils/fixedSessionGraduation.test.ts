import { describe, expect, it } from 'vitest'
import type { Message } from '$lib/stores/messages.svelte'
import {
  applyFixedSessionGraduationToMessages,
  createFixedSessionGraduationSummaryMessage,
  getFixedSessionGraduationState,
  getFixedSessionNapRecords,
  getGraduatedMessageIds,
  type FixedSessionGraduationEvent
} from './fixedSessionGraduation'

function message(id: string, content = `content ${id}`): Message {
  return {
    id,
    session_id: 'sess',
    user_id: 'user',
    role: 'user',
    content,
    timestamp: '2026-06-10T08:00:00.000Z',
    created_at: '2026-06-10T08:00:00.000Z'
  } as Message
}

function event(
  id: string,
  sourceMessageIds: string[],
  overrides: Partial<FixedSessionGraduationEvent> = {}
): FixedSessionGraduationEvent {
  return {
    id,
    createdAt: '2026-06-10T12:00:00.000Z',
    source: 'nap',
    episodeId: 'ep1',
    segmentId: `memseg_${id}`,
    sourceMessageIds,
    compactedMessageCount: sourceMessageIds.length,
    summary: `Summary for ${id}`,
    summaryTokenEstimate: 10,
    ...overrides
  }
}

function fixedSession(events: FixedSessionGraduationEvent[], extraMetadata: Record<string, any> = {}) {
  return {
    id: 'sess',
    metadata: {
      fixedSession: {
        version: 1,
        enabled: true,
        created_at: '2026-06-01T00:00:00.000Z',
        graduation: { version: 1, events }
      },
      ...extraMetadata
    }
  }
}

describe('fixedSessionGraduation (SA-104 P6)', () => {
  it('normalizes state and collects graduated ids', () => {
    const state = getFixedSessionGraduationState(fixedSession([event('g1', ['a', 'b'])]).metadata)
    expect(state.events).toHaveLength(1)
    expect(getGraduatedMessageIds(state.events)).toEqual(['a', 'b'])
    expect(getFixedSessionGraduationState(null).events).toEqual([])
    expect(getFixedSessionGraduationState({ fixedSession: { graduation: 'junk' } }).events).toEqual([])
  })

  it('splices one gist at the first source position and drops the sources', () => {
    const messages = [message('a'), message('b'), message('c'), message('d')]
    const session = fixedSession([event('g1', ['b', 'c'])])
    const result = applyFixedSessionGraduationToMessages(messages, session)
    expect(result.map((entry) => entry.id)).toEqual([
      'a',
      'batshit_fixed_graduation_g1',
      'd'
    ])
    const splice = result[1]
    expect(splice.role).toBe('system')
    expect(splice.content).toContain('Summary for g1')
    expect(splice.content).toContain('memseg_g1')
    expect(splice.metadata?.contextCompactSummary).toBe(true)
    expect(splice.metadata?.fixedSessionGraduation).toBe(true)
    expect(splice.metadata?.fixedSessionGraduationEventId).toBe('g1')
  })

  it('is idempotent: pre-spliced input re-applies as a no-op (the server re-application path)', () => {
    const messages = [message('a'), message('b'), message('c'), message('d')]
    const session = fixedSession([event('g1', ['b', 'c'])])
    const once = applyFixedSessionGraduationToMessages(messages, session)
    const twice = applyFixedSessionGraduationToMessages(once, session)
    expect(twice).toEqual(once)
  })

  it('orphaned events (sources absent) still contribute their gist at the front', () => {
    const messages = [message('x')]
    const session = fixedSession([event('g1', ['gone1', 'gone2'])])
    const result = applyFixedSessionGraduationToMessages(messages, session)
    expect(result.map((entry) => entry.id)).toEqual(['batshit_fixed_graduation_g1', 'x'])
  })

  it('multiple events splice in createdAt order without cross-interference', () => {
    const messages = [message('a'), message('b'), message('c'), message('d'), message('e')]
    const session = fixedSession([
      event('g2', ['c', 'd'], { createdAt: '2026-06-11T12:00:00.000Z' }),
      event('g1', ['a', 'b'], { createdAt: '2026-06-10T12:00:00.000Z' })
    ])
    const result = applyFixedSessionGraduationToMessages(messages, session)
    expect(result.map((entry) => entry.id)).toEqual([
      'batshit_fixed_graduation_g1',
      'batshit_fixed_graduation_g2',
      'e'
    ])
  })

  it('returns the input unchanged for regular sessions and event-free Infinite Sessions (DL-104-12)', () => {
    const messages = [message('a'), message('b')]
    const regular = { id: 'sess', metadata: {} }
    expect(applyFixedSessionGraduationToMessages(messages, regular)).toBe(messages)
    const fixedNoEvents = fixedSession([])
    expect(applyFixedSessionGraduationToMessages(messages, fixedNoEvents)).toBe(messages)
    // A regular session carrying stray graduation-shaped metadata is still untouched
    // (isFixedSession is THE gate).
    const strayMetadata = {
      id: 'sess',
      metadata: { fixedSession: { graduation: { version: 1, events: [event('g1', ['a'])] } } }
    }
    expect(applyFixedSessionGraduationToMessages(messages, strayMetadata)).toBe(messages)
  })

  it('splice content names the source and preserves counts', () => {
    const splice = createFixedSessionGraduationSummaryMessage(
      event('g9', ['a', 'b', 'c'], { source: 'idle' })
    )
    expect(splice.content).toContain('3 older messages')
    expect(splice.content).toContain('after an idle gap')
    expect(splice.metadata?.compactedMessageCount).toBe(3)
  })

  it('normalizes nap records defensively', () => {
    expect(getFixedSessionNapRecords(null)).toEqual([])
    expect(
      getFixedSessionNapRecords({
        fixedSession: { naps: [{ id: 'n1', at: '2026-06-10T12:00:00.000Z', status: 'completed' }, 'junk'] }
      })
    ).toHaveLength(1)
  })
})
