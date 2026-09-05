import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-111 P4 (DL-111-09..12) — Workers through the real runner.
 *
 * The API lane is under test because it is the one that runs in-process: a worker batch
 * goes straight from `native_spawn_workers` into `spawnWorkers` into
 * `executeManagedSubagent`. The properties that matter are the ones a stub cannot show —
 * that a worker leaves NO stored thread and takes NO lock (so three can run at once), that
 * a `base` clone actually carries the base subagent's prompt, and that every refusal comes
 * back as a readable result rather than a throw.
 */

const workerMocks = vi.hoisted(() => ({
  processNativeMode: vi.fn(),
  redisGetUserSettings: vi.fn(),
  resolveManagedSubagentScope: vi.fn(),
  buildManagedSubagentDynamicInfo: vi.fn(),
  redisStore: { current: null as any },
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: vi.fn(function MockBrain(this: Record<string, unknown>) {
    Object.assign(this, { processNativeMode: workerMocks.processNativeMode })
  }),
}))

vi.mock('$lib/server/services/codexBridge', () => ({ CodexBridge: vi.fn() }))
vi.mock('$lib/server/services/claudeBridge', () => ({ ClaudeBridge: vi.fn() }))
vi.mock('$lib/server/services/codexProfileManager', () => ({
  buildAgentProfileId: vi.fn((value: string) => `profile-${value}`),
  prepareManagedCodexSubagentProfile: vi.fn(),
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  prepareManagedClaudeSubagentProfile: vi.fn(),
}))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn().mockResolvedValue(null) },
}))

vi.mock('$lib/server/redis', () => ({
  redis: new Proxy({} as Record<string, any>, {
    get(_target, prop: string) {
      if (prop === 'getUserSettings') {
        return (...args: any[]) => workerMocks.redisGetUserSettings(...args)
      }
      return workerMocks.redisStore.current.redis[prop]
    },
  }),
}))

vi.mock('$lib/server/services/subagentRuntimeScope', () => ({
  resolveManagedSubagentScope: (...args: any[]) =>
    workerMocks.resolveManagedSubagentScope(...args),
  buildManagedSubagentDynamicInfo: (...args: any[]) =>
    workerMocks.buildManagedSubagentDynamicInfo(...args),
  appendManagedSubagentDynamicInfo: (systemPrompt: string) => systemPrompt,
}))

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: vi.fn().mockResolvedValue([]),
  buildSkillsCommandsDcmLines: vi.fn(() => []),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import {
  WORKERS_MAX_CONCURRENT,
  WORKERS_MAX_PER_CALL,
  WORKERS_MAX_RUNS_PER_TURN,
} from '$lib/utils/delegationCapabilities'
import { __resetWorkerTurnBudgetForTests } from '../workerTurnBudget'
import { spawnWorkers, type WorkerParentContext } from '../workerRunner'

const subagentRedis = createSubagentRedisMock()
workerMocks.redisStore.current = subagentRedis

function baseSubagent() {
  return {
    id: 'researcher',
    user_id: 'USER-1',
    displayName: 'Researcher',
    subagentType: 'api' as const,
    system_prompt: 'RESEARCHER CUSTOM PROMPT',
    include_global_prompt: true,
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-5.4',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function parent(overrides: Partial<WorkerParentContext> = {}): WorkerParentContext {
  return {
    userId: 'USER-1',
    sessionId: 'session-1',
    parentAgentId: 'primary-agent',
    parentMessageId: 'msg-1',
    projectPath: '/workspace/project',
    lane: 'api',
    parentModelId: 'anthropic/claude-sonnet-5',
    parentConnection: { id: 'conn-1', service: 'anthropic' } as any,
    providerSettings: { nativeTools: { webSearchEnabled: true } },
    selectedGateways: ['gw-1'],
    toolSelections: ['Redis_get'],
    selectedCliToolIds: ['cli-1'],
    defaultGateways: ['gw-1'],
    dcmDisplaySettings: null,
    assignedSubagents: [baseSubagent()],
    ...overrides,
  }
}

/** The system prompt the brain was handed on a given worker run. */
function systemPromptForCall(index: number): string {
  const messages = workerMocks.processNativeMode.mock.calls[index]?.[0]?.messages ?? []
  return messages.find((message: any) => message.role === 'system')?.content ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  subagentRedis.clear()
  __resetWorkerTurnBudgetForTests()
  subagentRedis.seed('batshit:sub_system_prompt', '# Base SUBAGENT prompt')
  subagentRedis.seed('batshit:worker_prompt', '# Base WORKER prompt')
  workerMocks.redisGetUserSettings.mockResolvedValue({
    global_custom_system_prompt: 'GLOBAL IDENTITY TEXT',
  })
  workerMocks.buildManagedSubagentDynamicInfo.mockResolvedValue('')
  workerMocks.resolveManagedSubagentScope.mockImplementation(async () => ({
    subagentType: 'api',
    nativeToolSettings: {},
    defaultMcpGateways: ['gw-1'],
    resolvedGateways: ['gw-1'],
    defaultCliToolIds: ['cli-1'],
    resolvedCliToolIds: ['cli-1'],
    defaultMcpToolSelections: ['Redis_get'],
    dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
    projectPath: '/workspace/project',
  }))
  workerMocks.processNativeMode.mockResolvedValue({
    content: 'Worker answer',
    intermediateSteps: [],
    usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
  })
})

describe('spawnWorkers (DL-111-09)', () => {
  it('runs a batch in parallel and returns one record per worker', async () => {
    const result = await spawnWorkers({
      parent: parent(),
      workers: [
        { task: 'Find the config file', role: 'config scout' },
        { task: 'List the open TODOs' },
      ],
    })

    expect(result).toMatchObject({ kind: 'workers', success: true, requested: 2, completed: 2 })
    expect((result as any).workers).toHaveLength(2)
    expect((result as any).workers[0]).toMatchObject({
      index: 0,
      name: 'config scout',
      role: 'config scout',
      base: null,
      status: 'completed',
      output: 'Worker answer',
      usage: { totalTokens: 100 },
    })
    // No role and no base falls back to a numbered worker name.
    expect((result as any).workers[1].name).toBe('Worker 2')
    expect(workerMocks.processNativeMode).toHaveBeenCalledTimes(2)
  })

  it('leaves no stored thread and no run lock behind', async () => {
    await spawnWorkers({ parent: parent(), workers: [{ task: 'Do a thing' }] })

    // Parallel is the point: a worker must never touch `subagent_sessions:`,
    // `subagent_thread:`, or `subagent_lock:` (Faye's P4 design note).
    const keys = Object.keys(subagentRedis.snapshot())
    expect(keys.filter((key) => key.startsWith('subagent_sessions:'))).toEqual([])
    expect(keys.filter((key) => key.startsWith('subagent_thread:'))).toEqual([])
    expect(keys.filter((key) => key.startsWith('subagent_lock:'))).toEqual([])
  })

  it('gives the built-in worker the worker prompt, not the subagent prompt', async () => {
    await spawnWorkers({
      parent: parent(),
      workers: [{ task: 'Do a thing', role: 'scout' }],
    })

    const prompt = systemPromptForCall(0)
    expect(prompt).toContain('# Base WORKER prompt')
    expect(prompt).not.toContain('# Base SUBAGENT prompt')
    expect(prompt).toContain('==== WORKER RUNTIME CONTEXT ====')
    expect(prompt).not.toContain('==== SUBAGENT RUNTIME CONTEXT ====')
    expect(prompt).toContain('role: scout')
    // DL-111-10: no global identity prompt for a worker, even though it is set here.
    expect(prompt).not.toContain('GLOBAL IDENTITY TEXT')
  })

  it('runs a base clone with the base subagent prompt and names the base', async () => {
    const result = await spawnWorkers({
      parent: parent(),
      workers: [{ task: 'Dig through the docs', base: 'researcher' }],
    })

    expect((result as any).workers[0]).toMatchObject({ base: 'researcher', status: 'completed' })
    expect((result as any).workers[0].name).toBe('Researcher (worker)')

    const prompt = systemPromptForCall(0)
    // The clone keeps the specialist's own prompt...
    expect(prompt).toContain('RESEARCHER CUSTOM PROMPT')
    expect(prompt).toContain('based_on: Researcher')
    // ...but is still a worker: worker base prompt, no memory, no global identity text.
    expect(prompt).toContain('# Base WORKER prompt')
    expect(prompt).toContain('memory: none')
    expect(prompt).not.toContain('GLOBAL IDENTITY TEXT')
  })

  it('refuses an unknown base by name instead of silently using the general worker', async () => {
    const result = await spawnWorkers({
      parent: parent(),
      workers: [{ task: 'Dig', base: 'nobody' }],
    })

    expect(result).toMatchObject({ kind: 'workers', success: false, error: 'unknown_base' })
    expect((result as any).message).toContain('nobody')
    expect((result as any).message).toContain('researcher')
    expect(workerMocks.processNativeMode).not.toHaveBeenCalled()
  })

  it('refuses to clone an n8n Workflow Subagent', async () => {
    const result = await spawnWorkers({
      parent: parent({
        assignedSubagents: [
          {
            id: 'intake',
            user_id: 'USER-1',
            displayName: 'Intake',
            subagentType: 'n8n-workflow',
            webhookUrl: 'https://n8n.local/webhook/intake',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      }),
      workers: [{ task: 'Run intake', base: 'intake' }],
    })

    expect(result).toMatchObject({ kind: 'workers', success: false, error: 'unsupported_base' })
    expect(workerMocks.processNativeMode).not.toHaveBeenCalled()
  })

  it('refuses a batch over the per-call cap without starting any worker', async () => {
    const result = await spawnWorkers({
      parent: parent(),
      workers: Array.from({ length: WORKERS_MAX_PER_CALL + 1 }, (_unused, index) => ({
        task: `Task ${index}`,
      })),
    })

    expect(result).toMatchObject({ kind: 'workers', success: false, error: 'worker_batch_too_large' })
    expect(workerMocks.processNativeMode).not.toHaveBeenCalled()
  })

  it('refuses once the parent turn has spent its worker budget', async () => {
    const turns = WORKERS_MAX_RUNS_PER_TURN / WORKERS_MAX_PER_CALL
    for (let call = 0; call < turns; call += 1) {
      const ok = await spawnWorkers({
        parent: parent(),
        workers: Array.from({ length: WORKERS_MAX_PER_CALL }, () => ({ task: 'Work' })),
      })
      expect(ok.success).toBe(true)
    }

    const over = await spawnWorkers({ parent: parent(), workers: [{ task: 'One more' }] })
    expect(over).toMatchObject({ kind: 'workers', success: false, error: 'worker_turn_limit' })
  })

  it('refuses when the parent turn cannot be identified, rather than skipping the cap', async () => {
    const result = await spawnWorkers({
      parent: parent({ parentMessageId: null }),
      workers: [{ task: 'Work' }],
    })

    expect(result).toMatchObject({ kind: 'workers', success: false, error: 'invalid_context' })
    expect(workerMocks.processNativeMode).not.toHaveBeenCalled()
  })

  it('rejects a worker with no task and says why', async () => {
    const result = await spawnWorkers({ parent: parent(), workers: [{ role: 'scout' }] })
    expect(result).toMatchObject({ kind: 'workers', success: false, error: 'invalid_input' })
    expect((result as any).message).toContain('no `task`')
  })

  it('reports one worker failing without losing the others', async () => {
    workerMocks.processNativeMode
      .mockRejectedValueOnce(new Error('provider exploded'))
      .mockResolvedValue({
        content: 'Second answer',
        intermediateSteps: [],
        usage: { totalTokens: 42 },
      })

    const result = await spawnWorkers({
      parent: parent(),
      workers: [{ task: 'Boom' }, { task: 'Fine' }],
    })

    expect(result).toMatchObject({ success: true, requested: 2, completed: 1 })
    const workers = (result as any).workers
    expect(workers[0].status).toBe('failed')
    expect(workers[0].usage).toBeNull()
    expect(workers[1]).toMatchObject({ status: 'completed', output: 'Second answer' })
  })

  it('never gives a worker the tools that would let it delegate again (DL-111-12)', async () => {
    await spawnWorkers({ parent: parent(), workers: [{ task: 'Work' }] })

    const call = workerMocks.processNativeMode.mock.calls[0][0]
    expect(call.assignedSubagents).toEqual([])
    expect(call.allowFabricControlTools).toBe(false)
    expect(call.memoryControlsEnabled).toBe(false)
    expect(call.toolApprovalMode).toBe('off')
    // The worker tool itself is registered only when the brain is told `workersEnabled`,
    // and the runner never passes it — so a worker cannot spawn workers.
    expect(call.workersEnabled).toBeUndefined()
  })

  it('inherits the parent model and connection for the built-in worker', async () => {
    await spawnWorkers({ parent: parent(), workers: [{ task: 'Work' }] })

    const call = workerMocks.processNativeMode.mock.calls[0][0]
    expect(call.model).toBe('anthropic/claude-sonnet-5')
    expect(call.connection).toMatchObject({ id: 'conn-1', service: 'anthropic' })
    expect(call.projectPath).toBe('/workspace/project')
  })

  it('caps concurrency across two overlapping batches in one turn', async () => {
    // The batch tool can be called twice inside one AI SDK step (v7 runs a step's tool
    // calls through `Promise.all`), so the concurrency cap has to hold across CALLS, not
    // just inside one batch.
    let releaseSlowWorkers: () => void = () => {}
    const slowWorkersHeld = new Promise<void>((resolve) => {
      releaseSlowWorkers = resolve
    })
    workerMocks.processNativeMode.mockImplementation(async () => {
      await slowWorkersHeld
      return { content: 'Slow answer', intermediateSteps: [], usage: null }
    })

    const first = spawnWorkers({
      parent: parent(),
      workers: Array.from({ length: WORKERS_MAX_CONCURRENT }, () => ({ task: 'Slow' })),
    })

    // Wait until the first batch has actually reached the model, so its slots are held.
    await vi.waitFor(() =>
      expect(workerMocks.processNativeMode).toHaveBeenCalledTimes(WORKERS_MAX_CONCURRENT)
    )

    const second = await spawnWorkers({ parent: parent(), workers: [{ task: 'Extra' }] })
    expect(second).toMatchObject({ success: false, error: 'worker_concurrency_limit' })

    releaseSlowWorkers()
    await expect(first).resolves.toMatchObject({ success: true })
  })
})
