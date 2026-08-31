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
        status: 'saved',
        characterCount: 24,
        source: 'message.metadata.reasoningSummary'
      }
    })

    expect(redisMock.expire).not.toHaveBeenCalled()
    const snapshots = await executionViewerService.getSnapshots('session-ev')
    expect(snapshots[0]?.responseSummary?.content.value).toBe('Done')
    expect(snapshots[0]?.runtime?.status).toBe('succeeded')
    expect(snapshots[0]?.reasoningPersistence).toEqual({
      status: 'saved',
      characterCount: 24,
      source: 'message.metadata.reasoningSummary'
    })
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

  it('clears snapshots only when explicitly asked by session cleanup or the DELETE endpoint', async () => {
    await executionViewerService.recordSnapshot(
      buildSnapshot('run-1', '2026-05-14T12:00:00.000Z')
    )

    await executionViewerService.clearSnapshots('session-ev')

    expect(redisMock.del).toHaveBeenCalledWith('session:session-ev:execution_log')
    expect(await executionViewerService.getSnapshots('session-ev')).toEqual([])
  })
})
