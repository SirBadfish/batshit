import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { CliContextWindowReport } from '$lib/utils/cliContextWindow'

useRedisTestServer()

type Execute = (operation: (client: any) => Promise<unknown>) => Promise<unknown>

const pristineExecute: Execute = vi.isMockFunction(redis.execute)
  ? (vi.mocked(redis.execute).getMockImplementation() as unknown as Execute)
  : (redis.execute.bind(redis) as unknown as Execute)

const SESSION = 'cli-context-read-session'
const KEY = `session:${SESSION}:execution_log`
const REPORT_PATHS = Array.from({ length: 10 }, (_, index) => [
  `$[${index}].agentId`,
  `$[${index}].createdAt`,
  `$[${index}].runtime.runtimeId`,
  `$[${index}].runtime.metadata.cliContextWindow`
]).flat()

let getCliContextSnapshots: (sessionId: string) => Promise<any[]>
let readCliContextReport: (
  sessionId: string,
  agentId: string,
  runtime: 'codex' | 'claude'
) => Promise<{ report: CliContextWindowReport | null; warning: string | null }>
let resolveAgentBudgetSettings: (agent: Record<string, any>, sessionId?: string) => Promise<{
  contextLimit: number | null
  contextWindowWarning?: string | null
  maxOutputTokens: number | null
  reasoningModel: boolean
}>
let stopCapturedJsonReads: (() => void) | null = null

beforeAll(async () => {
  const { executionViewerService } = await import('../executionViewerService')
  getCliContextSnapshots = executionViewerService.getCliContextSnapshots.bind(executionViewerService)
  ;({ readCliContextReport } = await import('../cliContextReportLookup'))
  ;({ resolveAgentBudgetSettings } = await import('../contextTokenPreview'))
})

beforeEach(() => {
  vi.restoreAllMocks()
  for (const key of ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(key, '')
})

afterEach(() => {
  stopCapturedJsonReads?.()
  stopCapturedJsonReads = null
  stopFailingRedisJsonGets()
  vi.unstubAllEnvs()
})

function captureJsonGetOptions() {
  const calls: Array<{ key: string; options: unknown[] }> = []
  const spy = vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
    pristineExecute(async (client: any) => {
      const target = client.json
      const json = new Proxy({}, {
        get(_empty, property) {
          const value = Reflect.get(target, property)
          if (property === 'get') {
            return async (key: string, ...options: unknown[]) => {
              calls.push({ key, options })
              return value.call(target, key, ...options)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const wrapped = new Proxy({}, {
        get(_empty, property) {
          if (property === 'json') return json
          const value = Reflect.get(client, property)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })
      return operation(wrapped)
    })) as typeof redis.execute)
  return { calls, stop: () => spy.mockImplementation(pristineExecute as never) }
}

function report(runtime: 'codex' | 'claude', contextWindow: number): CliContextWindowReport {
  return {
    runtime,
    model: runtime === 'codex' ? 'gpt-5.5' : 'sonnet',
    actualModel: runtime === 'codex' ? 'gpt-5.5' : 'claude-sonnet-5',
    contextWindow,
    evidence: 'runtime'
  }
}

function snapshot(options: {
  id: string
  agentId: string
  createdAt: string
  runtimeId: 'codex' | 'claude'
  report?: CliContextWindowReport
}) {
  return {
    id: options.id,
    sessionId: SESSION,
    userId: 'cli-context-read-user',
    agentId: options.agentId,
    agentName: 'Context reader fixture',
    agentType: 'cli',
    createdAt: options.createdAt,
    structuredInput: { messages: [{ role: 'user', content: 'FULL PROMPT SHOULD NOT BE READ' }] },
    compiledMessages: [{ role: 'user', content: 'FULL COMPILED PROMPT SHOULD NOT BE READ' }],
    intermediateSteps: [{ toolName: 'bash', input: { command: 'private command' } }],
    responseSummary: { text: 'full response should not be read' },
    llmCalls: [{ requestBody: { prompt: 'private model call' } }],
    runtime: {
      runtimeId: options.runtimeId,
      eventLog: [{ type: 'private runtime event' }],
      metadata: options.report ? { cliContextWindow: options.report } : {}
    }
  }
}

describe('Execution Viewer CLI context projection (BL-992)', () => {
  it('reads only the four allowlisted fields at each of the ten bounded array positions', async () => {
    const entries = Array.from({ length: 10 }, (_, index) => snapshot({
      id: `run-${index}`,
      agentId: index % 2 === 0 ? 'agent-codex' : 'agent-other',
      createdAt: new Date(Date.UTC(2026, 8, 29, 12, 0, 0 - index)).toISOString(),
      runtimeId: index % 2 === 0 ? 'codex' : 'claude',
      ...(index === 0 ? { report: report('codex', 1_000_000) } : {})
    }))
    await redis.set(KEY, entries as any)
    const capture = captureJsonGetOptions()
    stopCapturedJsonReads = capture.stop

    const snapshots = await getCliContextSnapshots(SESSION)

    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]?.key).toBe(KEY)
    expect(capture.calls[0]?.options).toEqual([{ path: REPORT_PATHS }])
    expect(REPORT_PATHS).toHaveLength(40)
    expect(REPORT_PATHS).not.toContain('$')
    expect(snapshots).toHaveLength(10)
    expect(snapshots[0]).toEqual({
      agentId: 'agent-codex',
      createdAt: entries[0]?.createdAt,
      runtime: {
        runtimeId: 'codex',
        metadata: { cliContextWindow: report('codex', 1_000_000) }
      }
    })
    expect(JSON.stringify(snapshots)).not.toContain('FULL PROMPT')
    expect(JSON.stringify(snapshots)).not.toContain('private runtime event')
  })

  it('associates projected reports only with the newest matching agent and runtime snapshot', async () => {
    await redis.set(KEY, [
      snapshot({ id: 'new-claude-other', agentId: 'agent-other', createdAt: '2026-09-29T12:03:00.000Z', runtimeId: 'claude', report: report('claude', 200_000) }),
      snapshot({ id: 'new-codex', agentId: 'agent-codex', createdAt: '2026-09-29T12:02:00.000Z', runtimeId: 'codex' }),
      snapshot({ id: 'old-codex', agentId: 'agent-codex', createdAt: '2026-09-29T12:01:00.000Z', runtimeId: 'codex', report: report('codex', 1_000_000) }),
      snapshot({ id: 'new-claude', agentId: 'agent-codex', createdAt: '2026-09-29T12:00:00.000Z', runtimeId: 'claude', report: report('claude', 200_000) })
    ] as any)

    await expect(readCliContextReport(SESSION, 'agent-codex', 'codex')).resolves.toMatchObject({
      report: null,
      warning: null
    })
    await expect(readCliContextReport(SESSION, 'agent-codex', 'claude')).resolves.toMatchObject({
      report: report('claude', 200_000),
      warning: null
    })
    await expect(readCliContextReport(SESSION, 'agent-other', 'claude')).resolves.toMatchObject({
      report: report('claude', 200_000),
      warning: null
    })
  })

  it('distinguishes a missing execution log from a failed Redis read', async () => {
    await expect(readCliContextReport('missing-cli-context-log', 'agent-codex', 'codex')).resolves.toMatchObject({
      report: null,
      warning: null
    })

    await redis.set(KEY, [snapshot({
      id: 'run-failed-read',
      agentId: 'agent-codex',
      createdAt: '2026-09-29T12:00:00.000Z',
      runtimeId: 'codex',
      report: report('codex', 1_000_000)
    })] as any)
    const failing = failRedisJsonGets((key) => key === KEY)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(getCliContextSnapshots(SESSION)).rejects.toThrow('Redis read failed')
    await expect(readCliContextReport(SESSION, 'agent-codex', 'codex')).resolves.toMatchObject({
      report: null,
      warning: 'Could not read the saved CLI context limit. The context limit is unknown for this send.'
    })
    expect(failing.failures).toBe(2)
  })
})

describe.each([
  {
    runtime: 'claude' as const,
    provider: 'anthropic-claude-cli',
    model: 'sonnet',
    setting: { permissionMode: 'default', model: 'sonnet' },
    expectedChoice: 1_000_000
  },
  {
    runtime: 'codex' as const,
    provider: 'openai-codex',
    model: 'gpt-6-luna',
    setting: {
      permissionMode: 'agent_full',
      model: 'gpt-6-luna',
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: []
    },
    expectedChoice: 258_400
  }
])('$runtime context preview budget read (BL-992)', ({ runtime, provider, model, setting, expectedChoice }) => {
  const agent = () => ({
    id: `agent-${runtime}-context-read`,
    user_id: 'cli-context-read-user',
    agentType: 'cli',
    primary_model_provider: provider,
    primary_model_name: model,
    primary_model_preset_id: null,
    primary_model_max_tokens: 4096,
    primary_model_connection: {
      id: runtime === 'claude' ? 'claude-cli' : 'codex-cli',
      type: 'direct',
      service: provider
    },
    ...(runtime === 'claude' ? { claude_settings: setting } : { codex_settings: setting })
  })

  it('returns an unknown limit and visible warning when the saved report read fails', async () => {
    const failing = failRedisJsonGets((key) => key === KEY)

    const result = await resolveAgentBudgetSettings(agent() as any, SESSION)

    expect(result).toMatchObject({
      contextLimit: null,
      contextWindowWarning: 'Could not read the saved CLI context limit. The context limit is unknown for this send.',
      maxOutputTokens: 4096
    })
    expect(failing.failures).toBe(1)
  })

  it('keeps the verified model-choice limit when the execution log is absent', async () => {
    const result = await resolveAgentBudgetSettings(agent() as any, SESSION)

    expect(result.contextLimit).toBe(expectedChoice)
    expect(result.contextWindowWarning).toBeNull()
    expect(result.maxOutputTokens).toBe(4096)
  })

  if (runtime === 'claude') {
    it.each(['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'])('honors an explicitly configured cap through %s', async key => {
      vi.stubEnv(key, key === 'ANTHROPIC_BASE_URL' ? 'https://api.example.invalid' : '1')
      const result = await resolveAgentBudgetSettings(agent(), SESSION)
      expect(result.contextLimit).toBe(200_000)
      expect(result.contextWindowWarning).toBeNull()
      expect(result.maxOutputTokens).toBe(4096)
    })
  }
})
