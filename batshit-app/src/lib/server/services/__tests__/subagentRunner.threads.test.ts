import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-111 P2 (DL-111-04, DL-111-05) — fresh-by-default / resume-on-request through the real
 * runner, plus the F7 race the in-flight lock exists to stop.
 *
 * The API lane is the one under test because it is where F7 actually bites: AI SDK v7 runs
 * every tool call of a step through `Promise.all`, so a primary agent can already fire two
 * calls at the same subagent in one step.
 */

const threadRunnerMocks = vi.hoisted(() => ({
  processNativeMode: vi.fn(),
  redisGetUserSettings: vi.fn(),
  resolveManagedSubagentScope: vi.fn(),
  buildManagedSubagentDynamicInfo: vi.fn(),
  redisStore: { current: null as any },
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: vi.fn(function MockBrain(this: Record<string, unknown>) {
    Object.assign(this, { processNativeMode: threadRunnerMocks.processNativeMode })
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
        return (...args: any[]) => threadRunnerMocks.redisGetUserSettings(...args)
      }
      return threadRunnerMocks.redisStore.current.redis[prop]
    },
  }),
}))

vi.mock('$lib/server/services/subagentRuntimeScope', () => ({
  resolveManagedSubagentScope: (...args: any[]) =>
    threadRunnerMocks.resolveManagedSubagentScope(...args),
  buildManagedSubagentDynamicInfo: (...args: any[]) =>
    threadRunnerMocks.buildManagedSubagentDynamicInfo(...args),
  appendManagedSubagentDynamicInfo: (systemPrompt: string) => systemPrompt,
}))

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: vi.fn().mockResolvedValue([]),
  buildSkillsCommandsDcmLines: vi.fn(() => []),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import {
  acquireSubagentRunLock,
  buildSubagentThreadKey,
  releaseSubagentRunLock,
} from '../subagentThreads'
import { executeManagedSubagent } from '../subagentRunner'

const subagentRedis = createSubagentRedisMock()
threadRunnerMocks.redisStore.current = subagentRedis

function apiSubagent(id = 'api-helper') {
  return {
    id,
    user_id: 'USER-1',
    displayName: 'API Helper',
    subagentType: 'api' as const,
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-5.4',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

// The slug is `sanitizeId(id)`, not the raw id — read it from the same helper the runner
// uses so this suite can never drift onto a key nothing writes.
const THREAD_KEY = buildSubagentThreadKey('session-1', resolveSubagentSlug(apiSubagent()))

function run(overrides: Record<string, any> = {}) {
  return executeManagedSubagent({
    userId: 'USER-1',
    sessionId: 'session-1',
    chatInput: 'Do the thing.',
    parentAgentId: 'primary-agent',
    parentModelId: 'gpt-5.4',
    subagent: apiSubagent(),
    ...overrides,
  } as any)
}

/** The history the brain was handed on a given call, minus the system message. */
function historyForCall(index: number) {
  const messages = threadRunnerMocks.processNativeMode.mock.calls[index]?.[0]?.messages ?? []
  return messages.filter((m: any) => m.role !== 'system')
}

beforeEach(() => {
  vi.clearAllMocks()
  subagentRedis.clear()
  subagentRedis.seed('batshit:sub_system_prompt', '# Base subagent prompt')
  threadRunnerMocks.redisGetUserSettings.mockResolvedValue(null)
  threadRunnerMocks.buildManagedSubagentDynamicInfo.mockResolvedValue('')
  threadRunnerMocks.resolveManagedSubagentScope.mockImplementation(async () => ({
    subagentType: 'api',
    nativeToolSettings: {},
    defaultMcpGateways: [],
    resolvedGateways: [],
    defaultCliToolIds: [],
    resolvedCliToolIds: [],
    defaultMcpToolSelections: [],
    dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
    projectPath: null,
  }))
  threadRunnerMocks.processNativeMode.mockResolvedValue({
    content: 'Answer',
    intermediateSteps: [],
    usage: {
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
    },
  })
})

describe('managed subagent thread control (DL-111-04)', () => {
  it('starts fresh by default and discards a stored thread', async () => {
    subagentRedis.seed(THREAD_KEY, [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ])

    const result = await run()

    expect(result.thread).toBe('fresh')
    expect(result).toMatchObject({
      subagentType: 'api',
      usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
      modelId: 'gpt-5.4',
      provider: 'openai',
      status: 'completed',
    })
    // The prior exchange never reached the model...
    expect(historyForCall(0)).toEqual([{ role: 'user', content: 'Do the thing.' }])
    // ...and it is gone, not merely skipped. Fresh RESETS (Josh's decision #3).
    expect(subagentRedis.snapshot()[THREAD_KEY]).toEqual([
      { role: 'user', content: 'Do the thing.' },
      { role: 'assistant', content: 'Answer' },
    ])
  })

  it('continues the stored thread on resume', async () => {
    subagentRedis.seed(THREAD_KEY, [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ])

    const result = await run({ thread: 'resume' })

    expect(result.thread).toBe('resumed')
    expect(historyForCall(0)).toEqual([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'Do the thing.' },
    ])
    expect(subagentRedis.snapshot()[THREAD_KEY]).toHaveLength(4)
  })

  it('says resumed-empty rather than pretending there was a thread', async () => {
    const result = await run({ thread: 'resume' })

    // Honest absence over a fabricated "resumed" (the SA-102 rule applied to threads).
    expect(result.thread).toBe('resumed-empty')
    expect(historyForCall(0)).toEqual([{ role: 'user', content: 'Do the thing.' }])
  })

  it('erases the ability to resume once a fresh call lands in between', async () => {
    await run({ thread: 'resume' })
    await run() // default fresh — this is the reset Josh accepted explicitly
    const third = await run({ thread: 'resume' })

    expect(third.thread).toBe('resumed')
    // Only the fresh call's own exchange survived to be resumed.
    expect(historyForCall(2)).toEqual([
      { role: 'user', content: 'Do the thing.' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Do the thing.' },
    ])
  })
})

describe('same-subagent serialization (DL-111-05, closes F7)', () => {
  it('keeps both exchanges when one subagent is called twice at once', async () => {
    // F7: without the lock both calls load the same thread, run, and persist — last writer
    // wins and one exchange is lost forever. With it, the second call waits and appends.
    let resolveFirst: (value: any) => void = () => {}
    const firstInFlight = new Promise((resolve) => {
      resolveFirst = resolve
    })

    threadRunnerMocks.processNativeMode
      .mockImplementationOnce(async () => {
        await firstInFlight
        return { content: 'First answer', intermediateSteps: [], usage: null }
      })
      .mockImplementationOnce(async () => ({
        content: 'Second answer',
        intermediateSteps: [],
        usage: null,
      }))

    const first = run({ thread: 'resume', chatInput: 'One' })
    const second = run({ thread: 'resume', chatInput: 'Two' })

    // The second call has not started while the first holds the turn.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(threadRunnerMocks.processNativeMode).toHaveBeenCalledTimes(1)

    resolveFirst(null)
    await Promise.all([first, second])

    expect(threadRunnerMocks.processNativeMode).toHaveBeenCalledTimes(2)
    // Four messages, not two: neither exchange was overwritten.
    expect(subagentRedis.snapshot()[THREAD_KEY]).toEqual([
      { role: 'user', content: 'One' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Two' },
      { role: 'assistant', content: 'Second answer' },
    ])
  })

  it('does not let one subagent block another', async () => {
    // Deterministic proof of the isolation property: hold ALPHA's turn by hand, then run
    // BETA. If the lock were shared, this call would sit and wait; instead it goes straight
    // through, which is why parallel breadth across different specialists still works.
    const alphaLock = await acquireSubagentRunLock({
      sessionId: 'session-1',
      slug: 'alpha',
      subagentLabel: 'Alpha',
      ttlMs: 60_000,
    })

    const startedAt = Date.now()
    const result = await run({ subagent: apiSubagent('beta') })

    expect(result.thread).toBe('fresh')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(await releaseSubagentRunLock(alphaLock)).toBe(true)
  })

  it('releases the turn even when the run fails', async () => {
    threadRunnerMocks.processNativeMode.mockRejectedValueOnce(new Error('provider exploded'))

    await expect(run()).resolves.toMatchObject({
      status: 'failed',
      usage: null,
      output: expect.stringContaining('provider exploded'),
    })

    // A stuck lock would block this subagent for the rest of the lock TTL.
    await expect(run()).resolves.toMatchObject({ thread: 'fresh' })
  })

  it('times out the complete API lane and does not commit a partial thread', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | null = null
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    threadRunnerMocks.processNativeMode.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) => {
        signal = abortSignal
        markStarted()
        return new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    )

    try {
      const pending = run({
        subagent: { ...apiSubagent(), timeout_seconds: 10 },
        thread: 'resume',
      })
      await started
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(pending).resolves.toMatchObject({
        status: 'timed_out',
        usage: null,
        thread: 'resumed-empty',
        output: expect.stringContaining('Treat this call as timed out'),
      })
      expect(signal?.aborted).toBe(true)
      expect(subagentRedis.snapshot()[THREAD_KEY]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
