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
  prepareApiToolset: vi.fn(),
  redisGetUserSettings: vi.fn(),
  resolveManagedSubagentScope: vi.fn(),
  prepareManagedSubagentDynamicInfo: vi.fn(),
  redisStore: { current: null as any },
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: vi.fn(function MockBrain(this: Record<string, unknown>) {
    Object.assign(this, { processNativeMode: threadRunnerMocks.processNativeMode, prepareApiToolset: threadRunnerMocks.prepareApiToolset })
  }),
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
  prepareManagedSubagentDynamicInfo: (...args: any[]) =>
    threadRunnerMocks.prepareManagedSubagentDynamicInfo(...args),
  appendManagedSubagentDynamicInfo: (systemPrompt: string, dynamicInfo: string) =>
    dynamicInfo ? `${systemPrompt}\n\n${dynamicInfo}` : systemPrompt,
}))

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: vi.fn().mockResolvedValue([]),
  buildSkillsCommandsDcmLines: vi.fn(() => []),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import {
  acquireSubagentRunLock,
  buildSubagentRunLockKey,
  buildSubagentThreadKey,
  releaseSubagentRunLock,
} from '../subagentThreads'
import { executeManagedSubagent as runManagedSubagent } from '../subagentRunner'
import { hasRunningSubagentRun, isSubagentDeletedError, stopSubagentRunsForDelete } from '../subagentRunRegistry'
import { StreamStoppedError } from '../streamStop'

const subagentRedis = createSubagentRedisMock()
threadRunnerMocks.redisStore.current = subagentRedis

// BL-287: the runner refuses a Subagent whose record is gone (a turn that loaded it before its
// delete), so each call stores the record it runs first, as a real Subagent's is.
async function executeManagedSubagent(params: Parameters<typeof runManagedSubagent>[0]) {
  const id = typeof params.subagent?.id === 'string' ? params.subagent.id.trim() : ''
  if (id && params.delegationKind !== 'worker') subagentRedis.seed(`subagent:${id}`, params.subagent)
  return runManagedSubagent(params)
}

function apiSubagent(id = 'api-helper') {
  return {
    id,
    user_id: 'USER-1',
    displayName: 'API Helper',
    subagentType: 'api' as const,
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-5.4',
    // BL-266: an own model names its preset, which carries the connection.
    primary_model_preset_id: 'preset-gpt-54',
    primary_model_connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
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
  threadRunnerMocks.prepareApiToolset.mockImplementation(async request => {
    const { captureApiUtilities } = await import('../apiUtilityRuntime')
    return { fingerprint: 'empty-consumer-fixture', apiUtilityScope: captureApiUtilities({ identity: request, approvals: {} }).scope,
      brokerAvailable: false, toolsRegistered: false }
  })
  subagentRedis.clear()
  subagentRedis.seed('batshit:sub_system_prompt', '# Base subagent prompt')
  subagentRedis.seed('model:preset-gpt-54', {
    id: 'preset-gpt-54',
    provider: 'openai',
    modelId: 'gpt-5.4',
    connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
  })
  threadRunnerMocks.redisGetUserSettings.mockResolvedValue(null)
  threadRunnerMocks.prepareManagedSubagentDynamicInfo.mockResolvedValue(() => '')
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

describe('the skill scope of an API Subagent run (BL-75)', () => {
  it('passes the subagent own id as the skill scope, while agentId stays the parent', async () => {
    const result = await run()
    expect(result.status).toBe('completed')

    expect(threadRunnerMocks.processNativeMode.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'primary-agent',
      processOwner: { userId: 'USER-1', kind: 'subagent', id: 'api-helper' },
      scopeAgentId: 'api-helper',
    })
    const prepared = await threadRunnerMocks.prepareApiToolset.mock.results[0].value
    expect(threadRunnerMocks.prepareApiToolset).toHaveBeenCalledTimes(1)
    expect(threadRunnerMocks.prepareManagedSubagentDynamicInfo).toHaveBeenCalledTimes(1)
    expect(threadRunnerMocks.prepareManagedSubagentDynamicInfo.mock.calls[0][0]).toMatchObject({ apiAuditAgentId: 'primary-agent' })
    expect(threadRunnerMocks.prepareManagedSubagentDynamicInfo.mock.calls[0][0].apiUtilityScope).toBe(prepared.apiUtilityScope)
    expect(threadRunnerMocks.processNativeMode.mock.calls[0][0].preparedApiToolset).toBe(prepared)
    expect(threadRunnerMocks.prepareApiToolset.mock.invocationCallOrder[0]).toBeLessThan(threadRunnerMocks.prepareManagedSubagentDynamicInfo.mock.invocationCallOrder[0])
  })

  it('leaves the prior thread intact when actual API appendix preparation fails before a fresh call', async () => {
    const previous = [{ role: 'user', content: 'Keep question' }, { role: 'assistant', content: 'Keep answer' }]
    subagentRedis.seed(THREAD_KEY, previous)
    threadRunnerMocks.prepareManagedSubagentDynamicInfo.mockRejectedValueOnce(new Error('Exact API metadata unavailable'))
    const result = await run({ thread: 'fresh' })
    expect(result.status).toBe('failed')
    expect(result.output).toContain('Exact API metadata unavailable')
    expect(result.thread).toBeNull()
    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
    expect(subagentRedis.snapshot()[THREAD_KEY]).toEqual(previous)
  })

  it('does not reset a prior fresh thread when Stop wins an awaited API preparation that settles late', async () => {
    const settleModule = await import('../subagentRunSettle')
    const settle = vi.spyOn(settleModule, 'settleSubagentRunWork')
    const previous = [{ role: 'user', content: 'Keep question' }, { role: 'assistant', content: 'Keep answer' }]
    subagentRedis.seed(THREAD_KEY, previous)
    let entered!: () => void, finish!: (render: (thread: string | null) => string) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const preparing = new Promise<(thread: string | null) => string>(resolve => { finish = resolve })
    threadRunnerMocks.prepareManagedSubagentDynamicInfo.mockImplementationOnce(() => { entered(); return preparing })
    const parent = new AbortController()
    const pending = run({ thread: 'fresh', abortSignal: parent.signal })
    pending.catch(() => undefined)
    await started
    const completion = settle.mock.results.at(-1)?.value?.completion
    expect(completion).toBeInstanceOf(Promise)
    parent.abort()
    await expect(pending).rejects.toThrow('cancelled')
    const render = vi.fn(() => '<dynamic_info>Late metadata</dynamic_info>')
    finish(render)
    await completion
    expect(render).not.toHaveBeenCalled()
    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
    expect(subagentRedis.snapshot()[THREAD_KEY]).toEqual(previous)
    settle.mockRestore()
  })

  it('does not reset another owner’s thread after an awaited API preparation loses its original lock', async () => {
    const { buildSubagentRunLockKey } = await import('../subagentThreads')
    const previous = [{ role: 'user', content: 'New owner question' }, { role: 'assistant', content: 'New owner answer' }]
    subagentRedis.seed(THREAD_KEY, previous)
    let entered!: () => void, finish!: (render: (thread: string | null) => string) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const preparing = new Promise<(thread: string | null) => string>(resolve => { finish = resolve })
    threadRunnerMocks.prepareManagedSubagentDynamicInfo.mockImplementationOnce(() => { entered(); return preparing })
    const pending = run({ thread: 'fresh' })
    await started
    const key = buildSubagentRunLockKey('session-1', resolveSubagentSlug(apiSubagent()))
    subagentRedis.seed(key, 'new-owner-ticket')
    const render = vi.fn(() => '<dynamic_info>Late metadata</dynamic_info>')
    finish(render)
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.output).toContain('lost its original thread lock during preparation')
    expect(result.thread).toBeNull()
    expect(render).not.toHaveBeenCalled()
    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
    expect(subagentRedis.snapshot()[THREAD_KEY]).toEqual(previous)
    expect(subagentRedis.snapshot()[key]).toBe('new-owner-ticket')
  })

  it('keeps a Worker on the parent physical owner without changing its audit identity', async () => {
    await run({ delegationKind: 'worker' })
    expect(threadRunnerMocks.processNativeMode.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'primary-agent',
      processOwner: { userId: 'USER-1', kind: 'agent', id: 'primary-agent' },
    })
  })

  it('takes the API Bash grant from the actual delegated record, even if a preset enables Bash', async () => {
    subagentRedis.seed('model:preset-gpt-54', {
      id: 'preset-gpt-54', provider: 'openai', modelId: 'gpt-5.4',
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
      settings: { nativeTools: { bashEnabled: true } },
    })
    await run({ subagent: { ...apiSubagent(), provider_specific_settings: { nativeTools: { bashEnabled: false } } } })
    expect(threadRunnerMocks.processNativeMode.mock.calls[0]?.[0]).toMatchObject({
      delegatedBashEnabled: false,
    })
  })

  it('fails the run loudly when the subagent has no id, instead of borrowing the parent skills', async () => {
    const result = await run({ subagent: { ...apiSubagent(), id: '  ' } })

    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.output).toContain('no subagent id')
  })
})

describe('the connection an API Subagent runs through (BL-266)', () => {
  it('runs its own model through the connection its preset names, never by name through the AI Gateway', async () => {
    await run({ parentConnection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' } })

    expect(threadRunnerMocks.processNativeMode.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.4',
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
    })
  })

  it('refuses an own model saved without a preset, before it touches the thread', async () => {
    subagentRedis.seed(THREAD_KEY, { messages: [{ role: 'user', content: 'kept' }] })
    const legacy = { ...apiSubagent(), primary_model_preset_id: undefined, primary_model_connection: undefined }
    const result = await run({ subagent: legacy, thread: 'fresh' })

    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.output).toContain('pick its model again')
    expect(await subagentRedis.redis.get(THREAD_KEY)).not.toBeNull()
  })
})

describe('a model setting the model refuses (the AI SDK set of 2026-09-29)', () => {
  it('comes back as a failed run the parent can read, before it touches the thread', async () => {
    subagentRedis.seed(THREAD_KEY, { messages: [{ role: 'user', content: 'kept' }] })
    subagentRedis.seed('model:preset-opus-55-off', {
      id: 'preset-opus-55-off',
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
      settings: { thinkingMode: 'disabled' },
    })
    const opus = {
      ...apiSubagent(),
      primary_model_provider: 'anthropic',
      primary_model_name: 'claude-opus-5-5',
      primary_model_preset_id: 'preset-opus-55-off',
      primary_model_connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
    }
    const result = await run({ subagent: opus, thread: 'fresh' })

    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    // 836bed405: the reviewed reasoning definitions refuse an unlisted mode first, in the mapper's words.
    expect(result.output).toContain('Thinking mode "disabled" is not available on claude-opus-5-5')
    expect(await subagentRedis.redis.get(THREAD_KEY)).not.toBeNull()
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

// BL-2190: a delegated run's base prompt follows the Primary prompts' BL-230 rule: the stored
// text, the packaged default when the key is absent or blank, and a readable failed call (never a
// silent run with no Batshit prompt) when the read fails.
describe('the base prompt a delegated run gets (BL-2190)', () => {
  const systemForCall = (index: number): string =>
    (threadRunnerMocks.processNativeMode.mock.calls[index]?.[0]?.messages ?? [])
      .find((message: any) => message.role === 'system')?.content ?? ''

  /** Make the raw read of one key fail, the way a dropped Redis connection does. */
  function failReadsOf(key: string): () => void {
    const original = subagentRedis.redis.execute
    subagentRedis.redis.execute = async (operation: (client: any) => Promise<unknown>) =>
      original((client: any) => operation({
        ...client,
        get: async (name: string) => {
          if (name === key) throw new Error('Connection is closed.')
          return client.get(name)
        },
      }))
    return () => { subagentRedis.redis.execute = original }
  }

  const cases = [
    { kind: 'Subagent', key: 'batshit:sub_system_prompt', header: '==== BATSHIT SUB-AGENT SYSTEM PROMPT ====', packagedH1: '# Batshit Subagent', overrides: {} },
    { kind: 'Worker', key: 'batshit:worker_prompt', header: '==== BATSHIT WORKER SYSTEM PROMPT ====', packagedH1: '# Batshit Worker', overrides: { delegationKind: 'worker' } },
  ] as const

  it.each(cases)('$kind: runs with the stored prompt when there is one', async ({ key, header, overrides }) => {
    subagentRedis.seed(key, '# Stored base prompt')
    const result = await run(overrides)
    expect(result.status).toBe('completed')
    expect(systemForCall(0).startsWith(`${header}\n\n# Stored base prompt\n`)).toBe(true)
  })

  it.each(cases)('$kind: runs with the packaged default when the key is absent or blank', async ({ key, header, packagedH1, overrides }) => {
    for (const stored of [null, '  \n ']) {
      threadRunnerMocks.processNativeMode.mockClear()
      if (stored === null) await subagentRedis.redis.del(key)
      else subagentRedis.seed(key, stored)
      const result = await run(overrides)
      expect(result.status).toBe('completed')
      expect(systemForCall(0).startsWith(`${header}\n\n${packagedH1}\n`)).toBe(true)
      // Compiling writes nothing: the next boot seed or an Admin visit stores the key.
      expect(subagentRedis.snapshot()[key] ?? null).toBe(stored)
    }
  })

  it.each(cases)('$kind: a failed read fails the call readably, before the model, the lock or the thread', async ({ key, overrides }) => {
    subagentRedis.seed(THREAD_KEY, [{ role: 'user', content: 'kept' }])
    const restore = failReadsOf(key)
    try {
      const result = await run({ ...overrides, thread: 'fresh' })
      expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
      expect(result).toMatchObject({ status: 'failed', thread: null, usage: null, intermediateSteps: [] })
      expect(result.output).toBe(
        `API Helper failed: SYSTEM_PROMPT_UNAVAILABLE: Batshit could not read ${key}, so this call did not run: Connection is closed.`
      )
    } finally {
      restore()
    }
    // A fresh call that never ran reset nothing, and left no lock behind.
    expect(subagentRedis.snapshot()[THREAD_KEY]).toEqual([{ role: 'user', content: 'kept' }])
    expect(Object.keys(subagentRedis.snapshot()).filter((name) => name.startsWith('subagent_lock:'))).toEqual([])
  })
})

// Decision 11 (Josh, 2026-10-24): the Subagent System Prompt points at a `thread:` line in its
// `<dynamic_info>`, so the runner renders the DCM with the outcome the lane really opened.
describe('the thread outcome in the subagent DCM (decision 11)', () => {
  const systemForCall = (index: number): string =>
    (threadRunnerMocks.processNativeMode.mock.calls[index]?.[0]?.messages ?? [])
      .find((message: any) => message.role === 'system')?.content ?? ''

  beforeEach(() => {
    threadRunnerMocks.prepareManagedSubagentDynamicInfo.mockResolvedValue(
      (thread: string | null) => `<dynamic_info>\nTHREAD=${thread}\n</dynamic_info>`
    )
  })

  it('renders fresh, then resumed, with the exchange a fresh call stored', async () => {
    const fresh = await run()
    const resumed = await run({ thread: 'resume' })
    expect([fresh.thread, resumed.thread]).toEqual(['fresh', 'resumed'])
    expect(systemForCall(0)).toContain('\n\n<dynamic_info>\nTHREAD=fresh\n</dynamic_info>')
    expect(systemForCall(1)).toContain('\n\n<dynamic_info>\nTHREAD=resumed\n</dynamic_info>')
    // The costly index is prepared once per call, before the lock, and rendered once.
    expect(threadRunnerMocks.prepareManagedSubagentDynamicInfo).toHaveBeenCalledTimes(2)
  })

  it('renders resumed-empty when there was nothing to resume', async () => {
    expect((await run({ thread: 'resume' })).thread).toBe('resumed-empty')
    expect(systemForCall(0)).toContain('THREAD=resumed-empty')
  })

  it('renders no thread for a Worker, which has none', async () => {
    const result = await run({ delegationKind: 'worker', thread: 'resume' })
    expect(result.thread).toBeNull()
    expect(systemForCall(0)).toContain('THREAD=null')
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
      waitBudgetMs: 62_000,
    })

    const startedAt = Date.now()
    const result = await run({ subagent: apiSubagent('beta') })

    expect(result.thread).toBe('fresh')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(await releaseSubagentRunLock(alphaLock)).toBe(true)
  })

  it('explains a queued call instead of leaving the extra wall clock a mystery', async () => {
    // A queued call reports only its RUN in `durationMs`, and it waits as long as the call
    // ahead of it runs (the holder's heartbeat keeps the lock). Saying so is what keeps that
    // honest — a silent gap between wall clock and reported duration is the kind of thing
    // nobody can debug later.
    const held = await acquireSubagentRunLock({
      sessionId: 'session-1',
      slug: 'alpha',
      subagentLabel: 'Alpha',
      ttlMs: 1_200,
    })
    // A holder that dies: no more heartbeat, no release. Its TTL hands the turn over, so the
    // run really does queue without the test having to orchestrate a second concurrent run.
    held.stopHeartbeat()

    const result = await run({ subagent: apiSubagent('alpha') })

    expect(result.status).toBe('completed')
    expect(result.threadNote).toContain('waited')
    expect(result.threadNote).toContain('same subagent')
    // It points at the actual answer for parallel work rather than just apologising.
    expect(result.threadNote).toContain('Workers')
    // The stale handle must not steal the turn from the run that took it.
    expect(await releaseSubagentRunLock(held)).toBe(false)
  })

  it('says nothing about queueing when the call went straight through', async () => {
    const result = await run()
    expect(result.status).toBe('completed')
    expect(result.threadNote).toBeUndefined()
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

// Plumbing only: the brain is mocked, so these pass without the BL-449/BL-452 fixes. The fixes
// themselves are proven in vercelBrain.delegatedRunEnd.test.ts and vercelBrain.mode3.test.ts.
describe("the runner's Stop and failure plumbing on the API lane", () => {
  it("runner plumbing: the parent's Stop aborts the signal it hands the brain, and a Stop commits no thread", async () => {
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
          abortSignal.addEventListener('abort', () => reject(new StreamStoppedError()))
        })
      },
    )
    const parent = new AbortController()

    const pending = run({ abortSignal: parent.signal })
    pending.catch(() => undefined)
    await started
    parent.abort()

    await expect(pending).rejects.toThrow('cancelled')
    expect(signal?.aborted).toBe(true)
    expect(subagentRedis.snapshot()[THREAD_KEY]).toBeUndefined()
  })

  it("runner plumbing: a brain that throws becomes a failed result carrying the error's message", async () => {
    threadRunnerMocks.processNativeMode.mockRejectedValueOnce(new Error('Overloaded'))

    await expect(run()).resolves.toMatchObject({
      status: 'failed',
      output: 'API Helper failed: Overloaded',
    })
    expect(subagentRedis.snapshot()[THREAD_KEY]).toBeUndefined()
  })
})

/**
 * Delegation limits (Josh, 2026-10-24) on the API lane: no time and no tool-step limit by
 * default, the 10-minute stall guard fed by the brain's stream (a running tool call is not
 * silence), an optional step limit whose stopped run comes back marked partial, and Stop
 * ending a long run. The brain is mocked here; `vercelBrain.delegatedRunEnd.test.ts` proves
 * the stream reporting and the step count against the real AI SDK.
 */
describe('delegation limits - API lane', () => {
  /** The brain's run as the runner sees it: report progress through the sink it hands in. */
  function brainThat(work: (request: any) => Promise<any>) {
    let markEntered: () => void = () => {}
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    threadRunnerMocks.processNativeMode.mockImplementationOnce(async (request: any) => {
      markEntered()
      return work(request)
    })
    return entered
  }
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

  it('passes no step limit and a progress sink by default (it stopped at 10 rounds before)', async () => {
    await run()
    const request = threadRunnerMocks.processNativeMode.mock.calls[0][0]
    expect(request.delegatedMaxToolSteps).toBeNull()
    expect(request.maxToolRounds).toBeUndefined()
    expect(typeof request.delegatedProgress?.activity).toBe('function')
  })

  it('has no time limit by default: an hour of reported work completes', async () => {
    fakeClock()
    try {
      const entered = brainThat(async (request) => {
        for (let minute = 0; minute < 60; minute += 1) {
          request.delegatedProgress.activity()
          await new Promise((resolve) => setTimeout(resolve, 60_000))
        }
        return { content: 'An hour of work, done.', intermediateSteps: [], usage: { totalTokens: 5 } }
      })
      const pending = run()
      await entered
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      await expect(pending).resolves.toMatchObject({ status: 'completed', output: 'An hour of work, done.' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the stall guard stops a silent run at 10 minutes, aborts it, and commits no thread', async () => {
    fakeClock()
    let signal: AbortSignal | null = null
    try {
      const entered = brainThat((request) => {
        signal = request.abortSignal
        return new Promise((_resolve, reject) => {
          request.abortSignal.addEventListener('abort', () => reject(new StreamStoppedError()))
        })
      })
      let settled = false
      const pending = run().finally(() => { settled = true })
      await entered
      await vi.advanceTimersByTimeAsync(9 * 60_000 + 59_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      const result = await pending
      expect(result.status).toBe('timed_out')
      expect(result.output).toContain('API Helper showed no progress for 10 minutes')
      expect(signal?.aborted).toBe(true)
      expect(subagentRedis.snapshot()[THREAD_KEY]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a run whose lock lapsed and was taken by another call stops instead of running alongside it', async () => {
    fakeClock()
    let signal: AbortSignal | null = null
    try {
      const entered = brainThat((request) => {
        signal = request.abortSignal
        return new Promise((_resolve, reject) => {
          request.abortSignal.addEventListener('abort', () => reject(new StreamStoppedError()))
        })
      })
      const pending = run().then(
        (value) => ({ value }),
        (error: Error) => ({ error })
      )
      await entered
      // Batshit could not refresh the lock for a whole TTL; another call took the turn.
      const lockKey = buildSubagentRunLockKey('session-1', resolveSubagentSlug(apiSubagent()))
      subagentRedis.expireNow(lockKey)
      const other = await acquireSubagentRunLock({
        sessionId: 'session-1',
        slug: resolveSubagentSlug(apiSubagent()),
        subagentLabel: 'API Helper'
      })
      other.stopHeartbeat()
      await vi.advanceTimersByTimeAsync(10_001)
      const outcome = await pending
      expect('error' in outcome && outcome.error.message).toContain('API Helper lost its turn')
      expect(signal?.aborted).toBe(true)
      expect(subagentRedis.snapshot()[THREAD_KEY]).toBeUndefined()
      // The newer call's lock is untouched.
      expect(await releaseSubagentRunLock(other)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('time inside a running tool call is not silence: a 40-minute command completes', async () => {
    fakeClock()
    try {
      const entered = brainThat(async (request) => {
        request.delegatedProgress.toolStarted('bash-1')
        await new Promise((resolve) => setTimeout(resolve, 40 * 60_000))
        request.delegatedProgress.toolEnded('bash-1')
        return { content: 'Build finished.', intermediateSteps: [], usage: null }
      })
      const pending = run()
      await entered
      await vi.advanceTimersByTimeAsync(40 * 60_000 + 1_000)
      await expect(pending).resolves.toMatchObject({ status: 'completed', output: 'Build finished.' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the guard re-arms when the tool ends: silence after it still stops the run', async () => {
    fakeClock()
    try {
      const entered = brainThat((request) => {
        request.delegatedProgress.toolStarted('bash-1')
        setTimeout(() => request.delegatedProgress.toolEnded('bash-1'), 30 * 60_000)
        return new Promise((_resolve, reject) => {
          request.abortSignal.addEventListener('abort', () => reject(new StreamStoppedError()))
        })
      })
      const pending = run()
      await entered
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 9 * 60_000)
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      await expect(pending).resolves.toMatchObject({ status: 'timed_out' })
    } finally {
      vi.useRealTimers()
    }
  })

  it("Stop ends a long run whatever its limits", async () => {
    fakeClock()
    try {
      const entered = brainThat((request) => {
        const beat = setInterval(() => request.delegatedProgress.activity(), 30_000)
        return new Promise((_resolve, reject) => {
          request.abortSignal.addEventListener('abort', () => {
            clearInterval(beat)
            reject(new StreamStoppedError())
          })
        })
      })
      const parent = new AbortController()
      const pending = run({ abortSignal: parent.signal })
      pending.catch(() => undefined)
      await entered
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
      parent.abort()
      await expect(pending).rejects.toThrow('cancelled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a set step limit reaches the brain, and a run it stopped comes back partial with its work so far', async () => {
    threadRunnerMocks.processNativeMode.mockResolvedValueOnce({
      content: 'Checked the first two files.',
      intermediateSteps: [
        { toolName: 'read_file', toolInput: { path: 'a' }, toolOutput: 'A', timestamp: 1 },
        { toolName: 'read_file', toolInput: { path: 'b' }, toolOutput: 'B', timestamp: 2 },
      ],
      usage: { totalTokens: 12 },
      delegatedStepLimitReached: { limit: 2, toolCalls: 2 },
    })
    const result = await run({ subagent: { ...apiSubagent(), max_tool_steps: 2 } })

    expect(threadRunnerMocks.processNativeMode.mock.calls[0][0].delegatedMaxToolSteps).toBe(2)
    expect(result.status).toBe('partial')
    expect(result.intermediateSteps).toHaveLength(2)
    expect(result.output).toBe(
      '[Partial result: API Helper reached its limit of 2 tool steps before it finished, so Batshit stopped it. What follows is its work so far and may be incomplete. Its thread keeps your task and its own words, not its tool results, so to continue, call it again with thread "resume" and say what its tool steps (listed with this result) already did and what is left.]\n\nChecked the first two files.',
    )
    // The thread keeps the run's own words, so a resume continues from them.
    expect((subagentRedis.snapshot()[THREAD_KEY] as any[]).at(-1)).toEqual({
      role: 'assistant',
      content: 'Checked the first two files.',
    })
  })

  it('BL-2218: a run stopped before any prose says how to resume, and its thread keeps the empty answer', async () => {
    threadRunnerMocks.processNativeMode.mockResolvedValueOnce({
      content: '',
      intermediateSteps: [{ toolName: 'write_file', toolInput: { path: 'a' }, toolOutput: 'ok', timestamp: 1 }],
      usage: { totalTokens: 5 },
      delegatedStepLimitReached: { limit: 1, toolCalls: 1 },
    })
    const result = await run({ subagent: { ...apiSubagent(), max_tool_steps: 1 } })

    expect(result.status).toBe('partial')
    expect(result.intermediateSteps).toHaveLength(1)
    expect(result.output).toBe(
      '[Partial result: API Helper reached its limit of 1 tool step before it finished, so Batshit stopped it. What follows is its work so far and may be incomplete. ' +
        'Its thread keeps your task and its own words, not its tool results, so to continue, call it again with thread "resume" and say what its tool steps (listed with this result) already did and what is left.]' +
        '\n\n(It wrote no answer before the limit; its tool steps are listed with this result.)',
    )
    // The accepted text-only thread: the task, then the run's own (empty) words; no tool output.
    expect((subagentRedis.snapshot()[THREAD_KEY] as any[]).at(-1)).toEqual({ role: 'assistant', content: '' })
  })

  it('BL-2356: a run whose last model call stopped at its output limit comes back partial, its words marked as maybe cut off', async () => {
    threadRunnerMocks.processNativeMode.mockResolvedValueOnce({
      content: 'The report so f',
      intermediateSteps: [{ toolName: 'read_file', toolInput: { path: 'a' }, toolOutput: 'A', timestamp: 1 }],
      usage: { totalTokens: 12 },
      delegatedOutputLimitReached: true,
    })
    const result = await run({ subagent: apiSubagent() })
    expect(result.status).toBe('partial')
    expect(result.output).toBe(
      "[Partial result: API Helper stopped at its model's output limit before it finished, so its last words may be cut off. What follows is its work so far and may be incomplete. " +
        'Its thread keeps your task and its own words, so to continue, call it again with thread "resume" and ask it to go on from where it was cut off, or to answer in smaller parts; the same limit applies again.]' +
        '\n\nThe report so f',
    )
    // The thread keeps the run's own words, as at the step limit.
    expect((subagentRedis.snapshot()[THREAD_KEY] as any[]).at(-1)).toEqual({ role: 'assistant', content: 'The report so f' })
  })

  it('BL-2356 review: a Worker cut at its output limit before any words says so, with advice that fits a Worker', async () => {
    threadRunnerMocks.processNativeMode.mockResolvedValueOnce({ content: '', intermediateSteps: [], usage: null, delegatedOutputLimitReached: true })
    const result = await run({
      delegationKind: 'worker',
      delegationSlug: 'worker_primary_agent_1',
      subagent: apiSubagent('worker-copy'),
    })
    expect(result.status).toBe('partial')
    expect(result.output).toContain("stopped at its model's output limit before it finished")
    expect(result.output).toContain('A Worker cannot be resumed; start a new one with what is left, and ask for a shorter answer or smaller parts, since the same limit applies.')
    expect(result.output).toContain('(It reached the limit before it wrote an answer; any tool steps it took are listed with this result.)')
    expect(result.output).not.toContain('its tool steps (listed with this result) already did')
  })

  it('a Worker stopped at its step limit says it cannot be resumed', async () => {
    threadRunnerMocks.processNativeMode.mockResolvedValueOnce({
      content: '',
      intermediateSteps: [{ toolName: 'read_file', toolInput: {}, toolOutput: 'A', timestamp: 1 }],
      usage: null,
      delegatedStepLimitReached: { limit: 1, toolCalls: 1 },
    })
    const result = await run({
      delegationKind: 'worker',
      delegationSlug: 'worker_primary_agent_1',
      subagent: { ...apiSubagent('worker-copy'), max_tool_steps: 1 },
    })
    expect(result.status).toBe('partial')
    expect(result.output).toContain('reached its limit of 1 tool step before it finished')
    expect(result.output).toContain('A Worker cannot be resumed; start a new one with what is left to do.')
    expect(result.output).toContain('(It wrote no answer before the limit; its tool steps are listed with this result.)')
  })

  it('refuses a saved limit outside its range loudly instead of running with none', async () => {
    await expect(run({ subagent: { ...apiSubagent(), max_tool_steps: 0 } })).rejects.toThrow(
      'Max tool steps must be blank (no limit) or a whole number from 1 to 10,000.',
    )
    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
  })
})

/**
 * BL-287 (2026-09-27): a Subagent's run is registered before anything else of it happens, and
 * stays registered until its call is done AND its lane's work has settled, so its delete can stop
 * it the way a Stop does and wait for it. The registration is the runner's, the same for every
 * lane; SA-139 R5 moved these cases here from the removed CLI lane (`subagentRunner.cli.test.ts`).
 */
describe("a Subagent's delete and its running call (BL-287)", () => {
  async function until(condition: () => boolean) {
    for (let tries = 0; !condition() && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(condition()).toBe(true)
  }
  const raw = (overrides: Record<string, any> = {}) => runManagedSubagent({
    userId: 'USER-1', sessionId: 'session-1', chatInput: 'Still there?', parentAgentId: 'primary-agent',
    parentModelId: 'gpt-5.4', subagent: apiSubagent(), ...overrides,
  } as any)

  it('a delete stops its run and waits for the lane to unwind; a new call meanwhile is refused', async () => {
    const events: string[] = []
    threadRunnerMocks.processNativeMode.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          events.push('lane told to stop')
          // The lane unwinds well after the call answered (a Stop answers the call at once).
          setTimeout(() => { events.push('lane unwound'); reject(new StreamStoppedError()) }, 300)
        }, { once: true })
      }))

    const call = run({ chatInput: 'Run long.' }).catch((error) => error)
    await until(() => threadRunnerMocks.processNativeMode.mock.calls.length === 1)
    expect(hasRunningSubagentRun('USER-1', 'api-helper')).toBe(true)

    const deleting = stopSubagentRunsForDelete('USER-1', 'api-helper', { timeoutMs: 3_000, pollMs: 20 })
    // The record is still there while the delete waits; the mark alone refuses the new call.
    const during = await raw({ sessionId: 'session-2' }).catch((error) => error)
    const stop = await deleting
    events.push('delete goes on')
    stop.release()

    expect(stop.stopped).toBe(1)
    expect(events).toEqual(['lane told to stop', 'lane unwound', 'delete goes on'])
    const outcome = await call
    expect(isSubagentDeletedError(outcome)).toBe(true)
    expect(outcome.message).toBe('API Helper was deleted, so it does not run any more.')
    expect(isSubagentDeletedError(during)).toBe(true)
    expect(threadRunnerMocks.processNativeMode).toHaveBeenCalledOnce()
    expect(hasRunningSubagentRun('USER-1', 'api-helper')).toBe(false)
  })

  it('a Worker is never registered: its delete-time lookup finds no run, and a built-in Worker (no record) runs', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => (finish = resolve))
    const workerSignals: AbortSignal[] = []
    threadRunnerMocks.processNativeMode.mockImplementationOnce(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      workerSignals.push(abortSignal)
      await gate
      return { content: 'worker done', intermediateSteps: [], usage: null }
    })

    // A built-in Worker's record has no `subagent:` key behind it (registration would refuse it).
    const worker = raw({ subagent: { ...apiSubagent('worker_4b0c'), displayName: 'Worker 1' },
      delegationKind: 'worker', delegationSlug: 'worker_primary_agent_1' })
    await until(() => workerSignals.length === 1)

    expect(hasRunningSubagentRun('USER-1', 'worker_4b0c')).toBe(false)
    const stop = await stopSubagentRunsForDelete('USER-1', 'worker_4b0c')
    stop.release()
    expect(stop.stopped).toBe(0)
    expect(workerSignals[0].aborted).toBe(false)
    finish()
    expect((await worker).status).toBe('completed')
  })

  it('a Subagent whose record is gone does not start (a turn that loaded it before its delete)', async () => {
    const outcome = await raw({ subagent: apiSubagent('gone-helper') }).catch((error) => error)

    expect(isSubagentDeletedError(outcome)).toBe(true)
    expect(threadRunnerMocks.resolveManagedSubagentScope).not.toHaveBeenCalled()
    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
  })

  it('a delete during the setup stops the call before its lane starts', async () => {
    let openScope!: () => void
    const scopeGate = new Promise<void>((resolve) => (openScope = resolve))
    const scope = await threadRunnerMocks.resolveManagedSubagentScope()
    threadRunnerMocks.resolveManagedSubagentScope.mockClear()
    threadRunnerMocks.resolveManagedSubagentScope.mockImplementation(async () => {
      await scopeGate
      return scope
    })

    const call = run({ chatInput: 'Set up slowly.' }).catch((error) => error)
    await until(() => threadRunnerMocks.resolveManagedSubagentScope.mock.calls.length === 1)

    const deleting = stopSubagentRunsForDelete('USER-1', 'api-helper', { timeoutMs: 3_000, pollMs: 20 })
    openScope()
    const stop = await deleting
    stop.release()

    expect(stop.stopped).toBe(1)
    expect(isSubagentDeletedError(await call)).toBe(true)
    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
  })

  it('a delete stops a call that queues behind another call to the same Subagent', async () => {
    const holder = await acquireSubagentRunLock({
      sessionId: 'session-1',
      slug: resolveSubagentSlug(apiSubagent()),
      subagentLabel: 'API Helper',
      ttlMs: 60_000,
      waitBudgetMs: 0,
    })

    const call = run({ chatInput: 'Wait for my turn.' }).catch((error) => error)
    await until(() => hasRunningSubagentRun('USER-1', 'api-helper'))
    await new Promise((resolve) => setTimeout(resolve, 30))

    const stop = await stopSubagentRunsForDelete('USER-1', 'api-helper', { timeoutMs: 3_000, pollMs: 20 })
    stop.release()
    await releaseSubagentRunLock(holder)

    expect(stop.stopped).toBe(1)
    expect(isSubagentDeletedError(await call)).toBe(true)
    expect(threadRunnerMocks.processNativeMode).not.toHaveBeenCalled()
  })
})
