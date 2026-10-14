import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'

const redisMock = vi.hoisted(() => {
  const store = new Map<string, any>()
  const jsonGet = vi.fn(async (key: string) => store.get(key) ?? null)
  const jsonSet = vi.fn(async (key: string, _path: string, value: any) => {
    store.set(key, structuredClone(value))
    return 'OK'
  })
  const sendCommand = vi.fn(async (command: string[]) => {
    const [name, key, path, payload] = command
    if (name === 'JSON.GET') {
      const value = store.get(key)
      if (!value) return null
      if (path === '$[*].id') {
        return JSON.stringify(
          Array.isArray(value)
            ? value.map((entry) => (typeof entry?.id === 'string' ? entry.id : null))
            : []
        )
      }
      const match = typeof path === 'string' ? path.match(/^\$\[(\d+)\]$/) : null
      if (match) {
        const index = Number(match[1])
        return JSON.stringify(Array.isArray(value) && value[index] ? [value[index]] : [])
      }
      return JSON.stringify(value)
    }

    if (name === 'JSON.SET') {
      if (path === '$') {
        store.set(key, JSON.parse(payload))
        return 'OK'
      }
      const match = typeof path === 'string' ? path.match(/^\$\[(\d+)\]$/) : null
      if (!match) throw new Error(`Unsupported JSON.SET path: ${path}`)
      const index = Number(match[1])
      const current = store.get(key)
      if (!Array.isArray(current)) throw new Error('JSON.SET target is not an array')
      const next = structuredClone(current)
      next[index] = JSON.parse(payload)
      store.set(key, next)
      return 'OK'
    }

    if (name === 'JSON.ARRAPPEND') {
      const current = store.get(key)
      if (!Array.isArray(current)) throw new Error('JSON.ARRAPPEND target is not an array')
      const next = structuredClone(current)
      next.push(JSON.parse(payload))
      store.set(key, next)
      return [next.length]
    }

    if (name === 'JSON.ARRTRIM') {
      const current = store.get(key)
      if (!Array.isArray(current)) return [0]
      const start = Number(command[3])
      const stop = Number(command[4])
      const normalizedStart = start < 0 ? Math.max(current.length + start, 0) : start
      const normalizedStop = stop < 0 ? current.length + stop : stop
      const next = current.slice(normalizedStart, normalizedStop + 1)
      store.set(key, next)
      return [next.length]
    }

    throw new Error(`Unsupported command: ${name}`)
  })
  const del = vi.fn(async (key: string) => {
    store.delete(key)
    return 1
  })
  const expire = vi.fn(async () => true)
  const execute = vi.fn(async (operation: any) =>
    operation({
      json: {
        get: jsonGet,
        set: jsonSet
      },
      sendCommand,
      del,
      expire
    })
  )

  return {
    store,
    jsonGet,
    jsonSet,
    sendCommand,
    del,
    expire,
    execute
  }
})

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: redisMock.execute
  }
}))

let executionViewerService: typeof import('../executionViewerService').executionViewerService

beforeAll(async () => {
  ;({ executionViewerService } = await import('../executionViewerService'))
})

beforeEach(() => {
  redisMock.store.clear()
  vi.clearAllMocks()
})

function buildSnapshot(id: string, createdAt: string): ExecutionSnapshot {
  return {
    id,
    sessionId: 'session-ev',
    userId: 'user-1',
    agentId: 'agent-1',
    agentName: 'EV Test Agent',
    agentType: 'batshit',
    createdAt,
    structuredInput: {
      messages: []
    },
    compiledMessages: [],
    runtime: {
      runtimeId: 'vercel',
      status: 'running'
    }
  }
}

describe('executionViewerService retention', () => {
  it('keeps only the latest ten session snapshots without setting a Redis TTL', async () => {
    for (let index = 0; index < 12; index += 1) {
      await executionViewerService.recordSnapshot(
        buildSnapshot(
          `run-${index}`,
          new Date(Date.UTC(2026, 4, 14, 12, index)).toISOString()
        )
      )
    }

    const stored = redisMock.store.get('session:session-ev:execution_log')
    expect(stored).toHaveLength(10)
    expect(redisMock.expire).not.toHaveBeenCalled()

    const snapshots = await executionViewerService.getSnapshots('session-ev')
    expect(snapshots).toHaveLength(10)
    expect(snapshots[0]?.id).toBe('run-11')
    expect(snapshots[9]?.id).toBe('run-2')
  })

  it('updates an existing snapshot without adding a Redis TTL', async () => {
    await executionViewerService.recordSnapshot(
      buildSnapshot('run-1', '2026-05-14T12:00:00.000Z')
    )
    vi.clearAllMocks()

    await executionViewerService.updateSnapshot('session-ev', 'run-1', {
      responseSummary: {
        content: {
          value: 'Done',
          confidence: 'exact'
        },
        usage: {
          inputTokens: { value: 10, confidence: 'exact' },
          outputTokens: { value: 5, confidence: 'exact' },
          totalTokens: { value: 15, confidence: 'exact' }
        },
        toolCallsCount: { value: 0, confidence: 'exact' }
      },
      runtime: {
        runtimeId: 'vercel',
        status: 'succeeded'
      },
      reasoningPersistence: {
        userHistoryStatus: 'saved',
        agentHistoryStatus: 'included',
        characterCount: 24,
        source: 'message.metadata.reasoningSummary'
      }
    })

    expect(redisMock.expire).not.toHaveBeenCalled()
    const snapshots = await executionViewerService.getSnapshots('session-ev')
    expect(snapshots[0]?.responseSummary?.content.value).toBe('Done')
    expect(snapshots[0]?.runtime?.status).toBe('succeeded')
    expect(snapshots[0]?.reasoningPersistence).toEqual({
      userHistoryStatus: 'saved',
      agentHistoryStatus: 'included',
      characterCount: 24,
      source: 'message.metadata.reasoningSummary'
    })
  })

  it('stores SA-093 cache-forensics records on the existing snapshot key intact', async () => {
    await executionViewerService.recordSnapshot(
      buildSnapshot('run-1', '2026-05-14T12:00:00.000Z')
    )

    const record = {
      schemaVersion: 1 as const,
      capturedAt: '2026-08-30T05:00:00.000Z',
      comparisonId: 'a'.repeat(64),
      runtime: 'vercel' as const,
      boundary: 'batshit-compiled' as const,
      confidence: 'exact' as const,
      runId: 'b'.repeat(64),
      segments: [
        {
          index: 0,
          type: 'system-prompt' as const,
          label: 'system',
          hmac: 'c'.repeat(64),
          bytes: 128,
          chars: 128,
          confidence: 'exact' as const
        }
      ],
      divergence: { state: 'not-comparable' as const, reason: 'first run in session' }
    }

    await executionViewerService.updateSnapshot('session-ev', 'run-1', {
      cacheForensics: [record]
    })

    // Same per-session key — no new Redis namespace for forensic records.
    expect(redisMock.store.has('session:session-ev:execution_log')).toBe(true)
    const snapshots = await executionViewerService.getSnapshots('session-ev')
    expect(snapshots[0]?.cacheForensics).toEqual([record])
  })

  it('bounds oversized debug strings during snapshot updates', async () => {
    await executionViewerService.recordSnapshot(
      buildSnapshot('run-1', '2026-05-14T12:00:00.000Z')
    )

    const largeContent = `${'A'.repeat(90_000)}${'B'.repeat(35_000)}`

    await executionViewerService.updateSnapshot('session-ev', 'run-1', {
      responseSummary: {
        content: {
          value: largeContent,
          confidence: 'exact'
        },
        usage: {
          inputTokens: { value: 10, confidence: 'exact' },
          outputTokens: { value: 5, confidence: 'exact' },
          totalTokens: { value: 15, confidence: 'exact' }
        },
        toolCallsCount: { value: 0, confidence: 'exact' }
      }
    })

    const snapshots = await executionViewerService.getSnapshots('session-ev')
    const storedContent = snapshots[0]?.responseSummary?.content.value ?? ''
    expect(storedContent.length).toBeLessThan(largeContent.length)
    expect(storedContent).toContain('Execution Viewer stored preview truncated')
    expect(storedContent.endsWith('B'.repeat(20_000))).toBe(true)
  })

  it('bounds oversized debug strings during initial snapshot recording', async () => {
    const largeContent = `${'A'.repeat(90_000)}${'B'.repeat(35_000)}`
    const snapshot = buildSnapshot('run-1', '2026-05-14T12:00:00.000Z')
    snapshot.compiledMessages = [
      {
        role: 'user',
        content: largeContent
      }
    ] as any

    await executionViewerService.recordSnapshot(snapshot)

    const snapshots = await executionViewerService.getSnapshots('session-ev')
    const storedContent = snapshots[0]?.compiledMessages?.[0]?.content ?? ''
    expect(storedContent.length).toBeLessThan(largeContent.length)
    expect(storedContent).toContain('Execution Viewer stored preview truncated')
    expect(storedContent.endsWith('B'.repeat(20_000))).toBe(true)
  })

  it('redacts image data URLs and base64 fields during snapshot storage', async () => {
    const rawBase64 = 'A'.repeat(2048)
    const snapshot = buildSnapshot('run-1', '2026-05-14T12:00:00.000Z')
    snapshot.structuredInput = {
      clippedItems: [
        {
          clipId: 'clip-image',
          content: `data:image/png;base64,${rawBase64}`,
          localBase64: rawBase64,
          contentType: 'image'
        }
      ]
    }
    snapshot.compiledMessages = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${rawBase64}`
            }
          }
        ]
      }
    ] as any

    await executionViewerService.recordSnapshot(snapshot)

    const snapshots = await executionViewerService.getSnapshots('session-ev')
    const serialized = JSON.stringify(snapshots[0])
    expect(serialized).toContain('redacted image/png data URL')
    expect(serialized).toContain('redacted base64 payload')
    expect(serialized).not.toContain(rawBase64)
    expect(serialized).not.toContain('data:image/png;base64')
  })

  it.each(['record', 'update'] as const)('keeps shared compiled content and metadata during %s (BL-763)', async (operation) => {
    const content = [{ type: 'text', text: 'A compiled input with shared content' }]
    const metadata = { memoryContext: { awarenessCount: 2, source: 'compile' } }
    const snapshot = buildSnapshot('run-shared', '2026-05-14T12:00:00.000Z')
    snapshot.structuredInput = { messages: [{ role: 'user', content }], metadata }
    snapshot.compiledMessages = [{ role: 'user', content }]
    snapshot.compileMetadata = { ...metadata }

    if (operation === 'record') {
      await executionViewerService.recordSnapshot(snapshot)
    } else {
      await executionViewerService.recordSnapshot(buildSnapshot(snapshot.id, snapshot.createdAt))
      await executionViewerService.updateSnapshot(snapshot.sessionId, snapshot.id, {
        structuredInput: snapshot.structuredInput,
        compiledMessages: snapshot.compiledMessages,
        compileMetadata: snapshot.compileMetadata
      })
    }

    const stored = await executionViewerService.getSnapshot(snapshot.sessionId, snapshot.id)
    expect(stored?.structuredInput.messages[0].content).toEqual(content)
    expect(stored?.compiledMessages?.[0].content).toEqual(content)
    expect(stored?.structuredInput.metadata).toEqual(metadata)
    expect(stored?.compileMetadata).toEqual(metadata)
    expect(JSON.stringify(stored)).not.toContain('omitted circular reference')
    expect(snapshot.structuredInput.messages[0].content).toBe(content)
    expect(snapshot.compiledMessages[0].content).toBe(content)
    expect(snapshot.compileMetadata.memoryContext).toBe(metadata.memoryContext)
  })

  it.each(['record', 'update'] as const)('marks actual object and array backedges during %s, retaining shared branches (BL-763)', async (operation) => {
    const object: any = { label: 'shared object' }
    object.self = object
    object.child = { parent: object }
    const array: any[] = ['shared array']
    array.push(array)
    const payload = { first: object, second: object, array, repeatedArray: array }
    const snapshot = buildSnapshot('run-cycles', '2026-05-14T12:00:00.000Z')
    if (operation === 'record') {
      await executionViewerService.recordSnapshot({ ...snapshot, structuredInput: payload })
    } else {
      await executionViewerService.recordSnapshot(snapshot)
      await executionViewerService.updateSnapshot(snapshot.sessionId, snapshot.id, { structuredInput: payload })
    }

    const stored = await executionViewerService.getSnapshot(snapshot.sessionId, snapshot.id)
    const circular = '[Execution Viewer omitted circular reference]'
    const expectedObject = { label: 'shared object', self: circular, child: { parent: circular } }
    expect(stored?.structuredInput.first).toEqual(expectedObject)
    expect(stored?.structuredInput.second).toEqual(expectedObject)
    expect(stored?.structuredInput.array).toEqual(['shared array', circular])
    expect(stored?.structuredInput.repeatedArray).toEqual(['shared array', circular])
    expect(object.self).toBe(object)
    expect(array[1]).toBe(array)
  })

  it.each(['record', 'update'] as const)('redacts and bounds each shared branch during %s without mutating the input (BL-763)', async (operation) => {
    const rawBase64 = 'RkFLRV9JTUFHRV9CQVNFMjY0'.repeat(100)
    const text = `${'A'.repeat(90_000)}${'B'.repeat(35_000)}`
    const shared = { content: `data:image/png;base64,${rawBase64}`, localBase64: rawBase64, text }
    const payload = { first: shared, second: shared }
    const snapshot = buildSnapshot('run-redacted', '2026-05-14T12:00:00.000Z')
    if (operation === 'record') {
      await executionViewerService.recordSnapshot({ ...snapshot, structuredInput: payload })
    } else {
      await executionViewerService.recordSnapshot(snapshot)
      await executionViewerService.updateSnapshot(snapshot.sessionId, snapshot.id, { structuredInput: payload })
    }

    const stored = await executionViewerService.getSnapshot(snapshot.sessionId, snapshot.id)
    for (const branch of ['first', 'second']) {
      const value = stored?.structuredInput[branch]
      expect(value?.content).toContain('redacted image/png data URL')
      expect(value?.localBase64).toContain('redacted base64 payload')
      expect(value?.text.length).toBeLessThan(text.length)
      expect(value?.text).toContain('Execution Viewer stored preview truncated')
      expect(value?.text.endsWith('B'.repeat(20_000))).toBe(true)
    }
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain(rawBase64)
    expect(serialized).not.toContain('data:image/png;base64')
    expect(shared).toEqual({ content: `data:image/png;base64,${rawBase64}`, localBase64: rawBase64, text })
    expect(payload.first).toBe(payload.second)
  })

  it('clears snapshots only when explicitly asked by session cleanup or the DELETE endpoint', async () => {
    await executionViewerService.recordSnapshot(
      buildSnapshot('run-1', '2026-05-14T12:00:00.000Z')
    )

    await executionViewerService.clearSnapshots('session-ev')

    expect(redisMock.del).toHaveBeenCalledWith('session:session-ev:execution_log')
    expect(await executionViewerService.getSnapshots('session-ev')).toEqual([])
  })
})

/**
 * BL-245 review, finding 1 — the calls of a run that failed while its finish callback was still
 * busy. The loop waits at most 2 s for that callback, then the failure path writes the calls it
 * recorded; the callback's write lands afterwards, and this merge keeps both writers' rows (their
 * fingerprints differ: the SDK's steps carry response messages, the recorder's do not). One writer
 * claims the calls (`createLlmCaptureClaim`, taken before either awaits).
 */
describe('one set of calls when the finish callback outlives the 2 s wait (BL-245 review)', () => {
  const usage = { inputTokens: 1208, outputTokens: 21, totalTokens: 1229 }
  const sdkSteps = [
    {
      request: { body: { model: 'glm-5.3', messages: ['read the logs'] } },
      response: { id: 'r1', modelId: 'glm-5.3', messages: [{ role: 'assistant', content: 'reading' }] },
      toolCalls: [{ toolCallId: 'call_1', toolName: 'native_bash_execute', input: { command: 'cat app.log' } }],
      toolResults: [{ toolCallId: 'call_1' }],
      finishReason: 'tool-calls',
      usage
    },
    {
      request: { body: { model: 'glm-5.3', messages: ['…'] } },
      response: { id: 'r2', modelId: 'glm-5.3', messages: [{ role: 'assistant', content: 'done' }] },
      toolCalls: [],
      toolResults: [],
      text: 'The logs show',
      finishReason: 'stop',
      usage: { inputTokens: 1400, outputTokens: 9, totalTokens: 1409 }
    }
  ]

  async function runBothWriters(useClaim: boolean) {
    const { buildVercelLlmCapture } = await import('../executionViewerLlmCapture')
    const { createLlmCaptureClaim, createStreamStepRecorder } = await import('../streamFailureEvidence')
    await executionViewerService.recordSnapshot(buildSnapshot('run-slow-finish', '2026-09-25T20:00:00.000Z'))
    const recorder = createStreamStepRecorder()
    for (const [index, step] of sdkSteps.entries()) {
      recorder.observe({ type: 'start-step', request: step.request })
      for (const call of step.toolCalls) recorder.observe({ type: 'tool-call', ...call })
      if (index === 0) recorder.observe({ type: 'finish-step', usage, finishReason: 'tool-calls', response: { id: 'r1' } })
    }
    const claim = createLlmCaptureClaim()

    // The finish callback starts, claims, and is still busy (zips, reasoning) past the wait.
    const finishOwns = useClaim ? claim.claim('finish') : true
    let letFinishWrite: () => void = () => {}
    const finishing = (async () => {
      await new Promise<void>((resolve) => {
        letFinishWrite = resolve
      })
      const capture = buildVercelLlmCapture({ steps: sdkSteps, totalUsage: null })
      await executionViewerService.updateSnapshot('session-ev', 'run-slow-finish', {
        ...(finishOwns ? { llmSummary: capture.llmSummary, llmCalls: capture.llmCalls } : {}),
        responseSummary: { content: { value: 'The logs show', confidence: 'exact' } } as any
      })
    })()

    // The failure path, after the wait.
    if (!useClaim || claim.claim('failure')) {
      const capture = buildVercelLlmCapture({ steps: recorder.steps('error'), totalUsage: null })
      await executionViewerService.updateSnapshot('session-ev', 'run-slow-finish', {
        llmSummary: capture.llmSummary,
        llmCalls: capture.llmCalls
      })
    }
    letFinishWrite()
    await finishing
    const [snapshot] = await executionViewerService.getSnapshots('session-ev')
    return snapshot
  }

  it('writes one set: the finish callback claimed the calls, so the failure path writes none', async () => {
    const snapshot = await runBothWriters(true)
    expect(snapshot.llmCalls).toHaveLength(2)
    expect(snapshot.llmCalls?.map((call) => call.finishReason)).toEqual(['tool-calls', 'stop'])
    expect(snapshot.llmSummary?.callsCount.value).toBe(2)
    expect(snapshot.responseSummary).toBeDefined()
  })

  it('two writers stack their rows in the merge (why there is one writer)', async () => {
    const snapshot = await runBothWriters(false)
    expect(snapshot.llmCalls).toHaveLength(4)
  })
})

describe('an approval resume keeps the paused run’s tool steps (BL-321)', () => {
  const step = (toolCallId: string, toolName: string) => ({ toolCallId, toolName, input: {}, output: { ok: true } })

  it('reads the steps a snapshot holds, and none for a snapshot it does not have', async () => {
    await executionViewerService.recordSnapshot({
      ...buildSnapshot('run-1', '2026-09-25T20:36:35.000Z'),
      intermediateSteps: [step('toolu_ocr', 'native_batshit_tool_use')]
    })

    expect(await executionViewerService.getSnapshotSteps('session-ev', 'run-1')).toEqual([
      step('toolu_ocr', 'native_batshit_tool_use')
    ])
    expect(await executionViewerService.getSnapshotSteps('session-ev', 'missing')).toEqual([])
    expect(await executionViewerService.getSnapshotSteps('session-none', 'run-1')).toEqual([])
  })

  it('the resume’s own write adds its steps after the paused run’s, in order', async () => {
    const { mergeResumedSteps } = await import('../approvalResumeMessage')
    await executionViewerService.recordSnapshot({
      ...buildSnapshot('run-1', '2026-09-25T20:36:35.000Z'),
      intermediateSteps: [step('toolu_ocr', 'native_batshit_tool_use')]
    })

    // The resume reads the paused steps first, then records its own compile under the same id.
    const prior = await executionViewerService.getSnapshotSteps('session-ev', 'run-1')
    await executionViewerService.recordSnapshot(buildSnapshot('run-1', '2026-09-25T20:37:10.000Z'))
    await executionViewerService.updateSnapshot('session-ev', 'run-1', {
      intermediateSteps: mergeResumedSteps(prior, [
        step('toolu_start', 'native_batshit_tool_use'),
        step('toolu_run', 'native_batshit_tool_use')
      ])
    })

    const [snapshot] = await executionViewerService.getSnapshots('session-ev')
    expect(snapshot?.intermediateSteps?.map((entry: any) => entry.toolCallId)).toEqual([
      'toolu_ocr',
      'toolu_start',
      'toolu_run'
    ])
  })
})
