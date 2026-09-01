import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import type { CacheForensicsRecord } from '$lib/types/cacheForensics'
import { captureCacheForensicsRecord } from '$lib/server/services/cacheForensics/record'
import { buildManagedSubagentCacheForensicsRecord } from '$lib/server/services/cacheForensics/subagentAdapter'
import {
  appendSubagentCacheForensicsRecord,
  attachCacheForensicsToSnapshot,
  compareRunRecords,
  isCacheForensicsEnabled,
} from '$lib/server/services/cacheForensics/evIntegration'
import { executionViewerService } from '$lib/server/services/executionViewerService'

vi.mock('$lib/server/services/executionViewerService', () => ({
  executionViewerService: {
    getSnapshots: vi.fn(),
    updateSnapshot: vi.fn(),
  },
}))

vi.mock('$lib/server/services/cacheForensics/otlpExport', () => ({
  resolveCacheForensicsExportConfig: vi.fn(() => ({ state: 'disabled' as const })),
  exportCacheForensicsRecords: vi.fn(),
}))

import {
  exportCacheForensicsRecords,
  resolveCacheForensicsExportConfig,
} from '$lib/server/services/cacheForensics/otlpExport'

const exportRecords = vi.mocked(exportCacheForensicsRecords)
const resolveExportConfig = vi.mocked(resolveCacheForensicsExportConfig)

const getSnapshots = vi.mocked(executionViewerService.getSnapshots)
const updateSnapshot = vi.mocked(executionViewerService.updateSnapshot)

function capture(runId: string, currentTurn: string, capturedAt: string) {
  return captureCacheForensicsRecord({
    runtime: 'vercel',
    boundary: 'provider-request',
    confidence: 'exact',
    agentId: 'agent-1',
    connectionId: 'conn-1',
    modelId: 'model-1',
    runId,
    segments: [
      { type: 'system-prompt', label: 'body.system', content: 'stable prompt' },
      { type: 'current-user-turn', label: 'body.messages[0]:user', content: currentTurn },
    ],
    capturedAt,
  })
}

function snapshotWith(
  id: string,
  createdAt: string,
  records: CacheForensicsRecord[] | null,
): ExecutionSnapshot {
  return {
    id,
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    agentName: 'Agent One',
    createdAt,
    structuredInput: {},
    ...(records ? { cacheForensics: records } : {}),
  }
}

describe('cacheForensics Execution Viewer integration (P2/P4)', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete (env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS
  })

  it('is opt-in via BATSHIT_CACHE_FORENSICS only', () => {
    expect(isCacheForensicsEnabled()).toBe(false)
    ;(env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS = '1'
    expect(isCacheForensicsEnabled()).toBe(true)
    ;(env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS = '0'
    expect(isCacheForensicsEnabled()).toBe(false)
  })

  it('compares call 1 against the latest earlier run and patches the snapshot', async () => {
    const oldest = capture('run-1#call1', 'hello one', '2026-08-30T01:00:00.000Z')
    const newer = capture('run-2#call1', 'hello two', '2026-08-30T02:00:00.000Z')
    // getSnapshots returns newest-first, and includes the current run's own
    // snapshot (recorded pre-stream) which must be excluded from baselines.
    getSnapshots.mockResolvedValue([
      snapshotWith('msg-3', '2026-08-30T03:00:00.000Z', null),
      snapshotWith('msg-2', '2026-08-30T02:00:00.000Z', [newer]),
      snapshotWith('msg-1', '2026-08-30T01:00:00.000Z', [oldest]),
    ])
    updateSnapshot.mockResolvedValue()

    const current = capture('run-3#call1', 'hello two', '2026-08-30T03:00:00.000Z')
    const compared = await attachCacheForensicsToSnapshot({
      sessionId: 'session-1',
      snapshotId: 'msg-3',
      records: [current],
    })

    expect(compared?.[0]?.baselineRunId).toBe(newer.runId)
    expect(compared?.[0]?.divergence?.state).toBe('no-divergence')
    expect(updateSnapshot).toHaveBeenCalledWith('session-1', 'msg-3', {
      cacheForensics: compared,
    })
  })

  it('reports diverged against the latest baseline when the current turn changed', async () => {
    const baseline = capture('run-1#call1', 'hello one', '2026-08-30T01:00:00.000Z')
    getSnapshots.mockResolvedValue([
      snapshotWith('msg-2', '2026-08-30T02:00:00.000Z', null),
      snapshotWith('msg-1', '2026-08-30T01:00:00.000Z', [baseline]),
    ])
    updateSnapshot.mockResolvedValue()

    const compared = await attachCacheForensicsToSnapshot({
      sessionId: 'session-1',
      snapshotId: 'msg-2',
      records: [capture('run-2#call1', 'hello CHANGED', '2026-08-30T02:00:00.000Z')],
    })

    expect(compared?.[0]?.divergence?.state).toBe('diverged')
    expect(compared?.[0]?.divergence?.firstDivergence).toMatchObject({
      kind: 'changed',
      label: 'body.messages[0]:user',
    })
  })

  it('compares tool-loop calls 2+ against the previous call of the SAME run', () => {
    const call1 = capture('run-1#call1', 'hello', '2026-08-30T01:00:00.000Z')
    const call2 = captureCacheForensicsRecord({
      runtime: 'vercel',
      boundary: 'provider-request',
      confidence: 'exact',
      agentId: 'agent-1',
      connectionId: 'conn-1',
      modelId: 'model-1',
      runId: 'run-1#call2',
      segments: [
        { type: 'system-prompt', label: 'body.system', content: 'stable prompt' },
        { type: 'current-user-turn', label: 'body.messages[0]:user', content: 'hello' },
        { type: 'history-message', label: 'body.messages[1]:tool', content: 'tool result' },
      ],
      capturedAt: '2026-08-30T01:00:05.000Z',
    })

    const compared = compareRunRecords([call1, call2], [])

    expect(compared[0].divergence?.state).toBe('not-comparable')
    expect(compared[0].intraRunComparison).toBeUndefined()

    expect(compared[1].intraRunComparison).toBe(true)
    expect(compared[1].baselineRunId).toBe(call1.runId)
    expect(compared[1].divergence?.state).toBe('diverged')
    // The tool loop keeps the full previous prefix and appends the tool result.
    expect(compared[1].divergence?.firstDivergence).toMatchObject({ kind: 'added' })
    expect(compared[1].divergence?.reusablePrefixSegments).toBe(2)
  })

  it('leaves evidence-less calls uncompared', () => {
    const call1 = capture('run-1#call1', 'hello', '2026-08-30T01:00:00.000Z')
    const emptyCall: CacheForensicsRecord = {
      ...capture('run-1#call2', 'hello', '2026-08-30T01:00:05.000Z'),
      segments: [],
      divergence: { state: 'provider-evidence-unavailable', reason: 'no request body' },
    }
    const compared = compareRunRecords([call1, emptyCall], [])
    expect(compared[1].divergence?.state).toBe('provider-evidence-unavailable')
  })

  it('stamps export outcomes onto stored records via a follow-up patch', async () => {
    resolveExportConfig.mockReturnValue({
      state: 'ready',
      config: {
        url: 'http://127.0.0.1:5700/api/public/otel/v1/traces',
        authHeader: null,
        destinationClass: 'loopback-otlp',
      },
    } as any)
    exportRecords.mockResolvedValue({ state: 'exported', destinationClass: 'loopback-otlp' })
    getSnapshots.mockResolvedValue([snapshotWith('msg-1', '2026-08-30T01:00:00.000Z', null)])
    updateSnapshot.mockResolvedValue()

    await attachCacheForensicsToSnapshot({
      sessionId: 'session-1',
      snapshotId: 'msg-1',
      records: [capture('run-1#call1', 'hello', '2026-08-30T01:00:00.000Z')],
    })

    await vi.waitFor(() => {
      expect(updateSnapshot).toHaveBeenCalledTimes(2)
    })
    const secondPatch = updateSnapshot.mock.calls[1][2] as {
      cacheForensics: Array<{ export?: { state: string } }>
    }
    expect(secondPatch.cacheForensics[0]?.export).toEqual({
      state: 'exported',
      destinationClass: 'loopback-otlp',
    })
    resolveExportConfig.mockReturnValue({ state: 'disabled' } as any)
  })

  it('never throws into the send path when storage fails (DL-093-11)', async () => {
    getSnapshots.mockRejectedValue(new Error('redis unavailable'))

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await attachCacheForensicsToSnapshot({
      sessionId: 'session-1',
      snapshotId: 'msg-1',
      records: [capture('run-1#call1', 'hello', '2026-08-30T01:00:00.000Z')],
    })
    expect(result).toBeNull()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  function subagentRecord(runMessageId: string, parentMessageId: string, turn: string) {
    return buildManagedSubagentCacheForensicsRecord({
      lane: 'api',
      messages: [
        { role: 'system', content: 'subagent system prompt' },
        { role: 'user', content: turn },
      ],
      subagentId: 'sub-1',
      connectionId: null,
      modelId: 'model-sub',
      runMessageId,
      parentMessageId,
      capturedAt: '2026-08-30T04:00:00.000Z',
    })
  }

  it("parent attach keeps subagent records already appended to the snapshot (P4)", async () => {
    const subRecord = subagentRecord('sub-run-1', 'msg-1', 'do the side task')
    getSnapshots.mockResolvedValue([
      snapshotWith('msg-1', '2026-08-30T01:00:00.000Z', [subRecord]),
    ])
    updateSnapshot.mockResolvedValue()

    const parent = capture('run-1#call1', 'hello', '2026-08-30T01:00:00.000Z')
    await attachCacheForensicsToSnapshot({
      sessionId: 'session-1',
      snapshotId: 'msg-1',
      records: [parent],
    })

    const patch = updateSnapshot.mock.calls[0][2] as {
      cacheForensics: CacheForensicsRecord[]
    }
    expect(patch.cacheForensics).toHaveLength(2)
    expect(patch.cacheForensics[0].actor).toBeUndefined()
    expect(patch.cacheForensics[1].actor).toBe('subagent')
    expect(patch.cacheForensics[1].runId).toBe(subRecord.runId)
  })

  it('appends a subagent record and baselines it against earlier subagent runs only', async () => {
    const parentBaseline = capture('run-1#call1', 'hello', '2026-08-30T01:00:00.000Z')
    const earlierSub = subagentRecord('sub-run-1', 'msg-1', 'do the side task')
    getSnapshots.mockResolvedValue([
      snapshotWith('msg-2', '2026-08-30T02:00:00.000Z', null),
      snapshotWith('msg-1', '2026-08-30T01:00:00.000Z', [parentBaseline, earlierSub]),
    ])
    updateSnapshot.mockResolvedValue()

    const current = subagentRecord('sub-run-2', 'msg-2', 'do the side task')
    const compared = await appendSubagentCacheForensicsRecord({
      sessionId: 'session-1',
      parentMessageId: 'msg-2',
      record: current,
    })

    expect(compared?.actor).toBe('subagent')
    expect(compared?.baselineRunId).toBe(earlierSub.runId)
    expect(compared?.divergence?.state).toBe('no-divergence')
    expect(updateSnapshot).toHaveBeenCalledWith('session-1', 'msg-2', {
      cacheForensics: [compared],
    })
  })

  it('does not invent storage when the parent snapshot is missing', async () => {
    getSnapshots.mockResolvedValue([
      snapshotWith('msg-1', '2026-08-30T01:00:00.000Z', null),
    ])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const compared = await appendSubagentCacheForensicsRecord({
      sessionId: 'session-1',
      parentMessageId: 'msg-unknown',
      record: subagentRecord('sub-run-9', 'msg-unknown', 'task'),
    })
    expect(compared).toBeNull()
    expect(updateSnapshot).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
