import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

const { mockGetRuntimeEnv } = vi.hoisted(() => ({
  mockGetRuntimeEnv: vi.fn()
}))

vi.mock('$lib/server/services/runtimeEnv', () => ({
  getRuntimeEnv: mockGetRuntimeEnv
}))

import { runN8nCompatibilitySync } from '../n8nParameterCompatibility'

function node(displayName: string, properties = ['temperature', 'maxTokens']) {
  return {
    name: `@n8n/n8n-nodes-langchain.lmChat${displayName.replace(/[^a-z0-9]/gi, '')}`,
    displayName,
    outputs: ['ai_languageModel'],
    properties: properties.map((name) => ({ name }))
  }
}

describe('n8nParameterCompatibility', () => {
  useRedisTestServer()

  beforeEach(() => {
    mockGetRuntimeEnv.mockImplementation(async (key: string) => {
      if (key === 'N8N_API_URL') return 'http://n8n.local'
      if (key === 'N8N_API_KEY') return 'test-api-key'
      return null
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === 'http://n8n.local/rest/node-types') {
          return Response.json({
            data: [
              node('Baseten Chat Model'),
              node('Alibaba Cloud Chat Model'),
              node('MiniMax Chat Model'),
              node('Moonshot Kimi Chat Model'),
              node('NVIDIA Nemotron Chat Model'),
              node('Lemonade Model', ['temperature']),
              node('Lemonade Chat Model', ['maxTokens'])
            ]
          })
        }

        return Response.json({}, { status: 404 })
      })
    )
  })

  it('maps current n8n chat-model providers and merges duplicate provider rows', async () => {
    const snapshot = await runN8nCompatibilitySync()
    const entries = new Map(snapshot.entries.map((entry) => [entry.scope.provider, entry.allow]))

    expect([...entries.keys()].sort()).toEqual([
      'alibaba',
      'baseten',
      'lemonade',
      'minimax',
      'moonshot',
      'nvidia'
    ])

    for (const provider of ['alibaba', 'baseten', 'minimax', 'moonshot', 'nvidia']) {
      expect(entries.get(provider)).toEqual(['maxTokens', 'temperature'])
    }
    expect(entries.get('lemonade')).toEqual(['maxTokens', 'temperature'])
  })

  it('adds curated compatibility for Baseten when n8n omits its node metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === 'http://n8n.local/rest/node-types') {
          return Response.json({
            data: [node('Moonshot Kimi Chat Model')]
          })
        }

        return Response.json({}, { status: 404 })
      })
    )

    const snapshot = await runN8nCompatibilitySync()
    const baseten = snapshot.entries.find((entry) => entry.scope.provider === 'baseten')

    expect(baseten?.allow).toEqual([
      'frequencyPenalty',
      'maxTokens',
      'presencePenalty',
      'responseFormat',
      'temperature',
      'topP'
    ])
  })
})
