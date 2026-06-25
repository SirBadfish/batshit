import { describe, expect, it } from 'vitest'

import type { Agent } from '$lib/stores/agents.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import {
  CLI_WRAPPER_OVERHEAD_TOKENS,
  applyManualTrimToMessages,
  calculateTrimmedTokens,
  extendTrimmedMessageIds,
  filterTrimmedMessages,
  isMessageProtectedFromManualTrim,
  resolveAgentPrimarySavedModel,
  summarizeContextUsage,
  summarizeRunningCost
} from '$lib/utils/tokenPanel'

function buildMessage(id: string, content: string): Message {
  return {
    id,
    session_id: 'sess-1',
    user_id: 'user-1',
    role: 'user',
    content,
    timestamp: '2026-03-27T00:00:00.000Z',
    created_at: '2026-03-27T00:00:00.000Z',
  }
}

function buildModel(): SavedModel {
  return {
    id: 'model-1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4',
    modelName: 'Claude Sonnet 4',
    contextWindow: 200000,
    pricing: {
      input: 3,
      output: 15,
      cachedInput: 0.3
    },
    createdAt: '2026-03-27T00:00:00.000Z',
    updatedAt: '2026-03-27T00:00:00.000Z'
  }
}

function buildAgent(): Agent {
  return {
    id: 'agent-1',
    user_id: 'user-1',
    displayName: 'Primary Agent',
    created_at: '2026-03-27T00:00:00.000Z',
    updated_at: '2026-03-27T00:00:00.000Z',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4',
    primary_model_preset_id: 'model-1',
    primary_model_connection: {
      type: 'direct',
      service: 'anthropic'
    }
  }
}

function buildSnapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    id: 'snap-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    agentId: 'agent-1',
    agentName: 'Primary Agent',
    createdAt: '2026-03-27T00:00:00.000Z',
    structuredInput: {},
    responseSummary: {
      content: { value: 'hi', confidence: 'exact' },
      usage: {
        inputTokens: { value: 1000, confidence: 'exact', source: 'test' },
        outputTokens: { value: 500, confidence: 'exact', source: 'test' },
        totalTokens: { value: 1500, confidence: 'exact', source: 'test' },
        cachedInputTokens: { value: 200, confidence: 'exact', source: 'test' }
      },
      toolCallsCount: { value: 0, confidence: 'exact', source: 'test' }
    },
    runtime: {
      runtimeId: 'vercel',
      providerId: 'anthropic',
      connectionId: 'anthropic',
      modelName: 'claude-sonnet-4',
      transport: 'vercel-sdk',
      status: 'succeeded'
    },
    ...overrides
  }
}

describe('tokenPanel utilities', () => {
  it('extends trim from the oldest untrimmed messages without deleting history', () => {
    const messages = [
      buildMessage('m1', 'A'.repeat(4000)),
      buildMessage('m2', 'B'.repeat(4000)),
      buildMessage('m3', 'C'.repeat(100)),
    ]

    const trimmedIds = extendTrimmedMessageIds(messages, [], 500)

    expect(trimmedIds).toEqual(['m1'])
    expect(filterTrimmedMessages(messages, trimmedIds).map((message) => message.id)).toEqual([
      'm2',
      'm3'
    ])
    expect(calculateTrimmedTokens(messages, trimmedIds)).toBeGreaterThan(0)
  })

  it('skips messages containing user-unzipped zip references when extending trim', () => {
    const messages = [
      buildMessage('m1', '{{batshit-zip:zip_user:::important output}}'),
      buildMessage('m2', 'B'.repeat(4000)),
      buildMessage('m3', 'latest message'),
    ]

    const trimmedIds = extendTrimmedMessageIds(messages, [], 500, {
      protections: {
        userUnzippedZipIds: ['zip_user']
      }
    })

    expect(isMessageProtectedFromManualTrim(messages[0], {
      userUnzippedZipIds: ['zip_user']
    })).toBe(true)
    expect(trimmedIds).toEqual(['m2'])
  })

  it('skips messages containing any protected manually unzipped zip reference', () => {
    const messages = [
      buildMessage('m1', '{{batshit-zip:zip_agent:::agent opened this}}'),
      buildMessage('m2', 'B'.repeat(4000)),
      buildMessage('m3', 'latest message'),
    ]

    const trimmedIds = extendTrimmedMessageIds(messages, [], 500, {
      protections: {
        protectedUnzippedZipIds: ['zip_agent']
      }
    })

    expect(isMessageProtectedFromManualTrim(messages[0], {
      protectedUnzippedZipIds: ['zip_agent']
    })).toBe(true)
    expect(trimmedIds).toEqual(['m2'])
  })

  it('replaces trimmed messages with a model-facing manual trim notice', () => {
    const messages = [
      buildMessage('m1', 'old context'),
      buildMessage('m2', 'middle context'),
      buildMessage('m3', 'latest message'),
    ]

    const applied = applyManualTrimToMessages(messages, ['m1', 'm2'])

    expect(applied.map((message) => message.id)).toEqual([
      'batshit_manual_context_trim_notice',
      'm3'
    ])
    expect(applied[0].role).toBe('system')
    expect(applied[0].content).toContain('2 older chat messages')
    expect(applied[0].content).toContain('Reset Trim')
  })

  it('resolves the active saved model from the agent preset', () => {
    const model = buildModel()
    const agent = buildAgent()

    expect(resolveAgentPrimarySavedModel(agent, [model])?.id).toBe('model-1')
  })

  it('summarizes running cost from stored usage and current model pricing', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeRunningCost([buildSnapshot()], model, agent)

    expect(summary.state).toBe('exact')
    expect(summary.cost).not.toBeNull()
    expect(summary.cost).toBeCloseTo(0.00996, 5)
  })

  it('downgrades running cost confidence when runtime identity no longer matches the active model', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeRunningCost(
      [
        buildSnapshot({
          runtime: {
            runtimeId: 'vercel',
            providerId: 'openai',
            connectionId: 'openai',
            modelName: 'gpt-4.1',
            transport: 'vercel-sdk',
            status: 'succeeded'
          }
        })
      ],
      model,
      agent
    )

    expect(summary.state).toBe('estimated')
    expect(summary.cost).not.toBeNull()
  })

  it('uses latest runtime input usage as the context meter truth source', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'visible chat')],
      snapshots: [
        buildSnapshot({
          compiledMessages: [
            { role: 'system', content: 'actual compiled prompt after zips' },
            { role: 'user', content: 'ZIP::abc123' }
          ],
          responseSummary: {
            content: { value: 'done', confidence: 'exact' },
            usage: {
              inputTokens: { value: 68000, confidence: 'exact', source: 'provider' },
              outputTokens: { value: 1200, confidence: 'exact', source: 'provider' },
              totalTokens: { value: 69200, confidence: 'exact', source: 'provider' },
              reasoningTokens: { value: 900, confidence: 'exact', source: 'provider' }
            },
            toolCallsCount: { value: 0, confidence: 'exact', source: 'test' }
          }
        })
      ],
      activeModel: model,
      agent
    })

    expect(summary.state).toBe('exact')
    expect(summary.displayTokens).toBe(68000)
    expect(summary.lastReasoningTokens).toBe(900)
    expect(summary.detail).toContain('post-zip/post-compile')
  })

  it('does not let a saved-response live preview override exact runtime usage', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'visible chat')],
      snapshots: [
        buildSnapshot({
          responseSummary: {
            content: { value: 'done', confidence: 'exact' },
            usage: {
              inputTokens: { value: 40289, confidence: 'exact', source: 'codex' },
              outputTokens: { value: 377, confidence: 'exact', source: 'codex' },
              totalTokens: { value: 40666, confidence: 'exact', source: 'codex' },
              reasoningTokens: { value: 205, confidence: 'exact', source: 'codex' }
            },
            toolCallsCount: { value: 0, confidence: 'exact', source: 'codex' }
          },
          runtime: {
            runtimeId: 'codex',
            providerId: 'openai-codex',
            connectionId: 'openai-codex',
            modelName: 'gpt-5.5',
            transport: 'cli',
            status: 'succeeded'
          }
        })
      ],
      activeModel: model,
      agent,
      liveContextEstimateTokens: 21000,
      liveContextEstimateReason: 'the saved response'
    })

    expect(summary.state).toBe('exact')
    expect(summary.displayTokens).toBe(40289)
    expect(summary.label).toBe('40K last sent')
  })

  it('uses the saved-response preview for aggregate-only Codex tool-run usage', () => {
    const model = buildModel()
    const agent: Agent = {
      ...buildAgent(),
      agentType: 'cli',
      primary_model_provider: 'openai-codex',
      primary_model_name: 'codex-cli',
      primary_model_connection: {
        type: 'direct',
        service: 'openai-codex'
      }
    }
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'visible chat')],
      snapshots: [
        buildSnapshot({
          id: 'latest-aggregate',
          createdAt: '2026-06-02T07:08:30.000Z',
          runtime: {
            runtimeId: 'codex',
            providerId: 'openai-codex',
            connectionId: 'codex-cli',
            modelName: 'gpt-5.5',
            transport: 'codex-cli',
            status: 'succeeded'
          },
          intermediateSteps: [{ toolName: 'read_file' }, { toolName: 'read_file' }],
          responseSummary: {
            content: { value: 'done', confidence: 'exact' },
            usage: {
              inputTokens: { value: 129751, confidence: 'exact', source: 'codex' },
              outputTokens: { value: 1275, confidence: 'exact', source: 'codex' },
              totalTokens: { value: 131026, confidence: 'exact', source: 'codex' },
              cachedInputTokens: { value: 88192, confidence: 'exact', source: 'codex' }
            },
            toolCallsCount: { value: 2, confidence: 'near', source: 'codex' }
          },
          llmSummary: {
            callsCount: { value: 1, confidence: 'speculative', source: 'codex' },
            totalUsage: {
              inputTokens: { value: 129751, confidence: 'exact', source: 'codex' },
              outputTokens: { value: 1275, confidence: 'exact', source: 'codex' },
              totalTokens: { value: 131026, confidence: 'exact', source: 'codex' }
            },
            breakdownConfidence: 'speculative'
          },
          llmCalls: [
            {
              index: 1,
              runtime: 'codex',
              usage: {
                inputTokens: { value: 129751, confidence: 'exact', source: 'codex' },
                outputTokens: { value: 1275, confidence: 'exact', source: 'codex' },
                totalTokens: { value: 131026, confidence: 'exact', source: 'codex' }
              },
              requestPayload: {},
              requestConfidence: 'near'
            }
          ]
        }),
        buildSnapshot({
          id: 'older-exact',
          createdAt: '2026-06-02T06:47:26.000Z',
          responseSummary: {
            content: { value: 'done', confidence: 'exact' },
            usage: {
              inputTokens: { value: 40289, confidence: 'exact', source: 'codex' },
              outputTokens: { value: 377, confidence: 'exact', source: 'codex' },
              totalTokens: { value: 40666, confidence: 'exact', source: 'codex' }
            },
            toolCallsCount: { value: 0, confidence: 'exact', source: 'codex' }
          },
          runtime: {
            runtimeId: 'codex',
            providerId: 'openai-codex',
            connectionId: 'codex-cli',
            modelName: 'gpt-5.5',
            transport: 'codex-cli',
            status: 'succeeded'
          }
        })
      ],
      activeModel: model,
      agent,
      liveContextEstimateTokens: 47000,
      liveContextEstimateReason: 'the saved response'
    })

    expect(summary.state).toBe('estimated')
    expect(summary.displayTokens).toBe(47000)
    expect(summary.label).toBe('~47K live')
  })

  it('uses peak per-call input for multi-call Vercel tool loops instead of aggregate run input', () => {
    const model: SavedModel = {
      ...buildModel(),
      provider: 'google',
      modelId: 'gemini-3.5-flash',
      modelName: 'Gemini 3.5 Flash',
      contextWindow: 1_000_000,
      pricing: {
        input: 0.3,
        output: 2.5,
        cachedInput: 0.03
      }
    }
    const agent: Agent = {
      ...buildAgent(),
      primary_model_provider: 'google',
      primary_model_name: 'gemini-3.5-flash',
      primary_model_connection: {
        type: 'direct',
        service: 'google'
      }
    }
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'visible chat')],
      snapshots: [
        buildSnapshot({
          runtime: {
            runtimeId: 'vercel',
            providerId: 'google',
            connectionId: 'google',
            modelName: 'gemini-3.5-flash',
            transport: 'vercel-sdk',
            status: 'succeeded'
          },
          compiledMessages: [
            { role: 'system', content: 'compact compiled prompt' },
            { role: 'user', content: 'make a ComfyUI artifact' }
          ],
          llmSummary: {
            callsCount: { value: 3, confidence: 'exact', source: 'vercel ai sdk' },
            totalUsage: {
              inputTokens: { value: 735153, confidence: 'exact', source: 'provider' },
              outputTokens: { value: 31714, confidence: 'exact', source: 'provider' },
              totalTokens: { value: 766867, confidence: 'exact', source: 'provider' }
            },
            breakdownConfidence: 'exact'
          },
          llmCalls: [
            {
              index: 1,
              runtime: 'vercel',
              usage: {
                inputTokens: { value: 7327, confidence: 'exact', source: 'provider' },
                outputTokens: { value: 349, confidence: 'exact', source: 'provider' },
                totalTokens: { value: 7676, confidence: 'exact', source: 'provider' }
              },
              requestPayload: {},
              requestConfidence: 'exact'
            },
            {
              index: 2,
              runtime: 'vercel',
              usage: {
                inputTokens: { value: 76057, confidence: 'exact', source: 'provider' },
                outputTokens: { value: 5000, confidence: 'exact', source: 'provider' },
                totalTokens: { value: 81057, confidence: 'exact', source: 'provider' }
              },
              requestPayload: {},
              requestConfidence: 'exact'
            },
            {
              index: 3,
              runtime: 'vercel',
              usage: {
                inputTokens: { value: 50000, confidence: 'exact', source: 'provider' },
                outputTokens: { value: 1000, confidence: 'exact', source: 'provider' },
                totalTokens: { value: 51000, confidence: 'exact', source: 'provider' }
              },
              requestPayload: {},
              requestConfidence: 'exact'
            }
          ],
          responseSummary: {
            content: { value: 'done', confidence: 'exact' },
            usage: {
              inputTokens: { value: 735153, confidence: 'exact', source: 'provider' },
              outputTokens: { value: 31714, confidence: 'exact', source: 'provider' },
              totalTokens: { value: 766867, confidence: 'exact', source: 'provider' }
            },
            toolCallsCount: { value: 18, confidence: 'exact', source: 'vercel ai sdk' }
          }
        })
      ],
      activeModel: model,
      agent
    })

    expect(summary.state).toBe('exact')
    expect(summary.displayTokens).toBe(76057)
    expect(summary.contextPercent).toBeCloseTo(7.6057)
    expect(summary.label).toBe('76K peak call')
    expect(summary.detail).toContain('largest single-call input')
    expect(summary.detail).toContain('735K aggregate input tokens')
  })

  it('falls back to the actual compiled payload when provider usage is unavailable', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'A'.repeat(12000))],
      snapshots: [
        buildSnapshot({
          responseSummary: null,
          llmSummary: null,
          compiledMessages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: '[Zip z1]' }
          ]
        })
      ],
      activeModel: model,
      agent
    })

    expect(summary.state).toBe('estimated')
    expect(summary.displayTokens).toBe(summary.compiledEstimateTokens)
    expect(summary.displayTokens).toBeLessThan(summary.visibleEstimateTokens)
    expect(summary.detail).toContain('actual compiled messages')
  })

  it('does not count structured image data URLs as base64 text in compiled estimates', () => {
    const model = buildModel()
    const agent = buildAgent()
    const imageDataUrl = `data:image/png;base64,${'A'.repeat(500_000)}`
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', '{{batshit-clip:clip_1:::image.png}}')],
      snapshots: [
        buildSnapshot({
          responseSummary: null,
          llmSummary: null,
          compiledMessages: [
            { role: 'system', content: 'system prompt' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Can you see this image?' },
                { type: 'image_url', image_url: { url: imageDataUrl } }
              ]
            }
          ]
        })
      ],
      activeModel: model,
      agent
    })

    expect(summary.state).toBe('estimated')
    expect(summary.displayTokens).toBe(summary.compiledEstimateTokens)
    expect(summary.displayTokens).toBeGreaterThan(765)
    expect(summary.displayTokens).toBeLessThan(2_000)
    expect(summary.contextPercent).toBeLessThan(1)
  })

  it('adds the CLI wrapper reserve only to pre-send estimates', () => {
    const model = buildModel()
    const agent: Agent = {
      ...buildAgent(),
      agentType: 'cli',
      primary_model_provider: 'openai',
      primary_model_name: 'gpt-5.3-codex',
      primary_model_connection: {
        type: 'direct',
        service: 'codex'
      }
    }
    const messages = [buildMessage('m1', 'A'.repeat(4000))]
    const visibleOnlySummary = summarizeContextUsage({
      messages,
      snapshots: [],
      activeModel: model,
      agent
    })

    expect(visibleOnlySummary.state).toBe('estimated')
    expect(visibleOnlySummary.displayTokens).toBe(
      visibleOnlySummary.visibleEstimateTokens + CLI_WRAPPER_OVERHEAD_TOKENS
    )
  })

  it('uses the manual trim preview estimate while trim is active', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'trim notice plus retained context')],
      snapshots: [
        buildSnapshot({
          responseSummary: {
            content: { value: 'done', confidence: 'exact' },
            usage: {
              inputTokens: { value: 120000, confidence: 'exact', source: 'provider' },
              outputTokens: { value: 1000, confidence: 'exact', source: 'provider' },
              totalTokens: { value: 121000, confidence: 'exact', source: 'provider' }
            },
            toolCallsCount: { value: 0, confidence: 'exact', source: 'test' }
          }
        })
      ],
      activeModel: model,
      agent,
      manualTrimActive: true,
      manualTrimEstimateTokens: 65000
    })

    expect(summary.state).toBe('estimated')
    expect(summary.displayTokens).toBe(65000)
    expect(summary.label).toContain('trimmed')
  })

  it('uses a live context estimate after local context controls change', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'visible chat')],
      snapshots: [
        buildSnapshot({
          responseSummary: {
            content: { value: 'done', confidence: 'exact' },
            usage: {
              inputTokens: { value: 36000, confidence: 'exact', source: 'provider' },
              outputTokens: { value: 1000, confidence: 'exact', source: 'provider' },
              totalTokens: { value: 37000, confidence: 'exact', source: 'provider' }
            },
            toolCallsCount: { value: 0, confidence: 'exact', source: 'test' }
          }
        })
      ],
      activeModel: model,
      agent,
      liveContextEstimateTokens: 44000,
      liveContextEstimateReason: 'zip state'
    })

    expect(summary.state).toBe('estimated')
    expect(summary.displayTokens).toBe(44000)
    expect(summary.label).toContain('live')
    expect(summary.detail).toContain('zip state')
  })

  it.each([
    {
      label: 'API',
      agent: {
        agentType: 'api',
        primary_model_provider: 'anthropic',
        primary_model_name: 'claude-sonnet-4',
        primary_model_connection: {
          type: 'direct',
          service: 'anthropic'
        }
      },
      runtime: {
        runtimeId: 'vercel',
        providerId: 'anthropic',
        connectionId: 'anthropic',
        modelName: 'claude-sonnet-4',
        transport: 'vercel-sdk',
        status: 'succeeded'
      }
    },
    {
      label: 'CLI',
      agent: {
        agentType: 'cli',
        primary_model_provider: 'openai-codex',
        primary_model_name: 'gpt-5.5',
        primary_model_connection: {
          type: 'direct',
          service: 'openai-codex'
        }
      },
      runtime: {
        runtimeId: 'codex',
        providerId: 'openai-codex',
        connectionId: 'codex-cli',
        modelName: 'gpt-5.5',
        transport: 'codex-cli',
        status: 'succeeded'
      }
    },
    {
      label: 'n8n',
      agent: {
        agentType: 'n8n',
        primary_model_provider: 'anthropic',
        primary_model_name: 'claude-sonnet-4',
        primary_model_connection: {
          type: 'n8n',
          service: 'n8n'
        }
      },
      runtime: {
        runtimeId: 'n8n',
        providerId: 'n8n',
        connectionId: 'n8n-webhook',
        modelName: 'claude-sonnet-4',
        transport: 'n8n-native',
        status: 'succeeded'
      }
    }
  ])('uses active-response live estimates for $label agents instead of stale completed usage', ({ agent: agentOverrides, runtime }) => {
    const model = buildModel()
    const agent: Agent = {
      ...buildAgent(),
      ...agentOverrides
    }
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'visible chat while Cody is still streaming')],
      snapshots: [
        buildSnapshot({
          runtime,
          responseSummary: {
            content: { value: 'previous complete response', confidence: 'exact' },
            usage: {
              inputTokens: { value: 40289, confidence: 'exact', source: 'codex' },
              outputTokens: { value: 377, confidence: 'exact', source: 'codex' },
              totalTokens: { value: 40666, confidence: 'exact', source: 'codex' }
            },
            toolCallsCount: { value: 0, confidence: 'exact', source: 'codex' }
          }
        })
      ],
      activeModel: model,
      agent,
      liveContextEstimateTokens: 91000,
      liveContextEstimateReason: 'the active response'
    })

    expect(summary.state).toBe('estimated')
    expect(summary.displayTokens).toBe(91000)
    expect(summary.label).toBe('~91K live')
    expect(summary.detail).toContain('the active response')
  })

  it('lets live context estimates refresh active manual trim estimates', () => {
    const model = buildModel()
    const agent = buildAgent()
    const summary = summarizeContextUsage({
      messages: [buildMessage('m1', 'trimmed context')],
      snapshots: [],
      activeModel: model,
      agent,
      manualTrimActive: true,
      manualTrimEstimateTokens: 65000,
      liveContextEstimateTokens: 59000,
      liveContextEstimateReason: 'Reset Trim'
    })

    expect(summary.state).toBe('estimated')
    expect(summary.displayTokens).toBe(59000)
    expect(summary.label).toContain('trimmed')
    expect(summary.detail).toContain('Reset Trim')
  })
})
