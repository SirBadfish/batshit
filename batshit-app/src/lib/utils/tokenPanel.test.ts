import { describe, expect, it } from 'vitest'

import type { Agent } from '$lib/stores/agents.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import { cliContextSettingsKey, reportForCliSnapshot } from '$lib/utils/cliContextWindow'
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
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'
import {
  REFERENCE_SCAN_HAND_CASES,
  generateReferenceScanTexts,
  idRunsAfter
} from '$lib/test-utils/referenceScanTexts'

describe('ChatGPT plan cost identity', () => {
  it('keeps plan monetary cost unknown even when an imported preset carries paid prices', () => {
    const plan = { ...buildModel(), connection: { id: 'chatgpt-plan:fixture', type: 'direct', service: 'chatgpt-plan' } } as SavedModel
    const summary = summarizeRunningCost([buildSnapshot()], plan, buildAgent())
    expect(summary.cost).toBeNull(); expect(summary.state).toBe('unknown')
    expect(summary.note).toContain('https://chatgpt.com/settings/usage')
  })
  it('counts delegated plan tokens while refusing a matching paid model price', () => {
    const snapshot = { ...buildSnapshot(), delegated: { runs: [{ id: 'plan-delegate', provider: 'chatgpt-plan', model: buildModel().modelId, type: 'api', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }] } } as unknown as ExecutionSnapshot
    const summary = summarizeRunningCost([snapshot], buildModel(), buildAgent(), [buildModel()])
    expect(summary.delegatedTokens).toBe(25); expect(summary.delegatedCost).toBeNull(); expect(summary.delegatedCostUnknownRuns).toBe(1)
  })
})

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
    // The shape a stored direct preset carries (`model:<id>` in Redis).
    connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic', useDeveloperPrefix: false },
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
      id: 'direct:anthropic',
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
    // What a real run records: `connectionId` is the request connection's id (`vercelBrain`).
    runtime: {
      runtimeId: 'vercel',
      providerId: 'anthropic',
      connectionId: 'direct:anthropic',
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

  it('shows the running cost as unknown, never an exact $0.00, when the preset has no price (BL-67)', () => {
    const model: SavedModel = { ...buildModel(), pricing: {} }
    const summary = summarizeRunningCost([buildSnapshot()], model, buildAgent())

    expect(summary.state).toBe('unknown')
    expect(summary.cost).toBeNull()
    expect(summary.note).toContain('no price')
  })

  it('shows the running cost as unknown when only one of the two prices is known (BL-67)', () => {
    const model: SavedModel = { ...buildModel(), pricing: { input: 3 } }
    const summary = summarizeRunningCost([buildSnapshot()], model, buildAgent())

    expect(summary.state).toBe('unknown')
    expect(summary.cost).toBeNull()
  })

  it('keeps an explicit price of zero as a real, exact $0.00 (BL-67)', () => {
    const model: SavedModel = { ...buildModel(), pricing: { input: 0, output: 0, cachedInput: 0 } }
    const summary = summarizeRunningCost([buildSnapshot()], model, buildAgent())

    expect(summary.state).toBe('exact')
    expect(summary.cost).toBe(0)
  })

  it('shows context usage as unknown, not a 0% bar, when the preset has no context window (BL-67)', () => {
    const model: SavedModel = { ...buildModel() }
    delete model.contextWindow
    const messages = [buildMessage('m1', 'hello'), buildMessage('m2', 'world')]
    const beforeAnyRun = summarizeContextUsage({
      messages,
      snapshots: [],
      activeModel: model,
      agent: buildAgent()
    })

    expect(beforeAnyRun.state).toBe('unknown')
    expect(beforeAnyRun.label).toBe('Unknown')
    expect(beforeAnyRun.contextLimit).toBeNull()
    expect(beforeAnyRun.contextPercent).toBeNull()

    // A reported token count stays a real count, but no percentage is claimed.
    const afterARun = summarizeContextUsage({
      messages,
      snapshots: [buildSnapshot()],
      activeModel: model,
      agent: buildAgent()
    })
    expect(afterARun.displayTokens).toBe(1000)
    expect(afterARun.contextLimit).toBeNull()
    expect(afterARun.contextPercent).toBeNull()
  })

  it('adds delegated usage at each run model price without changing context pressure', () => {
    const model = buildModel()
    const agent = buildAgent()
    const delegatedModel: SavedModel = {
      ...buildModel(),
      id: 'delegated-model',
      provider: 'openai',
      modelId: 'gpt-5.4',
      modelName: 'GPT-5.4',
      pricing: { input: 2, output: 10, cachedInput: 1 },
    }
    const snapshot = buildSnapshot({
      delegated: {
        runs: [
          {
            kind: 'subagent',
            name: 'API Helper',
            type: 'api',
            model: 'gpt-5.4',
            provider: 'openai',
            usage: {
              inputTokens: 1000,
              outputTokens: 500,
              totalTokens: 1500,
              cachedInputTokens: 200,
            },
            durationMs: 2000,
            status: 'completed',
            thread: 'fresh',
          },
        ],
        totals: {
          runs: 1,
          completed: 1,
          failed: 0,
          timedOut: 0,
          usageKnownRuns: 1,
          usageUnknownRuns: 0,
          usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        },
      },
    })

    const cost = summarizeRunningCost(
      [snapshot],
      model,
      agent,
      [model, delegatedModel],
    )
    const context = summarizeContextUsage({
      messages: [buildMessage('m1', 'visible chat')],
      snapshots: [snapshot],
      activeModel: model,
      agent,
    })

    expect(cost.state).toBe('exact')
    expect(cost.delegatedTokens).toBe(1500)
    expect(cost.delegatedCost).toBeCloseTo(0.0068, 6)
    expect(cost.cost).toBeCloseTo(0.01676, 6)
    expect(context.displayTokens).toBe(1000)
  })

  it('marks delegated cost estimated when any recorded run has unknown usage', () => {
    const model = buildModel()
    const summary = summarizeRunningCost(
      [
        buildSnapshot({
          delegated: {
            runs: [
              {
                kind: 'subagent',
                name: 'Workflow Helper',
                type: 'n8n-workflow',
                model: null,
                provider: null,
                usage: null,
                durationMs: 42_000,
                status: 'completed',
                thread: 'fresh',
              },
            ],
            totals: {
              runs: 1,
              completed: 1,
              failed: 0,
              timedOut: 0,
              usageKnownRuns: 0,
              usageUnknownRuns: 1,
              usage: null,
            },
          },
        }),
      ],
      model,
      buildAgent(),
      [model],
    )

    expect(summary.state).toBe('estimated')
    expect(summary.delegatedTokens).toBeNull()
    expect(summary.delegatedCost).toBeNull()
    expect(summary.delegatedUsageUnknownRuns).toBe(1)
  })

  it('never prices child observations or adds them to parent context while keeping a known subtotal', () => {
    const model = buildModel()
    const snapshot = buildSnapshot({ delegated: {
      runs: [{ kind: 'subagent', name: 'Codex failed helper', type: 'cli', model: 'gpt-5.4', provider: 'openai-codex', usage: null,
        observedUsage: { completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }] },
        durationMs: 10_000, status: 'failed', thread: 'fresh' }],
      totals: { runs: 1, completed: 0, failed: 1, timedOut: 0, usageKnownRuns: 0, usageUnknownRuns: 1, usage: null },
    } })
    const withoutChild = summarizeRunningCost([buildSnapshot()], model, buildAgent(), [model])
    const withChild = summarizeRunningCost([snapshot], model, buildAgent(), [model])
    expect(withChild.cost).toBe(withoutChild.cost)
    expect(withChild.delegatedTokens).toBeNull(); expect(withChild.delegatedCost).toBeNull()
    expect(withChild.delegatedUsageUnknownRuns).toBe(1); expect(withChild.state).toBe('estimated')
    expect(summarizeContextUsage({ snapshots: [snapshot], activeModel: model, agent: buildAgent(), messages: [] }).displayTokens).toBe(summarizeContextUsage({ snapshots: [buildSnapshot()], activeModel: model, agent: buildAgent(), messages: [] }).displayTokens)
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

  it('uses a CLI choice window and only the matching model runtime report', () => {
    const model: SavedModel = {
      ...buildModel(), contextWindow: undefined, provider: 'anthropic-claude-cli',
      connection: { id: 'claude-cli', type: 'direct', service: 'anthropic-claude-cli', useDeveloperPrefix: false }
    }
    const agent = {
      ...buildAgent(), agentType: 'cli', claude_settings: { permissionMode: 'default', model: 'sonnet[1m]' },
      primary_model_provider: 'anthropic-claude-cli',
      primary_model_connection: { type: 'direct', service: 'anthropic-claude-cli' }
    } as Agent
    const snapshot = buildSnapshot({
      runtime: {
        runtimeId: 'claude', providerId: 'anthropic-claude-cli', connectionId: 'claude-cli',
        modelName: 'sonnet[1m]', metadata: { cliContextWindow: reportForCliSnapshot({
          runtime: 'claude', model: 'sonnet[1m]', actualModel: 'claude-sonnet-5',
          contextWindow: 900_000, evidence: 'runtime'
        }, agent, model.contextWindow) }
      }
    })
    const base = { messages: [buildMessage('m1', 'hello')], activeModel: model, agent }
    expect(summarizeContextUsage({ ...base, snapshots: [] }).contextLimit).toBe(1_000_000)
    expect(summarizeContextUsage({ ...base, snapshots: [snapshot] }).contextLimit).toBe(900_000)
    const reloadedSnapshot = JSON.parse(JSON.stringify(snapshot)) as ExecutionSnapshot
    expect(summarizeContextUsage({ ...base, snapshots: [reloadedSnapshot] }).contextLimit).toBe(900_000)
    const changedAgent = { ...agent, claude_settings: { permissionMode: 'default', model: 'opus' } } as Agent
    expect(summarizeContextUsage({ ...base, agent: changedAgent, snapshots: [snapshot] }).contextLimit).toBe(1_000_000)
    const newerUnknown = buildSnapshot({
      id: 'snap-2', createdAt: '2026-03-28T00:00:00.000Z',
      runtime: {
        runtimeId: 'claude', providerId: 'anthropic-claude-cli', connectionId: 'claude-cli',
        modelName: 'sonnet[1m]', metadata: { cliContextWindow: {
          runtime: 'claude', model: 'sonnet[1m]', actualModel: 'unlisted-new-model',
          contextWindow: null, evidence: 'unresolved',
          settingsKey: cliContextSettingsKey('claude', agent, model.contextWindow)
        } }
      }
    })
    expect(summarizeContextUsage({ ...base, snapshots: [snapshot, newerUnknown] }).contextLimit).toBeNull()
    expect(summarizeContextUsage({ ...base, snapshots: [snapshot, newerUnknown], liveContextLimit: 200_000 }).contextLimit)
      .toBeNull()
  })

  it('honors the server environment cap before any live preview and refuses a differently capped report', () => {
    const model: SavedModel = { ...buildModel(), contextWindow: undefined, provider: 'anthropic-claude-cli',
      connection: { id: 'claude-cli', type: 'direct', service: 'anthropic-claude-cli', useDeveloperPrefix: false } }
    const agent = { ...buildAgent(), agentType: 'cli', claude_settings: { permissionMode: 'default', model: 'sonnet' },
      primary_model_provider: 'anthropic-claude-cli', primary_model_connection: { type: 'direct', service: 'anthropic-claude-cli' }
    } as Agent
    const snapshot = buildSnapshot({ runtime: { runtimeId: 'claude', metadata: { cliContextWindow: reportForCliSnapshot({
      runtime: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5', contextWindow: 1_000_000,
      evidence: 'runtime', disableClaude1M: false
    }, agent, model.contextWindow) } } })
    const base = { messages: [buildMessage('m1', 'hello')], activeModel: model, agent,
      claudeContextEnvironment: { disable1M: true, externalRoute: false } }
    expect(summarizeContextUsage({ ...base, snapshots: [] }).contextLimit).toBe(200_000)
    expect(summarizeContextUsage({ ...base, snapshots: [snapshot] }).contextLimit).toBe(200_000)
    expect(summarizeContextUsage({ ...base, snapshots: [snapshot],
      claudeContextEnvironment: { disable1M: false, externalRoute: false } }).contextLimit).toBe(1_000_000)
  })

  it('keeps a failed send-time window lookup unknown until newer credible evidence', () => {
    const model: SavedModel = {
      ...buildModel(), contextWindow: undefined, provider: 'anthropic-claude-cli',
      connection: { id: 'claude-cli', type: 'direct', service: 'anthropic-claude-cli', useDeveloperPrefix: false }
    }
    const agent = { ...buildAgent(), agentType: 'cli',
      claude_settings: { permissionMode: 'default', model: 'sonnet' },
      primary_model_provider: 'anthropic-claude-cli',
      primary_model_connection: { type: 'direct', service: 'anthropic-claude-cli' }
    } as Agent
    const warning = 'Could not read the saved CLI context limit. The context limit is unknown for this send.'
    const snapshot = buildSnapshot({
      runtime: { runtimeId: 'claude' },
      executionMetadata: { promptBudget: {
        contextLimit: null, contextWindowWarning: warning, contextWindowCheckedAt: 100,
        contextWindowSettingsKey: cliContextSettingsKey('claude', agent, model.contextWindow)
      } }
    })
    const base = { messages: [buildMessage('m1', 'hello')], snapshots: [snapshot], activeModel: model, agent }
    const summary = summarizeContextUsage(base)
    expect(summary.contextLimit).toBeNull()
    expect(summary.contextPercent).toBeNull()
    expect(summary.displayTokens).toBeGreaterThan(0)
    expect(summary.detail).toContain(warning)
    expect(summarizeContextUsage({ ...base, liveContextLimit: 1_000_000, liveContextCheckedAt: 99 }).contextLimit).toBeNull()
    const refreshed = summarizeContextUsage({ ...base, liveContextLimit: 1_000_000, liveContextCheckedAt: 101 })
    expect(refreshed.contextLimit).toBe(1_000_000)
    expect(refreshed.detail).not.toContain(warning)
    const changed = { ...agent, claude_settings: { permissionMode: 'default', model: 'opus' } } as Agent
    expect(summarizeContextUsage({ ...base, agent: changed }).detail).not.toContain(warning)
    expect(summarizeContextUsage({ ...base, snapshots: [], liveContextWindowWarning: warning }).contextLimit).toBeNull()
    const runtimeReport = reportForCliSnapshot({
      runtime: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5',
      contextWindow: 900_000, evidence: 'runtime', reportedAt: 200
    }, agent, model.contextWindow)
    const completed = { ...snapshot, runtime: { runtimeId: 'claude' as const, metadata: { cliContextWindow: runtimeReport } } }
    const runtimeSummary = summarizeContextUsage({ ...base, snapshots: [completed],
      liveContextWindowWarning: warning, liveContextCheckedAt: 150 })
    expect(runtimeSummary.contextLimit).toBe(900_000)
    expect(runtimeSummary.detail).not.toContain(warning)
    const oldRuntime = { ...completed, runtime: { ...completed.runtime,
      metadata: { cliContextWindow: { ...runtimeReport, reportedAt: 50 } } } }
    expect(summarizeContextUsage({ ...base, snapshots: [oldRuntime],
      liveContextWindowWarning: warning, liveContextCheckedAt: 150 }).contextLimit).toBeNull()
  })

  it('does not reuse a saved Codex window when opaque overrides have no reusable key', () => {
    const secret = 'SENTINEL-PRIVATE-HEADER-value-123'
    const model: SavedModel = {
      ...buildModel(), contextWindow: undefined, provider: 'openai-codex',
      connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex', useDeveloperPrefix: false }
    }
    const agent = {
      ...buildAgent(), agentType: 'cli', primary_model_provider: 'openai-codex',
      primary_model_connection: { type: 'direct', service: 'openai-codex' },
      codex_settings: { permissionMode: 'chat', model: 'gpt-6-sol',
        configOverrides: [{ key: 'model_providers.custom.http_headers.Authorization', value: secret }] }
    } as Agent
    const report = reportForCliSnapshot({
      runtime: 'codex', model: 'gpt-6-sol', contextWindow: 100_000, evidence: 'runtime'
    }, agent, model.contextWindow)
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(report).not.toHaveProperty('settingsKey')
    const snapshot = buildSnapshot({
      runtime: { runtimeId: 'codex', providerId: 'openai-codex', connectionId: 'codex-cli',
        modelName: 'gpt-6-sol', metadata: { cliContextWindow: report } }
    })
    expect(summarizeContextUsage({ messages: [buildMessage('m1', 'hello')], snapshots: [snapshot],
      activeModel: model, agent }).contextLimit).toBe(258_400)
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

describe('BL-184 the running cost prices a cache write at the provider write rate', () => {
  // Claude Sonnet 5, platform.claude.com pricing (2026-09-25): $2 input, $10 output, $0.20 cache
  // read; a cache write is 1.25x the input price for 5 minutes and 2x for 1 hour.
  function sonnet5(): SavedModel {
    return {
      ...buildModel(),
      modelId: 'claude-sonnet-5',
      modelName: 'Claude Sonnet 5',
      pricing: { input: 2, output: 10, cachedInput: 0.2 },
    }
  }
  function sonnet5Agent(): Agent {
    return { ...buildAgent(), primary_model_name: 'claude-sonnet-5' }
  }
  function openRouterSonnet5(): SavedModel {
    return {
      ...sonnet5(),
      id: 'or-sonnet5',
      modelId: 'anthropic/claude-sonnet-5',
      effectiveModelId: 'anthropic/claude-sonnet-5',
      connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter', useDeveloperPrefix: true },
    }
  }
  function openRouterAgent(): Agent {
    return {
      ...buildAgent(),
      primary_model_name: 'anthropic/claude-sonnet-5',
      primary_model_preset_id: 'or-sonnet5',
      primary_model_connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter' },
    }
  }
  // The live BL-77 Artifact build on Sonnet 5 (2026-09-22): the whole prompt, of which 408,786
  // read and 59,393 written.
  function artifactBuild(cacheTtl: unknown, overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
    return buildSnapshot({
      responseSummary: {
        content: { value: 'done', confidence: 'exact' },
        usage: {
          inputTokens: { value: 469_638, confidence: 'exact', source: 'provider' },
          outputTokens: { value: 16_082, confidence: 'exact', source: 'provider' },
          totalTokens: { value: 485_720, confidence: 'exact', source: 'provider' },
          cachedInputTokens: { value: 408_786, confidence: 'exact', source: 'provider' },
          cacheCreationInputTokens: { value: 59_393, confidence: 'exact', source: 'provider' },
        },
        toolCallsCount: { value: 9, confidence: 'exact', source: 'provider' },
      },
      runtime: {
        runtimeId: 'vercel',
        providerId: 'anthropic',
        connectionId: 'direct:anthropic',
        modelName: 'claude-sonnet-5',
        transport: 'vercel-sdk',
        status: 'succeeded',
        metadata:
          cacheTtl === undefined ? {} : { promptCachePolicy: { provider: 'anthropic', cacheTtl } },
      },
      ...overrides,
    })
  }
  const FRESH = 469_638 - 408_786 - 59_393 // 1,459
  const baseCost = (FRESH * 2 + 408_786 * 0.2 + 16_082 * 10) / 1_000_000

  it('splits inclusive Codex input into fresh, read and write portions once (BL-1383)', () => {
    // Synthetic prices exercise the existing reader; no measured CLI subscription bill.
    const model: SavedModel = {
      ...buildModel(), provider: 'openai-codex', modelId: 'codex-test', modelName: 'Codex test',
      connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex', useDeveloperPrefix: false },
      pricing: { input: 2, output: 10, cachedInput: 0.2 }
    }
    const agent: Agent = {
      ...buildAgent(), primary_model_provider: model.provider, primary_model_name: model.modelId,
      primary_model_connection: model.connection
    }
    const snapshot = buildSnapshot({
      runtime: { runtimeId: 'codex', providerId: model.provider, connectionId: 'codex-cli', modelName: model.modelId, transport: 'codex-app-server', status: 'succeeded' },
      responseSummary: {
        content: { value: 'done', confidence: 'exact' },
        toolCallsCount: { value: 0, confidence: 'exact' },
        usage: {
          inputTokens: { value: 100, confidence: 'exact' },
          cachedInputTokens: { value: 20, confidence: 'exact' },
          cacheCreationInputTokens: { value: 30, confidence: 'exact' },
          outputTokens: { value: 10, confidence: 'exact' },
          totalTokens: { value: 110, confidence: 'exact' }
        }
      }
    })
    const summary = summarizeRunningCost([snapshot], model, agent)
    expect(summary.cost).toBeCloseTo((50 * 2 + 20 * 0.2 + 30 * 2 + 10 * 10) / 1_000_000, 12)
    // A non-Claude cache-write price is not known; the existing input-price estimate stays so.
    expect(summary.state).toBe('estimated')
    expect(summary.note).toContain('cache-write price')
  })

  it('five-minute writes cost 1.25x the input price', () => {
    const summary = summarizeRunningCost([artifactBuild('5m')], sonnet5(), sonnet5Agent())

    expect(summary.state).toBe('exact')
    expect(summary.cost).toBeCloseTo(baseCost + (59_393 * 2 * 1.25) / 1_000_000, 9)
    // The live run's cost at list prices, as the BL-77 table computed it by hand.
    expect(summary.cost).toBeCloseTo(0.394, 3)
  })

  it('one-hour writes cost 2x the input price', () => {
    const summary = summarizeRunningCost([artifactBuild('1h')], sonnet5(), sonnet5Agent())

    expect(summary.state).toBe('exact')
    expect(summary.cost).toBeCloseTo(baseCost + (59_393 * 2 * 2) / 1_000_000, 9)
  })

  it('an unknown cache lifetime is priced at the lower rate and called an estimate', () => {
    const summary = summarizeRunningCost([artifactBuild(undefined)], sonnet5(), sonnet5Agent())

    expect(summary.state).toBe('estimated')
    expect(summary.cost).toBeCloseTo(baseCost + (59_393 * 2 * 1.25) / 1_000_000, 9)
    expect(summary.note).toContain('cache-write price')
  })

  it('a Claude model through OpenRouter pays the same rate', () => {
    // OpenRouter reports writes as `cache_write_tokens` inside an inclusive prompt count; the
    // live BL-77 run: 35,730 in, 22,015 read, 12,295 written, 194 out.
    const snapshot = buildSnapshot({
      responseSummary: {
        content: { value: 'done', confidence: 'exact' },
        usage: {
          inputTokens: { value: 35_730, confidence: 'exact', source: 'provider' },
          outputTokens: { value: 194, confidence: 'exact', source: 'provider' },
          totalTokens: { value: 35_924, confidence: 'exact', source: 'provider' },
          cachedInputTokens: { value: 22_015, confidence: 'exact', source: 'provider' },
          cacheCreationInputTokens: { value: 12_295, confidence: 'exact', source: 'provider' },
        },
        toolCallsCount: { value: 2, confidence: 'exact', source: 'provider' },
      },
      runtime: {
        runtimeId: 'vercel',
        providerId: 'openrouter',
        connectionId: 'openrouter',
        modelName: 'anthropic/claude-sonnet-5',
        transport: 'vercel-sdk',
        status: 'succeeded',
        metadata: { promptCachePolicy: { provider: 'openrouter', cacheTtl: '5m' } },
      },
    })
    const summary = summarizeRunningCost([snapshot], openRouterSonnet5(), openRouterAgent())

    // New find 2 (2026-09-25): the OpenRouter run's model id carries its developer prefix.
    expect(summary.state).toBe('exact')
    const fresh = 35_730 - 22_015 - 12_295
    expect(summary.cost).toBeCloseTo(
      (fresh * 2 + 22_015 * 0.2 + 12_295 * 2 * 1.25 + 194 * 10) / 1_000_000,
      9,
    )
  })

  it("prices another provider's writes at the input price and calls the total an estimate", () => {
    const model: SavedModel = {
      ...buildModel(),
      provider: 'openai',
      modelId: 'gpt-5.6-sol',
      pricing: { input: 2, output: 10, cachedInput: 0.2 },
    }
    const agent: Agent = { ...buildAgent(), primary_model_provider: 'openai', primary_model_name: 'gpt-5.6-sol' }
    const snapshot = buildSnapshot({
      responseSummary: {
        content: { value: 'done', confidence: 'exact' },
        usage: {
          inputTokens: { value: 10_000, confidence: 'exact', source: 'provider' },
          outputTokens: { value: 100, confidence: 'exact', source: 'provider' },
          totalTokens: { value: 10_100, confidence: 'exact', source: 'provider' },
          cachedInputTokens: { value: 0, confidence: 'exact', source: 'provider' },
          cacheCreationInputTokens: { value: 8_000, confidence: 'exact', source: 'provider' },
        },
        toolCallsCount: { value: 0, confidence: 'exact', source: 'provider' },
      },
      runtime: {
        runtimeId: 'vercel',
        providerId: 'openai',
        connectionId: 'openai',
        modelName: 'gpt-5.6-sol',
        transport: 'vercel-sdk',
        status: 'succeeded',
        metadata: { promptCachePolicy: { provider: 'openai', cacheTtl: null } },
      },
    })
    const summary = summarizeRunningCost([snapshot], model, agent)

    expect(summary.state).toBe('estimated')
    expect(summary.cost).toBeCloseTo((10_000 * 2 + 100 * 10) / 1_000_000, 9)
  })

  it('a run with no writes is unchanged, and a free model stays an exact zero', () => {
    expect(summarizeRunningCost([buildSnapshot()], buildModel(), buildAgent()).cost).toBeCloseTo(0.00996, 5)

    const free: SavedModel = { ...sonnet5(), pricing: { input: 0, output: 0, cachedInput: 0 } }
    const summary = summarizeRunningCost([artifactBuild(undefined)], free, sonnet5Agent())
    expect(summary.state).toBe('exact')
    expect(summary.cost).toBe(0)
  })

  it('prices a delegated API run on a Claude model at the five-minute rate', () => {
    // An API Subagent or Worker carries no request-level cache setting (the preset's Prompt cache
    // TTL is stripped from its provider options), so every point on it is the policy's own
    // five-minute one.
    const delegatedRun = (type: string) => ({
      kind: 'subagent' as const,
      name: 'Helper',
      type,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      usage: {
        inputTokens: 100_000,
        outputTokens: 1_000,
        totalTokens: 101_000,
        cachedInputTokens: 60_000,
        cacheCreationInputTokens: 30_000,
      },
      durationMs: 2_000,
      status: 'completed' as const,
      thread: 'fresh' as const,
    })
    const withRun = (type: string, runtimeId: 'vercel' | 'claude' = 'vercel') =>
      buildSnapshot({
        responseSummary: {
          content: { value: 'done', confidence: 'exact' },
          usage: {
            inputTokens: { value: 1_000, confidence: 'exact', source: 'provider' },
            outputTokens: { value: 100, confidence: 'exact', source: 'provider' },
            totalTokens: { value: 1_100, confidence: 'exact', source: 'provider' },
          },
          toolCallsCount: { value: 1, confidence: 'exact', source: 'provider' },
        },
        runtime: {
          runtimeId,
          providerId: 'anthropic',
          connectionId: 'anthropic',
          modelName: 'claude-sonnet-5',
          transport: 'vercel-sdk',
          status: 'succeeded',
        },
        delegated: {
          runs: [delegatedRun(type)],
          totals: {
            runs: 1,
            completed: 1,
            failed: 0,
            timedOut: 0,
            usageKnownRuns: 1,
            usageUnknownRuns: 0,
            usage: { inputTokens: 100_000, outputTokens: 1_000, totalTokens: 101_000 },
          },
        },
      })
    const expected = (10_000 * 2 + 60_000 * 0.2 + 30_000 * 2 * 1.25 + 1_000 * 10) / 1_000_000

    for (const type of ['api', 'worker', 'worker of researcher']) {
      const summary = summarizeRunningCost([withRun(type)], sonnet5(), sonnet5Agent(), [sonnet5()])
      expect(summary.delegatedCost, type).toBeCloseTo(expected, 9)
      expect(summary.state, type).toBe('exact')
    }

    // A CLI run's lifetime is the CLI's own: same floor, but an estimate.
    const cli = summarizeRunningCost([withRun('cli')], sonnet5(), sonnet5Agent(), [sonnet5()])
    expect(cli.delegatedCost).toBeCloseTo(expected, 9)
    expect(cli.state).toBe('estimated')
  })
})

describe('The running cost is exact when the run is the active preset (new find 2, 2026-09-25)', () => {
  // A run records the request connection's ID (`direct:anthropic`, `openrouter`, `claude-cli`)
  // and the model id it sent (`anthropic/claude-sonnet-5` on OpenRouter). Comparing those with
  // the preset's service name (`anthropic`) or its bare model id marked every direct and every
  // OpenRouter run "estimated".
  it('a direct run with the real connection id is exact', () => {
    const summary = summarizeRunningCost([buildSnapshot()], buildModel(), buildAgent())
    expect(summary.state).toBe('exact')
    expect(summary.cost).toBeCloseTo(0.00996, 5)
  })

  it('a preset with no stored connection (derived from its provider) matches too', () => {
    const model: SavedModel = { ...buildModel() }
    delete model.connection
    expect(summarizeRunningCost([buildSnapshot()], model, buildAgent()).state).toBe('exact')
  })

  it('an OpenRouter run whose model id carries the developer prefix is exact', () => {
    const model: SavedModel = {
      ...buildModel(),
      id: 'or-model',
      modelId: 'anthropic/claude-sonnet-4',
      effectiveModelId: 'anthropic/claude-sonnet-4',
      connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter', useDeveloperPrefix: true },
    }
    const snapshot = buildSnapshot({
      runtime: {
        runtimeId: 'vercel',
        providerId: 'openrouter',
        connectionId: 'openrouter',
        modelName: 'anthropic/claude-sonnet-4',
        transport: 'vercel-sdk',
        status: 'succeeded',
      },
    })
    for (const primaryModelName of ['anthropic/claude-sonnet-4', 'claude-sonnet-4']) {
      const agent: Agent = {
        ...buildAgent(),
        primary_model_name: primaryModelName,
        primary_model_preset_id: 'or-model',
        primary_model_connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter' },
      }
      expect(summarizeRunningCost([snapshot], model, agent).state, primaryModelName).toBe('exact')
    }

    // A preset that stores the bare id and lets the connection add the developer prefix when it
    // sends (`useDeveloperPrefix`), which is what the run records.
    const bare: SavedModel = { ...model, modelId: 'claude-sonnet-4' }
    delete bare.effectiveModelId
    const bareAgent: Agent = {
      ...buildAgent(),
      primary_model_name: 'claude-sonnet-4',
      primary_model_preset_id: 'or-model',
      primary_model_connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter', useDeveloperPrefix: true },
    }
    expect(summarizeRunningCost([snapshot], bare, bareAgent).state).toBe('exact')
  })

  it('a run on another connection or another model is still an estimate', () => {
    const otherConnection = buildSnapshot({
      runtime: {
        runtimeId: 'vercel',
        providerId: 'openrouter',
        connectionId: 'openrouter',
        modelName: 'anthropic/claude-sonnet-4',
        transport: 'vercel-sdk',
        status: 'succeeded',
      },
    })
    const otherModel = buildSnapshot({
      runtime: {
        runtimeId: 'vercel',
        providerId: 'anthropic',
        connectionId: 'direct:anthropic',
        modelName: 'claude-opus-5',
        transport: 'vercel-sdk',
        status: 'succeeded',
      },
    })
    expect(summarizeRunningCost([otherConnection], buildModel(), buildAgent()).state).toBe('estimated')
    expect(summarizeRunningCost([otherModel], buildModel(), buildAgent()).state).toBe('estimated')
  })
})

describe('A delegated run whose model has no cached-input price is an estimate (new find 3, 2026-09-25)', () => {
  it('prices its cache reads at the input price and says so', () => {
    const noCachedPrice: SavedModel = {
      ...buildModel(),
      id: 'delegated-model',
      provider: 'openai',
      modelId: 'gpt-5.4',
      modelName: 'GPT-5.4',
      pricing: { input: 2, output: 10 },
    }
    const snapshot = buildSnapshot({
      delegated: {
        runs: [
          {
            kind: 'subagent',
            name: 'API Helper',
            type: 'api',
            model: 'gpt-5.4',
            provider: 'openai',
            usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedInputTokens: 200 },
            durationMs: 2000,
            status: 'completed',
            thread: 'fresh',
          },
        ],
        totals: {
          runs: 1,
          completed: 1,
          failed: 0,
          timedOut: 0,
          usageKnownRuns: 1,
          usageUnknownRuns: 0,
          usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        },
      },
    })
    const summary = summarizeRunningCost([snapshot], buildModel(), buildAgent(), [buildModel(), noCachedPrice])

    expect(summary.delegatedCost).toBeCloseTo((1000 * 2 + 500 * 10) / 1_000_000, 9)
    expect(summary.state).toBe('estimated')
  })
})

describe('A parent run with no usage makes the running cost unknown, never exact (review finding, 2026-09-25)', () => {
  const noUsage = (id: string, usage: any) =>
    buildSnapshot({
      id,
      responseSummary: usage === null
        ? undefined
        : {
            content: { value: '', confidence: 'exact' },
            usage,
            toolCallsCount: { value: 0, confidence: 'exact', source: 'test' }
          },
      llmSummary: undefined
    } as any)

  it('a run with no usage beside runs that have it: their sum, called an estimate', () => {
    const summary = summarizeRunningCost(
      [buildSnapshot(), noUsage('snap-stopped', null)],
      buildModel(),
      buildAgent()
    )
    expect(summary.cost).toBeCloseTo(0.00996, 5)
    expect(summary.state).toBe('estimated')
  })

  it('a run whose input or output count is missing: the same', () => {
    const partial = noUsage('snap-partial', {
      inputTokens: { value: null, confidence: 'exact', source: 'provider' },
      outputTokens: { value: 50, confidence: 'exact', source: 'provider' },
      totalTokens: { value: null, confidence: 'exact', source: 'provider' }
    })
    const summary = summarizeRunningCost([buildSnapshot(), partial], buildModel(), buildAgent())
    expect(summary.cost).toBeCloseTo(0.00996, 5)
    expect(summary.state).toBe('estimated')
  })

  it('runs that all lack usage: unknown, not an exact $0.00', () => {
    const summary = summarizeRunningCost([noUsage('snap-stopped', null)], buildModel(), buildAgent())
    expect(summary.state).toBe('unknown')
    expect(summary.cost).toBeNull()
  })

  it('BL-1361 observed portions never become a running-cost fallback, even with reported zeros', () => {
    for (const counts of [{ inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheCreationInputTokens: 30 }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }]) {
      const unknown = { value: null, confidence: 'estimated', source: 'codex' }
      const failed = noUsage('snap-observed', { inputTokens: unknown, outputTokens: unknown, totalTokens: unknown })
      failed.responseSummary!.observedUsage = { completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts }] }
      const alone = summarizeRunningCost([failed], buildModel(), buildAgent())
      expect(alone.cost).toBeNull()
      expect(alone.state).toBe('unknown')
      const withKnown = summarizeRunningCost([buildSnapshot(), failed], buildModel(), buildAgent())
      expect(withKnown.cost).toBeCloseTo(0.00996, 5)
      expect(withKnown.state).toBe('estimated')
    }
  })

  it('no runs at all is still an exact zero', () => {
    const summary = summarizeRunningCost([], buildModel(), buildAgent())
    expect(summary.state).toBe('exact')
    expect(summary.cost).toBe(0)
  })

  it('a free model with cache reads and no cached price stays an exact zero, like its writes', () => {
    const free: SavedModel = { ...buildModel(), pricing: { input: 0, output: 0 } }
    const summary = summarizeRunningCost([buildSnapshot()], free, buildAgent())
    expect(summary.state).toBe('exact')
    expect(summary.cost).toBe(0)
  })
})

/**
 * BL-707: manual trim protection (the server's trim preview, context preview, and memory
 * graduation, and the chat page) reads the zip and clip ids a message references. Its patterns'
 * description part searched to the first `}` again from every opener, seconds of the one Node
 * process for a message of openers that never close. One scan each now, with the same rules; the
 * old patterns are kept here only as oracles.
 */
describe('manual trim protection reads references once (BL-707)', () => {
  const OLD_PATTERNS = {
    zip: /\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/g,
    clip: /\{\{batshit-clip:([^:}]+)(?::::[^}]*)?\}\}/g
  }
  const oldReferenceIds = (content: string, type: 'zip' | 'clip') => {
    const ids = new Set<string>()
    for (const match of content.matchAll(OLD_PATTERNS[type])) {
      const id = match[1]?.trim()
      if (id) ids.add(id)
    }
    return ids
  }
  const protectsZip = (content: string, id: string) =>
    isMessageProtectedFromManualTrim(buildMessage('m', content), { protectedUnzippedZipIds: [id] })
  const protectsClip = (content: string, id: string) =>
    isMessageProtectedFromManualTrim(buildMessage('m', content), { activeClipIds: [id] })

  it('protects a message for exactly the zip and clip ids the old patterns read', () => {
    const texts = [...REFERENCE_SCAN_HAND_CASES, ...generateReferenceScanTexts(3_000, 3_707)]
    const counts = { zipProtected: 0, zipNot: 0, clipProtected: 0, clipNot: 0 }
    for (const text of texts) {
      const label = JSON.stringify(text)
      const zipIds = oldReferenceIds(text, 'zip')
      const clipIds = oldReferenceIds(text, 'clip')
      for (const id of [...idRunsAfter(text, '{{batshit-zip:'), 'zip_absent']) {
        const expected = zipIds.has(id.trim())
        expect(protectsZip(text, id), `${label} zip ${JSON.stringify(id)}`).toBe(expected)
        counts[expected ? 'zipProtected' : 'zipNot']++
      }
      for (const id of [...idRunsAfter(text, '{{batshit-clip:'), 'clip_absent']) {
        const expected = clipIds.has(id.trim())
        expect(protectsClip(text, id), `${label} clip ${JSON.stringify(id)}`).toBe(expected)
        counts[expected ? 'clipProtected' : 'clipNot']++
      }
    }
    for (const [kind, count] of Object.entries(counts)) {
      expect(count, kind).toBeGreaterThan(1_000)
    }
  })

  it('reads a 1 MB message of 20,000 unclosed openers in well under 200 ms', () => {
    const shapes = [
      ...Object.entries(unclosedReferenceReplies('zip')).map(([shape, text]) => ({
        shape,
        protect: () => protectsZip(text, 'zip_1')
      })),
      ...Object.entries(unclosedReferenceReplies('clip')).map(([shape, text]) => ({
        shape,
        protect: () => protectsClip(text, 'clip_1')
      }))
    ]
    for (const { shape, protect } of shapes) {
      const started = performance.now()
      expect(protect(), shape).toBe(false)
      expect(performance.now() - started, shape).toBeLessThan(200)
    }
  })
})
