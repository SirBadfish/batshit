import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import {
  appendTypesafeCallRecords,
  buildJevJuiceNote,
  createTypesafeCallRecord,
  readTypesafeCallRecords,
  withJevJuiceNotes
} from '../typesafeEvidence'
import type { TypesafeCallOutcome } from '../typesafeClient'

/**
 * SA-120 P0 — the Execution Viewer record (DL-120-07) and the inline note (DL-120-02).
 */

useRedisTestServer()

const at = () => new Date('2026-09-16T12:00:00.000Z')

describe('createTypesafeCallRecord', () => {
  it('records a denied call as unavailable with the denial reason, zero latency, and unknown usage', () => {
    const record = createTypesafeCallRecord({
      featureId: 'connection_test',
      requestedModel: 'jev-1.13.0',
      questionCount: 3,
      outcome: null,
      deniedReason: 'feature_off',
      now: at
    })
    expect(record).toEqual({
      feature: 'connection_test',
      model: 'jev-1.13.0',
      latencyMs: 0,
      usage: null,
      deadlineHit: false,
      status: 'unavailable',
      reason: 'feature_off',
      questionCount: 3,
      at: '2026-09-16T12:00:00.000Z'
    })
  })

  it('records an answered call with the vendor model, latency, usage, and the decision', () => {
    const outcome: TypesafeCallOutcome = {
      status: 'ok',
      response: { model: 'jev-1.13.0', answers: {}, usage: { inputTokens: 5, outputTokens: 1 } },
      latencyMs: 180,
      attempts: 1,
      deadlineHit: false,
      httpStatus: 200
    }
    const record = createTypesafeCallRecord({
      featureId: 'connection_test',
      requestedModel: 'jev-1.13.0',
      questionCount: 1,
      outcome,
      decision: 'good news: yes',
      now: at
    })
    expect(record).toMatchObject({ status: 'ok', latencyMs: 180, usage: { inputTokens: 5, outputTokens: 1 }, decision: 'good news: yes' })
  })

  it('keeps usage unknown on an answered call the vendor did not meter', () => {
    const outcome: TypesafeCallOutcome = {
      status: 'ok',
      response: { model: 'jev-1.13.0', answers: {}, usage: null },
      latencyMs: 90,
      attempts: 1,
      deadlineHit: false,
      httpStatus: 200
    }
    expect(
      createTypesafeCallRecord({ featureId: 'connection_test', requestedModel: 'jev-1.13.0', questionCount: 1, outcome }).usage
    ).toBeNull()
  })

  it('carries the reason, deadline state, and bounded detail of a failed call', () => {
    const outcome: TypesafeCallOutcome = {
      status: 'unavailable',
      reason: 'deadline',
      latencyMs: 402,
      attempts: 1,
      deadlineHit: true
    }
    expect(
      createTypesafeCallRecord({ featureId: 'connection_test', requestedModel: 'jev-1.13.0', questionCount: 2, outcome })
    ).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true, latencyMs: 402, usage: null })
  })
})

describe('buildJevJuiceNote / withJevJuiceNotes', () => {
  it('produces no note for an answered call and a note for a miss', () => {
    const ok = createTypesafeCallRecord({
      featureId: 'connection_test',
      requestedModel: 'jev-1.13.0',
      questionCount: 1,
      outcome: { status: 'ok', response: { model: 'm', answers: {}, usage: null }, latencyMs: 1, attempts: 1, deadlineHit: false, httpStatus: 200 }
    })
    expect(buildJevJuiceNote(ok)).toBeNull()
    const miss = createTypesafeCallRecord({
      featureId: 'connection_test',
      requestedModel: 'jev-1.13.0',
      questionCount: 1,
      outcome: { status: 'unavailable', reason: 'timeout', latencyMs: 5000, attempts: 1, deadlineHit: false },
      now: at
    })
    expect(buildJevJuiceNote(miss)).toEqual({
      feature: 'connection_test',
      status: 'unavailable',
      reason: 'timeout',
      at: '2026-09-16T12:00:00.000Z'
    })
  })

  it('appends notes to message metadata without disturbing sibling fields', () => {
    const note = { feature: 'connection_test', status: 'error' as const, reason: 'unauthorized' as const, at: 'x' }
    const merged = withJevJuiceNotes({ usage: { a: 1 }, jevJuice: { notes: [note] } }, [note])
    expect(merged.usage).toEqual({ a: 1 })
    expect(merged.jevJuice?.notes).toHaveLength(2)
    expect(withJevJuiceNotes({ usage: { a: 1 } }, []).jevJuice).toBeUndefined()
  })
})

describe('appendTypesafeCallRecords', () => {
  const snapshot: ExecutionSnapshot = {
    id: 'msg_1',
    sessionId: 'sess_1',
    userId: 'josh',
    agentId: 'agent_1',
    agentName: 'Faye',
    createdAt: '2026-09-16T12:00:00.000Z',
    structuredInput: {},
    executionMetadata: { promptBudget: { limit: 1 }, typesafeCalls: [] }
  }

  it('appends to the stored snapshot and keeps the other executionMetadata fields', async () => {
    await executionViewerService.clearSnapshots('sess_1')
    await executionViewerService.recordSnapshot(snapshot)
    const record = createTypesafeCallRecord({
      featureId: 'connection_test',
      requestedModel: 'jev-1.13.0',
      questionCount: 1,
      outcome: null,
      deniedReason: 'no_key',
      now: at
    })
    await expect(appendTypesafeCallRecords('sess_1', 'msg_1', [record])).resolves.toBe(true)
    await expect(appendTypesafeCallRecords('sess_1', 'msg_1', [record])).resolves.toBe(true)
    const [stored] = await executionViewerService.getSnapshots('sess_1')
    expect(readTypesafeCallRecords(stored.executionMetadata)).toHaveLength(2)
    expect(stored.executionMetadata?.promptBudget).toEqual({ limit: 1 })
  })

  it('returns false when the snapshot does not exist', async () => {
    await executionViewerService.clearSnapshots('sess_2')
    await expect(
      appendTypesafeCallRecords('sess_2', 'missing', [
        createTypesafeCallRecord({ featureId: 'connection_test', requestedModel: 'm', questionCount: 1, outcome: null, deniedReason: 'no_key' })
      ])
    ).resolves.toBe(false)
  })
})
