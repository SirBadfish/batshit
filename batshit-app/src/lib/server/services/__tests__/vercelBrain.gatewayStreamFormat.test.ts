/**
 * BL-1782 on the delegated lane: an API Subagent's or Worker's run (`processNativeMode`, the second
 * consumer of an API run's stream) through the Vercel AI Gateway, answered with the stream
 * captured on 2026-10-18. The REAL `VercelAIBrain`, the REAL Gateway observer, the REAL
 * `@ai-sdk/gateway` and `ai`; only the network (a fetch that replays the capture), the model
 * lookup and the tool list are faked. No Redis, no keys.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')

const slot = vi.hoisted(() => ({ model: null as any }))

vi.mock('$lib/server/services/providers', () => {
  const factory = () => ({
    getModel: () => slot.model,
    listAvailableModels: () => []
  })
  const ProviderManager = vi.fn(function MockProviderManager(this: Record<string, unknown>) {
    Object.assign(this, factory())
  })
  ;(ProviderManager as any).createForUser = vi.fn(async () => factory())
  return {
    ProviderManager,
    resolveProviderAccess: vi.fn().mockResolvedValue({ apiKeys: {} })
  }
})

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    getUserSettings: vi.fn().mockResolvedValue(null)
  }
}))

import { createGateway, dynamicTool } from 'ai'
import { z } from 'zod'
import { VercelAIBrain, type NativeModeRequest } from '../vercelBrain'
import { observeGatewayStreamFormat } from '../providers/gatewayStreamFormat'
import {
  GATEWAY_V2_FINISH_TEXT_EVENTS,
  GATEWAY_V2_FINISH_TOOL_CALL_EVENTS,
  eventStreamResponse
} from './fixtures/gatewayV2FinishStreams'

const NAMED_ERROR =
  'The Vercel AI Gateway replied in a stream format this Batshit version cannot read, so the tool call test-researcher did not run; use a direct provider connection for this model.'

const toolRuns: unknown[] = []

/** A delegated run on the Gateway model `ProviderManager.buildModel` builds (the observer around it). */
function delegatedRun(answer: ReadonlyArray<Record<string, unknown>>) {
  slot.model = observeGatewayStreamFormat(
    createGateway({
      apiKey: 'bl1782-placeholder-gateway-key',
      baseURL: 'https://gateway.test/v3/ai',
      fetch: (async () => eventStreamResponse(answer)) as any
    })('claude-haiku-5-5')
  )
  const brain = new VercelAIBrain()
  ;(brain as any).buildToolsForMode3 = vi.fn(async () => ({
    tools: {
      'test-researcher': dynamicTool({
        description: 'Ask the Researcher subagent a question.',
        inputSchema: z.object({ chatInput: z.string() }),
        execute: async (input: unknown) => {
          toolRuns.push(input)
          return 'The researcher says: 4'
        }
      })
    },
    maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
    toolApprovals: {},
    ephemeralImages: null
  }))
  return brain.processNativeMode({
    model: 'claude-haiku-5-5',
    connection: { id: 'vercel-gateway', type: 'vercel-gateway', service: 'vercel-gateway' },
    messages: [
      { role: 'system', content: 'For every user question you MUST call the test-researcher tool exactly once.' },
      { role: 'user', content: 'What is 2 plus 2? Answer with one number.' }
    ],
    sessionId: 'sess-bl1782',
    messageId: 'msg-bl1782',
    userId: 'user-1',
    agentId: 'agent-1',
    maxToolRounds: 3
  } as unknown as NativeModeRequest)
}

describe('BL-1782: an API Subagent or Worker run through the Gateway (processNativeMode)', () => {
  beforeEach(() => {
    toolRuns.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('fails the run with the named error when its tool call could not run', async () => {
    await expect(delegatedRun(GATEWAY_V2_FINISH_TOOL_CALL_EVENTS)).rejects.toMatchObject({
      code: 'GATEWAY_STREAM_FORMAT',
      status: 502,
      message: NAMED_ERROR
    })
    expect(toolRuns).toEqual([])
  })

  it('answers a reply of words only as before', async () => {
    const result = await delegatedRun(GATEWAY_V2_FINISH_TEXT_EVENTS)
    expect(result.content).toBe('Two plus two is 4.')
    expect(toolRuns).toEqual([])
  })
})
