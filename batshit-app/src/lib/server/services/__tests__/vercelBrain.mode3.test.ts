/**
 * Test Suite for Story 5.7 - Vercel Brain Mode 3
 * Tests the clean Mode 3 implementation without Ghost infrastructure
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VercelAIBrain } from '../vercelBrain'
import type { NativeModeRequest } from '../vercelBrain'
import { compileManagedSubagentSystemPrompt } from '../subagentRunner'
import {
  convertToModelMessages,
  extractReasoningMiddleware,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel,
} from 'ai'
import { redis } from '$lib/server/redis'

const providerMocks = vi.hoisted(() => ({
  providerManagerFactory: () => ({
    getModel: vi.fn().mockReturnValue({
      specificationVersion: 'v4',
      provider: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    }),
    listAvailableModels: vi.fn().mockReturnValue([
      { id: 'anthropic/claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' }
    ])
  })
}))

const slashCommandCapabilityMocks = vi.hoisted(() => ({
  getEnabledAgentSlashCapabilities: vi.fn().mockResolvedValue([]),
  buildSkillsCommandsDcmLines: vi.fn().mockReturnValue([
    'skills_commands:',
    '- (none enabled for this agent)',
    'skills_commands_usage:',
    '- Prompt commands expand reusable instruction templates.'
  ])
}))

// Mock the providers module
vi.mock('$lib/server/services/providers', () => {
  const ProviderManager = vi
    .fn(function MockProviderManager(this: Record<string, unknown>) {
      Object.assign(this, providerMocks.providerManagerFactory())
    })
  ;(ProviderManager as any).createForUser = vi
    .fn()
    .mockImplementation(async () => providerMocks.providerManagerFactory())

  return {
    ProviderManager,
    resolveProviderAccess: vi.fn().mockResolvedValue({
      apiKeys: {
        openai: 'test-openai-key'
      }
    })
  }
})

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: (...args: any[]) =>
    slashCommandCapabilityMocks.getEnabledAgentSlashCapabilities(...args),
  buildSkillsCommandsDcmLines: (...args: any[]) =>
    slashCommandCapabilityMocks.buildSkillsCommandsDcmLines(...args)
}))

// Mock the AI SDK
// Mock workflow tools
vi.mock('../workflowTools', () => ({
  loadWorkflowTools: vi.fn().mockResolvedValue({
    'analyze_data': {
      description: 'Analyze data workflow',
      inputSchema: {},
      execute: vi.fn().mockResolvedValue({ result: 'analyzed' })
    }
  }),
  callWorkflow: vi.fn().mockResolvedValue({ success: true })
}))

// Mock environment
vi.mock('$env/dynamic/private', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key',
    N8N_WEBHOOK_URL: 'http://localhost:5678/webhook'
  }
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    getUserSettings: vi.fn().mockResolvedValue(null)
  }
}))

describe('VercelBrain Mode 3 - Story 5.7', () => {
  let brain: VercelAIBrain

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(convertToModelMessages).mockImplementation((messages) => messages)
    vi.mocked(tool).mockImplementation((config) => config)
    vi.mocked(stepCountIs).mockImplementation((count: number) => ({ type: 'stepCount', count }))
    vi.mocked(streamText).mockImplementation(async () => {
      const textChunks = ['Hello', ' from', ' Mode', ' 3!']

      const iterator = async function* () {
        for (const chunk of textChunks) {
          yield { type: 'text-delta', text: chunk }
        }

        yield {
          type: 'tool-result',
          toolName: 'test_tool',
          input: { test: 'input' },
          output: { success: true }
        }
      }

      const streamIterable = {
        [Symbol.asyncIterator]: iterator
      }

      return {
        stream: streamIterable,
        fullStream: streamIterable,
        steps: Promise.resolve([]),
        usage: Promise.resolve({
          inputTokens: 765,
          outputTokens: 50,
          totalTokens: 815
        })
      }
    })

    brain = new VercelAIBrain()
  })

  describe('Subagent prompt compilation', () => {
    it('includes subagent-enabled Skills & Prompts guidance when commands are assigned', async () => {
      vi.mocked(redis.get).mockResolvedValueOnce('# Base subagent prompt' as any)
      slashCommandCapabilityMocks.getEnabledAgentSlashCapabilities.mockResolvedValueOnce([
        {
          id: 'artifact-skill',
          name: 'artifact-skill',
          displayName: 'Artifact Skill',
          type: 'skill',
          invocation: '/artifact-creator',
          description: 'Build artifacts',
          isSystem: false,
          skillId: 'artifact_creator'
        }
      ])
      slashCommandCapabilityMocks.buildSkillsCommandsDcmLines.mockReturnValueOnce([
        'skills_commands:',
        '- /artifact-creator | skill | skillId=artifact_creator — Build artifacts',
        'skills_commands_usage:',
        '- Skill commands load context-heavy skills with reference documentation.'
      ])

      const compiled = await compileManagedSubagentSystemPrompt(
        {
          id: 'subagent-1',
          displayName: 'Builder SA',
          include_global_prompt: false,
          system_prompt: 'Custom subagent prompt'
        },
        'user-1'
      )

      expect(slashCommandCapabilityMocks.getEnabledAgentSlashCapabilities).toHaveBeenCalledWith(
        'user-1',
        'subagent-1'
      )
      expect(compiled.systemPrompt).toContain('==== SKILLS & PROMPTS (AGENT ACCESS) ====')
      expect(compiled.systemPrompt).toContain(
        '- /artifact-creator | skill | skillId=artifact_creator — Build artifacts'
      )
      expect(compiled.systemPrompt).toContain('==== SUBAGENT RUNTIME CONTEXT ====')
      expect(compiled.systemPrompt).toContain('type: n8n-subnode (n8n Subnode Subagent)')
    })
  })

  describe('AC1: Clean streaming with Vercel AI SDK', () => {
    it('5.7-UNIT-001: Verify processNativeMode() method exists', () => {
      expect(brain.processNativeMode).toBeDefined()
      expect(typeof brain.processNativeMode).toBe('function')
    })

    it('5.7-UNIT-002: Test stream initialization with valid model', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Hello Mode 3!' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      expect(response).toBeDefined()
      expect(response.content).toBe('Hello from Mode 3!')
      expect(response.modelUsed).toBe('claude-3-5-sonnet')
    })

    it('5.7-INT-001: Test streaming without Ghost infrastructure', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Test streaming' }
        ],
        model: 'gpt-4.1',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      // Verify no Ghost references
      expect(response.metadata?.mode).toBe('native')
      expect(response.content).not.toContain('Ghost')
      expect(response.content).toBe('Hello from Mode 3!')
    })

  })

  describe('AC2: Workflows callable as tools', () => {
    it('5.7-UNIT-003: Test workflow tools integration', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Analyze this data' }
        ],
        model: 'claude-3-5-sonnet',
        availableWorkflows: ['analyze-data'],
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      expect(response).toBeDefined()
      expect(response.intermediateSteps).toBeDefined()
      expect(response.intermediateSteps?.[0]?.toolName).toBe('test_tool')
    })

    it('5.7-UNIT-004: Test multiple workflows as tools', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Process data and generate report' }
        ],
        model: 'claude-3-5-sonnet',
        availableWorkflows: ['analyze-data', 'generate-report'],
        sessionId: 'test-session',
        messageId: 'test-message',
        maxToolRounds: 5
      }

      const response = await brain.processNativeMode(request)

      expect(response).toBeDefined()
      expect(response.metadata?.mode).toBe('native')
    })
  })

  describe('AC3: Messages use existing compileForAI()', () => {
    it('5.7-UNIT-005: Test message format compatibility', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello with {{batshit-zip:123:::content}}' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      expect(response).toBeDefined()
      // Messages passed through without modification
      expect(response.content).toBe('Hello from Mode 3!')
    })

    it('5.7-UNIT-006: keeps multimodal images as structured inputs', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Describe this image' }
        ],
        images: [
          { url: 'https://example.com/image.jpg', alt: 'Test image' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      expect(response).toBeDefined()
      expect(response.usage?.promptTokens).toBe(765) // Efficient!
      expect(response.usage?.imageTokens).toBe(765)
    })

    it('5.7-UNIT-006b: keeps no-tunnel clip image handling on structured image inputs', async () => {
      vi.mocked(redis.getUserSettings).mockResolvedValue({
        ui_settings: {
          upload_settings: {
            tunnel_provider: 'none',
            tunnel_url: ''
          }
        }
      } as any)

      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Describe this image' }
        ],
        images: [
          { url: 'https://example.com/image.jpg', alt: 'Test image' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message',
        userId: 'test-user'
      }

      await brain.processNativeMode(request)

      expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1)
      const callArgs = vi.mocked(streamText).mock.calls[0]?.[0] as any
      expect(callArgs.experimental_download).toBeUndefined()
    })

    it('5.7-UNIT-006c: Ignores clip placeholders when clip state is inactive', async () => {
      vi.mocked(redis.get).mockImplementation(async (key: string) => {
        if (key === 'session:test-session:clip_state') {
          return {
            clips: [
              { clipId: 'clip123', temporarilyUnclipped: true }
            ]
          }
        }
        return null
      })

      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'See this {{batshit-clip:clip123:::file.png}}' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message',
        userId: 'test-user'
      }

      await brain.processNativeMode(request)

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      const userMessage = callArgs.messages[0]
      expect(typeof userMessage.content).toBe('string')
      expect(userMessage.content).toBe('See this ')
    })
  })

  describe('AC4: Cool Tools natural rendering', () => {
    it('5.7-UNIT-007: Test Cool Tools data in stream', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Use a tool' }
        ],
        model: 'claude-3-5-sonnet',
        availableTools: [{
          name: 'test_tool',
          description: 'A test tool',
          schema: { properties: { input: { type: 'string' } } }
        }],
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      expect(response.intermediateSteps).toBeDefined()
      expect(response.intermediateSteps?.length).toBeGreaterThan(0)
      expect(response.intermediateSteps?.[0]?.toolName).toBe('test_tool')
      expect(response.intermediateSteps?.[0]?.toolOutput).toEqual({ success: true })
    })
  })

  describe('AC6: Multi-round tool execution', () => {
    it('5.7-UNIT-011: Test maxSteps configuration', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Multi-step task' }
        ],
        model: 'claude-3-5-sonnet',
        maxToolRounds: 10,
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      expect(response).toBeDefined()
      // maxSteps should be respected
    })
  })

  describe('AC7: No duplicate content', () => {
    it('5.7-UNIT-012: Verify no deduplication logic', async () => {
      // Check that the old deduplication code is gone
      const codeString = brain.constructor.toString()
      expect(codeString).not.toContain('previousStreamContent')
      expect(codeString).not.toContain('isFinal')
      expect(codeString).not.toContain('deduplication')
    })

    it('5.7-INT-013: Test clean streaming', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Test clean stream' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      expect(response.content).toBe('Hello from Mode 3!')
      // No duplicates - content is clean
      expect(response.content).not.toMatch(/(.+)\1{2,}/) // No repeated patterns
    })
  })

  describe('AC9: Redis message format', () => {
    it('5.7-UNIT-015: Test message format for storage', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Store this message' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const response = await brain.processNativeMode(request)

      // Verify standard format
      expect(response).toHaveProperty('content')
      expect(response).toHaveProperty('modelUsed')
      expect(response).toHaveProperty('usage')
      expect(response).toHaveProperty('metadata')

      // Ready for Redis storage (no stringify needed!)
      expect(typeof response).toBe('object')
    })
  })

  describe('AC10: Performance', () => {
    it('5.7-INT-016: Measure streaming overhead', async () => {
      const startTime = Date.now()

      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Performance test' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      await brain.processNativeMode(request)

      const latency = Date.now() - startTime

      // Should be fast (mock implementation)
      expect(latency).toBeLessThan(100) // <100ms for mock
    })
  })

  describe('Error Handling', () => {
    it('5.7-UNIT-018: Test missing API key handling', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Test' }
        ],
        model: 'invalid-model',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      // Should handle gracefully
      const response = await brain.processNativeMode(request)
      expect(response).toBeDefined()
    })
  })

  describe('Stream Method', () => {
    it('Should have streamNativeMode method', () => {
      expect(brain.streamNativeMode).toBeDefined()
      expect(typeof brain.streamNativeMode).toBe('function')
    })

    it('Should return StreamTextResult-like object', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'user', content: 'Stream test' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message'
      }

      const stream = await brain.streamNativeMode(request)
      expect(stream).toBeDefined()
      expect(typeof stream.stream?.[Symbol.asyncIterator]).toBe('function')
      expect(typeof stream.fullStream?.[Symbol.asyncIterator]).toBe('function')
    })

    it('wraps model-facing tool output with a reserved zipId notice', async () => {
      const reserveToolZipId = vi.fn().mockReturnValue('cool_tool_1781000000000_abcde')
      const request: NativeModeRequest = {
        messages: [{ role: 'user', content: 'Use a workflow tool' }],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message',
        availableWorkflows: ['analyze_data'],
        reserveToolZipId
      }

      await brain.streamNativeMode(request)

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      const analyzeTool = callArgs.tools?.analyze_data
      expect(analyzeTool).toBeTruthy()

      await analyzeTool.execute({ rows: [1, 2, 3] }, { toolCallId: 'call_workflow_1' })
      const modelOutput = await analyzeTool.toModelOutput({
        toolCallId: 'call_workflow_1',
        input: { rows: [1, 2, 3] },
        output: { result: 'analyzed' }
      })

      expect(reserveToolZipId).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'call_workflow_1',
          toolName: 'analyze_data'
        })
      )
      expect(String(modelOutput.value)).toContain('zipId: cool_tool_1781000000000_abcde')
      expect(String(modelOutput.value)).toContain('Use this exact zipId')
      expect(String(modelOutput.value)).not.toContain('call_workflow_1')
      expect(String(modelOutput.value)).not.toContain('toolCallId')
    })

    it('wraps broker tool output with a reserved zipId notice', async () => {
      const reserveToolZipId = vi.fn().mockReturnValue('cool_tool_1781000000000_brok1')
      const request: NativeModeRequest = {
        userId: 'josh',
        messages: [{ role: 'user', content: 'Use Dynamic Tool Search' }],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message',
        selectedGateways: ['gw-test'],
        providerSettings: {
          nativeTools: {
            dynamicMcpEnabled: true,
            cliToolsEnabled: false,
            artifactRuntimeEnabled: false,
            batshitToolsEnabled: false,
            webSearchEnabled: false,
            bashEnabled: false
          }
        },
        reserveToolZipId
      }

      await brain.streamNativeMode(request)

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      const brokerTool = callArgs.tools?.native_batshit_tool_use
      expect(brokerTool).toBeTruthy()

      const modelOutput = await brokerTool.toModelOutput({
        toolCallId: 'call_broker_1',
        input: {
          ref: 'mcp:sample_tool',
          input: {
            query: 'hello'
          }
        },
        output: {
          success: true,
          ref: 'mcp:sample_tool',
          family: 'mcp',
          target: 'sample_tool',
          result: {
            ok: true
          }
        }
      })

      expect(reserveToolZipId).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'call_broker_1',
          toolName: 'native_batshit_tool_use',
          input: {
            ref: 'mcp:sample_tool',
            input: {
              query: 'hello'
            }
          }
        })
      )
      expect(String(modelOutput.value)).toContain('batshit_tool_use succeeded: mcp:sample_tool')
      expect(String(modelOutput.value)).toContain('zipId: cool_tool_1781000000000_brok1')
      expect(String(modelOutput.value)).toContain('Use this exact zipId')
      expect(String(modelOutput.value)).not.toContain('call_broker_1')
      expect(String(modelOutput.value)).not.toContain('toolCallId')
    })

    it('Should forward providerOptions and tuning settings to streamText()', async () => {
      const providerOptions = {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: 256
          }
        }
      }

      const request: NativeModeRequest = {
        messages: [
          { role: 'system', content: 'Stable Anthropic system prompt' },
          { role: 'user', content: 'Stream with options' }
        ],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message',
        topP: 0.9,
        topK: 10,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 42,
        stopSequences: ['END'],
        providerOptions
      }

      await brain.streamNativeMode(request)

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          topP: 0.9,
          topK: 10,
          presencePenalty: 0.1,
          frequencyPenalty: 0.2,
          seed: 42,
          stopSequences: ['END'],
          providerOptions,
          include: { rawChunks: true, requestBody: true }
        })
      )
      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      expect(
        callArgs.messages[0]?.providerOptions?.anthropic?.cacheControl,
      ).toEqual({
        type: 'ephemeral'
      })
    })

    it('wraps think-tag reasoning models before streaming', async () => {
      const request: NativeModeRequest = {
        messages: [{ role: 'user', content: 'Reason through this' }],
        model: 'mimo-v2.5-pro',
        sessionId: 'test-session',
        messageId: 'test-message',
        taggedReasoningTagName: 'think'
      }

      await brain.streamNativeMode(request)

      expect(extractReasoningMiddleware).toHaveBeenCalledWith({
        tagName: 'think'
      })
      expect(wrapLanguageModel).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.objectContaining({
            modelId: 'claude-3-5-sonnet'
          }),
          middleware: expect.objectContaining({
            type: 'extract-reasoning-middleware',
            tagName: 'think'
          })
        })
      )

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      expect(callArgs.model).toEqual(
        expect.objectContaining({
          type: 'wrapped-language-model',
          middleware: expect.objectContaining({ tagName: 'think' })
        })
      )
    })

    it('forwards final SDK reasoning to the route onFinish callback', async () => {
      const onFinish = vi.fn()
      const request: NativeModeRequest = {
        messages: [{ role: 'user', content: 'Reason through this' }],
        model: 'claude-3-5-sonnet',
        sessionId: 'test-session',
        messageId: 'test-message',
        onFinish
      }

      await brain.streamNativeMode(request)

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      await callArgs.onEnd({
        text: 'Done',
        steps: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finalStep: {
          reasoning: [{ type: 'reasoning', text: 'Checked the options.' }]
        }
      })

      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoning: ['Checked the options.']
        })
      )
    })

    it('omits unsupported sampling controls for direct OpenAI reasoning models', async () => {
      const request: NativeModeRequest = {
        messages: [{ role: 'user', content: 'Stream with GPT-5.5' }],
        model: 'gpt-5.5',
        sessionId: 'test-session',
        messageId: 'test-message',
        userId: 'test-user',
        connection: {
          id: 'openai',
          type: 'direct',
          service: 'openai',
          label: 'OpenAI'
        } as any,
        providerSettings: {
          openaiImageGenerationTool: false
        },
        temperature: 0.7,
        maxTokens: 128000,
        topP: 0.9,
        topK: 10,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 42,
        stopSequences: ['END']
      }

      await brain.streamNativeMode(request)

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      expect(callArgs.maxOutputTokens).toBe(128000)
      expect(callArgs.temperature).toBeUndefined()
      expect(callArgs.topP).toBeUndefined()
      expect(callArgs.topK).toBeUndefined()
      expect(callArgs.presencePenalty).toBeUndefined()
      expect(callArgs.frequencyPenalty).toBeUndefined()
      expect(callArgs.seed).toBeUndefined()
      expect(callArgs.stopSequences).toBeUndefined()
      expect(callArgs.providerOptions?.openai?.promptCacheKey).toMatch(
        /^bs-pc-v1-/,
      )
      expect(callArgs.providerOptions?.openai?.promptCacheKey).not.toContain(
        'Stream with GPT-5.5',
      )
    })

    it('preserves direct Gemini message order with stable system content first', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'system', content: 'Stable Batshit API system prompt' },
          { role: 'user', content: 'Volatile current Gemini user turn' }
        ],
        model: 'gemini-2.5-flash',
        sessionId: 'test-session',
        messageId: 'test-message',
        userId: 'test-user',
        connection: {
          id: 'direct:google',
          type: 'direct',
          service: 'google',
          label: 'Google'
        } as any
      }

      await brain.streamNativeMode(request)

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any
      expect(callArgs.messages[0]?.role).toBe('system')
      expect(callArgs.messages[0]?.content).toContain(
        'Stable Batshit API system prompt'
      )
      expect(callArgs.messages.at(-1)?.role).toBe('user')
      expect(callArgs.messages.at(-1)?.content).toContain(
        'Volatile current Gemini user turn'
      )
      expect(callArgs.providerOptions).toBeUndefined()
    })

    it('applies Vercel AI Gateway automatic caching provider option', async () => {
      const request: NativeModeRequest = {
        messages: [{ role: 'user', content: 'Use gateway caching' }],
        model: 'openai/gpt-5.5',
        sessionId: 'test-session',
        messageId: 'test-message',
        userId: 'test-user',
        connection: {
          id: 'vercel-gateway',
          type: 'vercel-gateway'
        } as any
      }

      const stream = await brain.streamNativeMode(request)
      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any

      expect(callArgs.providerOptions?.gateway?.caching).toBe('auto')
      expect((stream as any).__runtimeInfo.promptCachePolicy.applied).toContain(
        'gateway.caching',
      )
      expect(
        (stream as any).__runtimeInfo.metadata.promptCachePolicy.applied,
      ).toContain('gateway.caching')
    })

    it('applies OpenRouter session stickiness provider option', async () => {
      const request: NativeModeRequest = {
        messages: [
          { role: 'system', content: 'Stable OpenRouter system prompt' },
          { role: 'user', content: 'Use OpenRouter caching' }
        ],
        model: 'anthropic/claude-sonnet-4-5',
        sessionId: 'test-session',
        messageId: 'test-message',
        userId: 'test-user',
        agentId: 'agent-1',
        connection: {
          id: 'openrouter',
          type: 'openrouter'
        } as any
      }

      await brain.streamNativeMode(request)
      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any

      expect(callArgs.providerOptions?.openrouter?.session_id).toMatch(
        /^bs-or-v1-/,
      )
      expect(callArgs.providerOptions?.openrouter?.usage).toEqual({
        include: true
      })
      expect(
        callArgs.messages[0]?.providerOptions?.openrouter?.cacheControl,
      ).toEqual({
        type: 'ephemeral'
      })
      expect(callArgs.providerOptions?.openrouter?.cache_control).toBeUndefined()
    })
  })
})
