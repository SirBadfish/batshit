import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'

/**
 * BL-158 (Josh's option A) + BL-268 — a managed CLI run whose saved model Batshit's list no
 * longer offers stops before the CLI starts, with a Batshit message that names the agent or
 * Subagent and the setting to change, instead of the CLI's raw 400. A model id Batshit never
 * listed is never refused.
 *
 * Josh's real Subagent `codex_cli_subagent` kept `gpt-5.4` after it left the list on
 * 2026-09-06, and every call to it failed with Codex's "The 'gpt-5.4' model is not supported
 * when using Codex with a ChatGPT account".
 */

/**
 * A run that is not refused goes on to make its managed home, so `node:os` answers a throwaway
 * home (the BL-160 pattern) and nothing lands in the real `~/.batshit/agents`.
 */
const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!testHome.current) throw new Error('cliRetiredModelRun.test: no temporary home is set')
    return testHome.current
  }
  return { ...real, homedir, default: { ...real, homedir } }
})

const records = vi.hoisted(() => new Map<string, unknown>())
const sessionWrites = vi.hoisted(() => [] as string[])

vi.mock('$env/dynamic/private', () => ({
  env: { BATSHIT_CODEX_PROVIDER_ENABLED: 'true', BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true', BATSHIT_TOKEN: '' }
}))
vi.mock('$lib/server/redis', async () => {
  // BL-1371: the gateway registry is read with the facade's raw compare-and-set read.
  const { createJsonCompareAndWriteTwinsForMap } = await import('$lib/test-utils/redisJsonCompareAndWriteTwin')
  const client = {
    json: { get: vi.fn(async (key: string) => records.get(key) ?? null) },
    sAdd: vi.fn(async (key: string) => {
      sessionWrites.push(key)
      return 1
    }),
    sRem: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    del: vi.fn(async () => 1)
  }
  return {
    redis: {
      execute: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
      json: {
        get: vi.fn(async (key: string) => records.get(key) ?? null),
        ...createJsonCompareAndWriteTwinsForMap(records)
      },
      get: vi.fn(async (key: string) => records.get(key) ?? null),
      getAgents: vi.fn(async () => []),
      getProjectPreferences: vi.fn(async () => null),
      getProjects: vi.fn(async () => []),
      getUserSettings: vi.fn(async () => null)
    }
  }
})
// A run's credential is minted in Redis; these runs only need the bridge to carry one.
vi.mock('$lib/server/services/cliHelperToken', () => ({
  mintCliRunCredential: vi.fn(async (options: { agentId: string }) => ({
    credentialId: 'arc_zccli',
    token: 'arc_zccli.bsac_secret',
    agentId: options.agentId
  }))
}))
vi.mock('$lib/server/services/agentRunCredentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/agentRunCredentials')>()),
  revokeRunCredential: vi.fn(async () => undefined)
}))
const detectCodex = vi.hoisted(() =>
  vi.fn(async () => ({ available: false, error: 'zccli: the stand-in Codex is not installed' }))
)
vi.mock('$lib/server/services/codexCliStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/codexCliStatus')>()),
  detectCodexCliStatus: detectCodex
}))
const detectClaude = vi.hoisted(() =>
  vi.fn(async () => ({ available: false, error: 'zccli: the stand-in Claude is not installed' }))
)
vi.mock('$lib/server/services/claudeCliStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/claudeCliStatus')>()),
  detectClaudeCliStatus: detectClaude
}))
// A Claude model that left the list, so the Claude half of the rule has something to refuse.
vi.mock('$lib/data/claude-cli-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/data/claude-cli-models')>()
  const retired = [{ value: 'claude-zccli-retired', label: 'Claude Zccli Retired', leftOn: '2026-09-27' }]
  return {
    ...actual,
    CLAUDE_CLI_RETIRED_MODELS: retired,
    findRetiredClaudeCliModel: (model: string | null | undefined) =>
      retired.find((entry) => entry.value === (typeof model === 'string' ? model.trim() : '')) ?? null
  }
})

const originalHome = process.env.HOME
let realAgentsRoot = ''
let CodexBridge: typeof import('../codexBridge').CodexBridge
let ClaudeBridge: typeof import('../claudeBridge').ClaudeBridge
const leakedIntoRealHome = async () =>
  (await readdir(realAgentsRoot).catch(() => [] as string[])).filter((entry) => entry.includes('zccli'))

beforeAll(async () => {
  const realOs = await vi.importActual<typeof import('node:os')>('node:os')
  realAgentsRoot = path.join(realOs.homedir(), '.batshit', 'agents')
  expect(await leakedIntoRealHome()).toEqual([])
  testHome.current = await realpath(await mkdtemp(path.join(realOs.tmpdir(), 'zccli-bl158-')))
  process.env.HOME = testHome.current
  // BL-1033: cold bridge setup belongs outside each refusal case's five-second budget.
  ;({ CodexBridge } = await import('../codexBridge'))
  ;({ ClaudeBridge } = await import('../claudeBridge'))
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  const home = testHome.current
  testHome.current = ''
  if (home) await rm(home, { recursive: true, force: true })
  // Safety net: these runs never make a profile folder in the real home.
  expect(await leakedIntoRealHome()).toEqual([])
})

beforeEach(() => {
  records.clear()
  sessionWrites.length = 0
  detectCodex.mockClear()
  detectClaude.mockClear()
  records.set('agent:zccli-codex', { id: 'zccli-codex', displayName: 'Zccli Codex', user_id: 'josh' })
  records.set('agent:zccli-claude', { id: 'zccli-claude', displayName: 'Zccli Claude', user_id: 'josh' })
  records.set('subagent:codex_cli_subagent', { id: 'codex_cli_subagent', displayName: 'Codex CLI Subagent', user_id: 'josh' })
})
afterEach(() => {
  vi.restoreAllMocks()
})

function codexRequest(model: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: 'josh',
    agentId: 'zccli-codex',
    sessionId: 'zccli-session',
    messages: [
      { role: 'system', content: 'You are the zccli probe.' },
      { role: 'user', content: 'hello' }
    ],
    codexSettings: { model, configScope: 'managed', permissionMode: 'chat', sandbox: 'read-only' },
    ...overrides
  } as any
}

describe('BL-158: a Codex run with a model Batshit no longer lists', () => {
  it("stops before Codex starts, naming the agent and the setting (Josh's gpt-5.4 case)", async () => {
    const failure = await new CodexBridge().streamNativeMode(codexRequest('gpt-5.4')).catch((error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.code).toBe('CLI_MODEL_RETIRED')
    expect(failure.status).toBe(422)
    expect(failure.message).toContain('Zccli Codex')
    expect(failure.message).toContain('GPT-5.4')
    expect(failure.message).toContain('Default Codex Model')
    expect(failure.message).not.toMatch(/not supported when using Codex/)
    // Nothing of the run was started: no CLI check, no session entry.
    expect(detectCodex).not.toHaveBeenCalled()
    expect(sessionWrites).toEqual([])
  })

  it('names the Subagent whose setting it is, for a Subagent run', async () => {
    const failure = await new CodexBridge()
      .streamNativeMode(
        codexRequest('gpt-5.4', {
          agentId: 'subagent_cli_codex_cli_subagent',
          delegatedRun: true,
          processOwner: { userId: 'josh', kind: 'subagent', id: 'codex_cli_subagent' },
          scopeAgentId: 'codex_cli_subagent',
          codexSettings: {
            model: 'gpt-5.4',
            configScope: 'managed',
            permissionMode: 'chat',
            sandbox: 'read-only',
            profileId: 'batshit_agent_subagent_cli_codex_cli_subagent'
          }
        })
      )
      .catch((error) => error)

    expect(failure.code).toBe('CLI_MODEL_RETIRED')
    expect(failure.message).toContain('Subagent Codex CLI Subagent')
    expect(failure.message).toContain('Default Codex Model')
    expect(detectCodex).not.toHaveBeenCalled()
  })

  it("stops the hidden compact worker too, which runs the agent's own model", async () => {
    const failure = await new CodexBridge()
      .generateHiddenText({
        prompt: 'Summarize.',
        userId: 'josh',
        agentId: 'zccli-codex',
        codexSettings: { model: 'gpt-5.4' } as any
      })
      .catch((error) => error)
    expect(failure.code).toBe('CLI_MODEL_RETIRED')
    expect(failure.message).toContain('Zccli Codex')
    expect(detectCodex).not.toHaveBeenCalled()
  })

  it('never refuses a model id Batshit never listed (it may be typed on purpose), nor a listed one', async () => {
    for (const model of ['gpt-7-zccli-typed-by-hand', 'gpt-6-astra']) {
      const failure = await new CodexBridge().streamNativeMode(codexRequest(model)).catch((error) => error)
      // It went on to start Codex, which the stand-in reports as missing.
      expect(failure?.code, model).not.toBe('CLI_MODEL_RETIRED')
      expect(String(failure?.message ?? ''), model).toContain('zccli: the stand-in Codex is not installed')
    }
  })
})

describe("BL-268: Codex's own refusal of a model its version cannot run", () => {
  it('says which Codex Batshit ran and how to get the one it installs', async () => {
    const bridge = new CodexBridge()
    const refusal =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}'
    vi.spyOn(bridge as any, 'createRunner').mockResolvedValue({
      transport: 'app-server',
      cli: { version: 'codex-cli 0.139.0', source: 'path' },
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'zccli-thread' }
        yield { type: 'turn.started' }
        yield { type: 'turn.failed', error: { message: refusal } }
      })()
    })

    const result: any = await bridge.streamNativeMode(codexRequest('gpt-6-astra'))
    let failure: any = null
    try {
      for await (const _chunk of result.stream) {
        // drain until the turn fails
      }
    } catch (error) {
      failure = error
    }

    expect(failure?.message).toContain("The 'gpt-6-astra' model requires a newer version of Codex")
    expect(failure?.message).toContain('codex-cli 0.139.0')
    expect(failure?.message).toContain("Install Batshit's own Codex")
  })
})

describe('BL-158: a Claude run with a model Batshit no longer lists', () => {
  it('stops before Claude Code starts, naming the agent and the setting', async () => {
    const failure = await new ClaudeBridge()
      .streamNativeMode({
        userId: 'josh',
        agentId: 'zccli-claude',
        sessionId: 'zccli-session',
        messages: [{ role: 'user', content: 'hello' }],
        claudeSettings: { model: 'claude-zccli-retired', permissionMode: 'default', configScope: 'global' }
      } as any)
      .catch((error) => error)

    expect(failure.code).toBe('CLI_MODEL_RETIRED')
    expect(failure.status).toBe(422)
    expect(failure.message).toContain('Zccli Claude')
    expect(failure.message).toContain('Claude Zccli Retired')
    expect(failure.message).toContain('Default Claude Model')
    expect(detectClaude).not.toHaveBeenCalled()
  })
})
