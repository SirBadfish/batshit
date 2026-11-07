import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-139 R5 (D14, narrow refusal): the CLI Subagent type is retired. A stored `cli` Subagent (the
 * Claude Code CLI, or the Codex CLI that R1 removed), a `base` Worker clone of one, and a typeless
 * legacy record that names either CLI lane never run: `executeManagedSubagent` throws the readable
 * `RetiredSubagentError` before the run registers, takes its lock, opens its thread, resolves its
 * scope or reaches a model. The CLI lane this file used to drive (`runCliSubagent`, the managed
 * Claude bridge, its profile writes and CLI process) is gone; the BL-287 run-registration cases
 * it proved with a CLI vehicle are in `subagentRunner.threads.test.ts`, on an API Subagent.
 */

const runnerMocks = vi.hoisted(() => ({
  processNativeMode: vi.fn(),
  prepareApiToolset: vi.fn(),
  redisGetUserSettings: vi.fn(),
  resolveManagedSubagentScope: vi.fn(),
  prepareManagedSubagentDynamicInfo: vi.fn(),
  redisStore: { current: null as any },
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: vi.fn(function MockBrain(this: Record<string, unknown>) {
    Object.assign(this, { processNativeMode: runnerMocks.processNativeMode, prepareApiToolset: runnerMocks.prepareApiToolset })
  }),
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn().mockResolvedValue(null) },
}))

vi.mock('$lib/server/redis', () => ({
  redis: new Proxy({} as Record<string, any>, {
    get(_target, prop: string) {
      if (prop === 'getUserSettings') {
        return (...args: any[]) => runnerMocks.redisGetUserSettings(...args)
      }
      return runnerMocks.redisStore.current.redis[prop]
    },
  }),
}))

vi.mock('$lib/server/services/subagentRuntimeScope', () => ({
  resolveManagedSubagentScope: (...args: any[]) => runnerMocks.resolveManagedSubagentScope(...args),
  prepareManagedSubagentDynamicInfo: (...args: any[]) => runnerMocks.prepareManagedSubagentDynamicInfo(...args),
  appendManagedSubagentDynamicInfo: (systemPrompt: string, dynamicInfo: string) =>
    dynamicInfo ? `${systemPrompt}\n\n${dynamicInfo}` : systemPrompt,
}))

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: vi.fn().mockResolvedValue([]),
  buildSkillsCommandsDcmLines: vi.fn(() => []),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import { buildSubagentRunLockKey, buildSubagentThreadKey } from '../subagentThreads'
import { hasRunningSubagentRun } from '../subagentRunRegistry'
import * as subagentRunRegistry from '../subagentRunRegistry'
import * as subagentThreads from '../subagentThreads'
import { executeManagedSubagent, isRetiredSubagentError, RetiredSubagentError } from '../subagentRunner'
import { SUBAGENT_TYPE_RETIRED_CODE } from '$lib/utils/subagentType'

const subagentRedis = createSubagentRedisMock()
runnerMocks.redisStore.current = subagentRedis

const CLAUDE_CODE_CLI_REFUSAL =
  'Claude Code CLI Subagents were removed from Batshit. Retired Helper ran on the Claude Code CLI lane, which Batshit ' +
  'no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.'
const CODEX_CLI_REFUSAL =
  'Codex CLI Subagents were removed from Batshit. Retired Helper ran on Codex CLI, which Batshit no longer supports, so it ' +
  'can only be deleted. For ChatGPT models, create a new Subagent with the ChatGPT plan connection or an OpenAI API key.'

function retiredHelper(fields: Record<string, unknown>) {
  return { id: 'retired-helper', user_id: 'user-1', displayName: 'Retired Helper', ...fields }
}

function apiHelper() {
  return {
    id: 'api-helper',
    user_id: 'user-1',
    displayName: 'API Helper',
    subagentType: 'api' as const,
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-5.4',
    primary_model_preset_id: 'preset-gpt-54',
    primary_model_connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
  }
}

/** The run as the parent's tool call starts it; its stored record is there, as a real Subagent's is. */
function run(subagent: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  if (overrides.delegationKind !== 'worker') subagentRedis.seed(`subagent:${subagent.id}`, subagent)
  return executeManagedSubagent({
    userId: 'user-1',
    sessionId: 'session-1',
    chatInput: 'Inspect.',
    parentAgentId: 'agent-1',
    parentModelId: 'gpt-5.4',
    subagent,
    ...overrides,
  } as any)
}

describe('executeManagedSubagent refuses a retired CLI Subagent (SA-139 R5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    subagentRedis.clear()
    subagentRedis.seed('batshit:sub_system_prompt', '# Base subagent prompt')
    subagentRedis.seed('batshit:worker_prompt', '# Base WORKER prompt')
    subagentRedis.seed('agent:agent-1', { id: 'agent-1', user_id: 'user-1' })
    subagentRedis.seed('model:preset-gpt-54', {
      id: 'preset-gpt-54', provider: 'openai', modelId: 'gpt-5.4',
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
    })
    runnerMocks.redisGetUserSettings.mockResolvedValue(null)
    runnerMocks.prepareManagedSubagentDynamicInfo.mockResolvedValue(() => '')
    runnerMocks.resolveManagedSubagentScope.mockResolvedValue({
      subagentType: 'api', nativeToolSettings: {}, defaultMcpGateways: [], resolvedGateways: [],
      defaultCliToolIds: [], resolvedCliToolIds: [], defaultMcpToolSelections: [],
      dcmDisplaySettings: { version: 1, groups: {}, tools: {} }, projectPath: null,
    })
    runnerMocks.prepareApiToolset.mockImplementation(async (request: any) => {
      const { captureApiUtilities } = await import('../apiUtilityRuntime')
      return { fingerprint: 'empty-consumer-fixture', apiUtilityScope: captureApiUtilities({ identity: request, approvals: {} }).scope,
        brokerAvailable: false, toolsRegistered: false }
    })
    runnerMocks.processNativeMode.mockResolvedValue({ content: 'API answer', intermediateSteps: [], usage: { totalTokens: 10 } })
  })

  it.each([
    ['a stored Claude Code CLI Subagent', { subagentType: 'cli', primary_model_provider: 'anthropic-claude-cli',
      primary_model_name: 'claude-cli', claude_settings: { model: 'sonnet' } }, CLAUDE_CODE_CLI_REFUSAL],
    ['a stored Codex CLI Subagent, by its provider', { subagentType: 'cli', primary_model_provider: 'openai-codex',
      primary_model_name: 'gpt-5.4', codex_settings: { model: 'gpt-5.4' } }, CODEX_CLI_REFUSAL],
    ['a stored Codex CLI Subagent, by its saved model', { subagentType: 'cli', primary_model_provider: '',
      primary_model_name: 'codex-cli' }, CODEX_CLI_REFUSAL],
    ['a typeless legacy record with a Claude Code CLI provider', { primary_model_provider: 'claude-cli',
      primary_model_name: 'opus' }, CLAUDE_CODE_CLI_REFUSAL],
    ['a typeless legacy record with the Codex CLI provider', { primary_model_provider: 'openai-codex',
      primary_model_name: 'gpt-5.4' }, CODEX_CLI_REFUSAL],
  ])('refuses %s readably, before any run work', async (_label, fields, refusal) => {
    const begin = vi.spyOn(subagentRunRegistry, 'beginSubagentRun')
    const lock = vi.spyOn(subagentThreads, 'acquireSubagentRunLock')

    const failure = await run(retiredHelper(fields)).catch((error) => error)

    expect(failure).toBeInstanceOf(RetiredSubagentError)
    expect(isRetiredSubagentError(failure)).toBe(true)
    expect(failure.code).toBe(SUBAGENT_TYPE_RETIRED_CODE)
    expect(failure.message).toBe(refusal)
    expect(begin).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
    expect(runnerMocks.resolveManagedSubagentScope).not.toHaveBeenCalled()
    expect(runnerMocks.prepareApiToolset).not.toHaveBeenCalled()
    expect(runnerMocks.processNativeMode).not.toHaveBeenCalled()
    expect(hasRunningSubagentRun('user-1', 'retired-helper')).toBe(false)
    expect(subagentRedis.snapshot()[buildSubagentRunLockKey('session-1', 'retired_helper')]).toBeUndefined()
    expect(subagentRedis.snapshot()[buildSubagentThreadKey('session-1', 'retired_helper')]).toBeUndefined()
  })

  it('refuses a `base` Worker clone of a Claude Code CLI Subagent the same way', async () => {
    const failure = await run(
      retiredHelper({ id: 'worker_4b0c', displayName: 'Retired Helper', subagentType: 'cli',
        primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'claude-cli' }),
      { delegationKind: 'worker', delegationSlug: 'worker_agent_1_1' },
    ).catch((error) => error)

    expect(isRetiredSubagentError(failure)).toBe(true)
    expect(failure.message).toBe(CLAUDE_CODE_CLI_REFUSAL)
    expect(runnerMocks.resolveManagedSubagentScope).not.toHaveBeenCalled()
    expect(runnerMocks.processNativeMode).not.toHaveBeenCalled()
  })

  it('control: the same spies see an API Subagent register, lock and run', async () => {
    const begin = vi.spyOn(subagentRunRegistry, 'beginSubagentRun')
    const lock = vi.spyOn(subagentThreads, 'acquireSubagentRunLock')

    const result = await run(apiHelper())

    expect(result).toMatchObject({ status: 'completed', output: 'API answer' })
    expect(begin).toHaveBeenCalledOnce()
    expect(lock).toHaveBeenCalledOnce()
    expect(runnerMocks.processNativeMode).toHaveBeenCalledOnce()
  })
})
