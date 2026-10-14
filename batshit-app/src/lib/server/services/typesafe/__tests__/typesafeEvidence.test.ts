import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import {
  __typesafeAppendChainCountForTests,
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

  it('SA-120 P10a: a row and its note name the judge; a row with no judge (no_provider) has no provider and no model', () => {
    const provider = { id: 'ollama-mac', kind: 'ollama' as const, label: 'Ollama on this Mac' }
    const miss = createTypesafeCallRecord({
      featureId: 'smart_zip',
      requestedModel: 'clef-flash',
      provider,
      questionCount: 4,
      outcome: { status: 'unavailable', reason: 'provider_limit', latencyMs: 0, attempts: 0, deadlineHit: false, detail: 'a Choice with 30 options; this judge takes at most 26', requestChars: 900 },
      now: at
    })
    expect(miss).toMatchObject({ model: 'clef-flash', provider, reason: 'provider_limit', detail: 'a Choice with 30 options; this judge takes at most 26' })
    expect(buildJevJuiceNote(miss)).toEqual({ feature: 'smart_zip', status: 'unavailable', reason: 'provider_limit', at: '2026-09-16T12:00:00.000Z', provider })
    // The row keeps its own copy: changing the caller's object later changes nothing stored.
    provider.label = 'renamed'
    expect(miss.provider?.label).toBe('Ollama on this Mac')

    const ok = createTypesafeCallRecord({
      featureId: 'smart_zip',
      requestedModel: 'clef-flash',
      provider: { id: 'ollama-mac', kind: 'ollama', label: 'Ollama on this Mac' },
      questionCount: 1,
      outcome: { status: 'ok', response: { model: 'clef-flash', answers: {}, usage: { inputTokens: 154, outputTokens: 0 } }, latencyMs: 31, attempts: 1, deadlineHit: false, httpStatus: 200, requestChars: 279 }
    })
    expect(ok).toMatchObject({ model: 'clef-flash', provider: { kind: 'ollama' }, usage: { inputTokens: 154, outputTokens: 0 } })

    const none = createTypesafeCallRecord({ featureId: 'smart_zip', requestedModel: null, questionCount: 1, outcome: null, deniedReason: 'no_provider' })
    expect(none).toMatchObject({ model: null, reason: 'no_provider' })
    expect('provider' in none).toBe(false)
    // Round 1, S5: the row keeps the judge id that was chosen but not found.
    const chosen = createTypesafeCallRecord({
      featureId: 'smart_zip',
      requestedModel: null,
      chosenProviderId: 'deleted-judge',
      questionCount: 1,
      outcome: null,
      deniedReason: 'no_provider'
    })
    expect(chosen).toMatchObject({ reason: 'no_provider', chosenProviderId: 'deleted-judge' })
    expect('provider' in chosen).toBe(false)
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

  // BL-529: each append reads the stored rows and writes them back with its own, so two calls that
  // finish together (two `sys.judge.ask` calls in one step, an ask beside a memory rerank) each
  // wrote the old rows plus their own, and one row was lost.
  const row = (decision: string) =>
    createTypesafeCallRecord({
      featureId: 'connection_test',
      requestedModel: 'jev-1.13.0',
      questionCount: 1,
      outcome: null,
      deniedReason: 'no_key',
      decision,
      now: at
    })

  it('keeps every row when appends to one snapshot run at the same time (BL-529)', async () => {
    await executionViewerService.clearSnapshots('sess_1')
    await executionViewerService.recordSnapshot(snapshot)
    const results = await Promise.all([
      appendTypesafeCallRecords('sess_1', 'msg_1', [row('first')]),
      appendTypesafeCallRecords('sess_1', 'msg_1', [row('second')]),
      appendTypesafeCallRecords('sess_1', 'msg_1', [row('third'), row('fourth')])
    ])
    expect(results).toEqual([true, true, true])
    const [stored] = await executionViewerService.getSnapshots('sess_1')
    // One after another, in the order they were asked for.
    expect(readTypesafeCallRecords(stored.executionMetadata).map((record) => record.decision)).toEqual([
      'first',
      'second',
      'third',
      'fourth'
    ])
    expect(stored.executionMetadata?.promptBudget).toEqual({ limit: 1 })
    expect(__typesafeAppendChainCountForTests()).toBe(0)
  })

  it('a failed append does not stop the next one, and its caller still sees the failure (BL-529)', async () => {
    await executionViewerService.clearSnapshots('sess_1')
    await executionViewerService.recordSnapshot(snapshot)
    const update = vi
      .spyOn(executionViewerService, 'updateSnapshot')
      .mockRejectedValueOnce(new Error('Redis write failed'))
    try {
      const [failed, next] = await Promise.allSettled([
        appendTypesafeCallRecords('sess_1', 'msg_1', [row('lost to the failure')]),
        appendTypesafeCallRecords('sess_1', 'msg_1', [row('after the failure')])
      ])
      expect(failed).toMatchObject({ status: 'rejected', reason: new Error('Redis write failed') })
      expect(next).toEqual({ status: 'fulfilled', value: true })
    } finally {
      update.mockRestore()
    }
    const [stored] = await executionViewerService.getSnapshots('sess_1')
    expect(readTypesafeCallRecords(stored.executionMetadata).map((record) => record.decision)).toEqual([
      'after the failure'
    ])
    expect(__typesafeAppendChainCountForTests()).toBe(0)
  })

  it('appends to different snapshots do not wait for each other', async () => {
    await executionViewerService.clearSnapshots('sess_1')
    await executionViewerService.recordSnapshot(snapshot)
    await executionViewerService.recordSnapshot({ ...snapshot, id: 'msg_2' })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = executionViewerService.updateSnapshot.bind(executionViewerService)
    const update = vi.spyOn(executionViewerService, 'updateSnapshot').mockImplementation(async (sessionId, snapshotId, patch) => {
      if (snapshotId === 'msg_1') await held
      return original(sessionId, snapshotId, patch)
    })
    try {
      const first = appendTypesafeCallRecords('sess_1', 'msg_1', [row('held')])
      await expect(appendTypesafeCallRecords('sess_1', 'msg_2', [row('free')])).resolves.toBe(true)
      release()
      await expect(first).resolves.toBe(true)
    } finally {
      update.mockRestore()
    }
  })
})
