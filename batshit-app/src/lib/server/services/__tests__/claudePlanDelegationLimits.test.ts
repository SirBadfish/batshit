// @vitest-environment node
/**
 * SA-139 P4 (D11, V9, the delegation qualification transferred from the 2026-10-24 delegation-limits
 * plan): the delegation limits hold when a Subagent or Worker runs on the Claude plan connection.
 * The actual delegated runner, `VercelAIBrain` loop, AI SDK, Worker batch tool and the plan's model and
 * run, on the Claude Code test double (`fixtures/claude-plan/fake-claude.mjs`, through
 * `BATSHIT_CLAUDE_CLI_PATH`). Replaced: live readiness, the tool builder (`buildToolsForMode3`: the
 * test's tools go through the real readable wrapper, and its input is recorded so no-nesting is read
 * from what the builder was really given), the project preferences, the built-in slash-command sync
 * and the artifacts client; the stall guard's ten minutes and the 10-second time-limit floor are
 * shortened so the checks run in seconds. No model call is made.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.mock('$lib/server/services/systemSlashCommands', async importOriginal => {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return importOriginal()
  const { assertInitializedBuiltinPlugin } = await import('$lib/test-utils/initialized-builtin-plugin')
  const { redis } = await import('$lib/server/redis')
  return { ...(await importOriginal<typeof import('$lib/server/services/systemSlashCommands')>()), assertInitializedBuiltinPlugin: (userId: string) => assertInitializedBuiltinPlugin(redis, userId), ensureSystemSlashCommands: async () => undefined }
})
vi.mock('../claudePlanReadiness', () => ({ readClaudePlanReadiness: vi.fn(async () => ({ state: 'ready' })) }))
// The stall guard's ten minutes, shortened; the rule itself is the runner's.
// Two seconds leaves room for a loaded machine's startup (no progress signal before Claude's first event).
const STALL_MS = 2000
vi.mock('../delegatedRunWatch', async importOriginal => ({ ...await importOriginal<typeof import('../delegatedRunWatch')>(), DELEGATED_RUN_STALL_MS: 2000 }))
// A Subagent's time limit is 10 s to 24 h; the shortest one reads as 1 second here.
vi.mock('$lib/utils/subagentTimeout', async importOriginal => {
  const original = await importOriginal<typeof import('$lib/utils/subagentTimeout')>()
  return { ...original, normalizeSubagentTimeoutSeconds: (value: unknown) => value === 10 ? 1 : original.normalizeSubagentTimeoutSeconds(value) }
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'
import { buildDynamicOnlySelectionResetKey } from '$lib/server/services/mcpRuntimePolicy'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_SERVICE } from '$lib/utils/claudePlanConnection'
import { WORKERS_MAX_CONCURRENT } from '$lib/utils/delegationCapabilities'
import { VercelAIBrain } from '../vercelBrain'
import { executeManagedSubagent } from '../subagentRunner'
import { spawnWorkers } from '../workerRunner'
import { __resetWorkerTurnBudgetForTests } from '../workerTurnBudget'
import { listClaudePlanRuns, resetClaudePlanRunRegistryForTests } from '../claudePlanRunRegistry'
import { ClaudePlanRun } from '../claudePlanRun'

useRedisTestServer()
const FAKE = path.resolve(__dirname, 'fixtures/claude-plan/fake-claude.mjs')
const USER = 'sa139-limits-user', SESSION = 'sa139-limits-session', PARENT = 'sa139-limits-parent', PRESET = 'sa139-limits-preset', SUB = 'sa139-limits-sub'
const CONNECTION = { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: CLAUDE_PLAN_SERVICE }
let project: string, subagent: any, requests: any[], started: ClaudePlanRun[], tools: Record<string, any>, builds: unknown[][]
const originalProjectPreferences = (redis as any).getProjectPreferences

const scenario = (turns: unknown[]) => writeFileSync(path.join(project, 'scenario.json'), JSON.stringify({ turns }))
const fakeLog = (): any[] => existsSync(path.join(project, 'fake-log.jsonl'))
  ? readFileSync(path.join(project, 'fake-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const modelCalls = () => fakeLog().filter(entry => entry.kind === 'model-call').length
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(async () => {
  vi.stubEnv('BATSHIT_CLAUDE_CLI_PATH', FAKE)
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') {
    vi.spyOn(ArtifactsService.prototype as any, 'client').mockImplementation(() => redis.execute(async client => client))
    for (const [key, value] of initializedBuiltinPluginEntries(USER)) await redis.json.set(key, '$', value)
    // Declared post-startup input on this same reset fake store, before actors.
    // This lane does not simulate or acknowledge the production reset's Lua.
    await redis.execute(client => client.set(buildDynamicOnlySelectionResetKey(USER), '2026-10-27T00:00:00.000Z'))
  }
  __resetWorkerTurnBudgetForTests()
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa139-limits-')))
  scenario([{ blocks: [{ type: 'text', text: 'Completed delegated fixture.' }] }])
  requests = []
  started = []
  tools = {}
  builds = []
  const start = ClaudePlanRun.prototype.start
  vi.spyOn(ClaudePlanRun.prototype, 'start').mockImplementation(function(this: ClaudePlanRun, input) { started.push(this); return start.call(this, input) })
  // The delegated run's tool list, through the REAL readable wrapper, as `buildToolsForMode3` builds it.
  vi.spyOn(VercelAIBrain.prototype as any, 'buildToolsForMode3').mockImplementation(async function(this: any, ...args: unknown[]) {
    builds.push(args)
    return {
      tools: Object.keys(tools).length ? this.wrapToolsWithReadableModelOutput(tools, { userId: USER, sessionId: SESSION, messageId: 'm1', agentId: PARENT }) : {},
      maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null
    }
  })
  const processNative = VercelAIBrain.prototype.processNativeMode
  vi.spyOn(VercelAIBrain.prototype, 'processNativeMode').mockImplementation(function(this: VercelAIBrain, request) { requests.push(request); return processNative.call(this, request) })
  await redis.set('batshit:sub_system_prompt', 'Fixture delegated identity.')
  await redis.set('batshit:worker_system_prompt', 'Fixture worker identity.')
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: CLAUDE_PLAN_SERVICE, modelId: 'claude-haiku-5-5', effectiveModelId: 'claude-haiku-5-5', connection: CONNECTION, settings: {} })
  await redis.execute(client => client.sAdd(`user:${USER}:models`, PRESET))
  await redis.createAgent({ id: PARENT, user_id: USER, name: 'Parent', agentType: 'api', primary_model_preset_id: PRESET } as any)
  await redis.createSession({ id: SESSION, user_id: USER, title: 'Fixture limits', agent_id: PARENT } as any)
  subagent = { id: SUB, user_id: USER, displayName: 'Plan Fixture', slug: 'plan_fixture', subagentType: 'api', primary_model_provider: CLAUDE_PLAN_SERVICE, primary_model_name: 'claude-haiku-5-5', primary_model_preset_id: PRESET, primary_model_connection: CONNECTION, defaultMCPGateways: [], defaultMCPToolSelections: [], defaultTools: [], provider_specific_settings: { nativeTools: { bashEnabled: false } }, skills_commands: [] }
  await redis.set(`subagent:${SUB}`, subagent)
  ;(redis as any).getProjectPreferences = vi.fn(async (userId: string) => userId === USER ? { user_id: USER, default_workspace_path: project } : null)
})

afterEach(async () => {
  await Promise.all(listClaudePlanRuns().map(run => run.settled))
  resetClaudePlanRunRegistryForTests()
  __resetWorkerTurnBudgetForTests()
  ;(redis as any).getProjectPreferences = originalProjectPreferences
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(project, { recursive: true, force: true })
})

const run = (extra: Record<string, unknown> = {}) => executeManagedSubagent({ userId: USER, sessionId: SESSION, parentAgentId: PARENT, chatInput: 'Delegate fixture task.', subagent, ...extra } as any)
const slowTool = (ms: number, calls: string[] = []) => tool({ description: 'Build the project.', inputSchema: z.object({ target: z.string() }),
  execute: async ({ target }) => { calls.push(target); await sleep(ms); return `built ${target}` } })
async function endedAndExited(run: ClaudePlanRun) {
  await vi.waitFor(() => expect(run.isEnded).toBe(true), { timeout: 5000 })
  expect(await run.settled).toBe('exited')
}

describe('SA-139 P4: delegation limits on the Claude plan connection', () => {
  it('Stop during a model call ends the Subagent call and its Claude Code run', async () => {
    scenario([{ stallMs: 20_000, blocks: [{ type: 'text', text: 'never' }] }])
    const stop = new AbortController()
    const outcome = run({ abortSignal: stop.signal }).then(result => result, error => error)
    await vi.waitFor(() => expect(modelCalls()).toBe(1), { timeout: 10_000 })
    const at = Date.now()
    stop.abort(new Error('User pressed Stop'))
    const result = await outcome
    expect(Date.now() - at).toBeLessThan(5000)
    // The caller's Stop ends the call with the runner's own cancellation, as on any API lane.
    expect(result.name).toBe('SubagentCallCancelledError')
    await endedAndExited(started[0])
  }, 30_000)

  it('Stop during a long authorized tool call ends the call and its run', async () => {
    const calls: string[] = []
    tools = { build: slowTool(20_000, calls) }
    scenario([
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__build', input: { target: 'app' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ])
    const stop = new AbortController()
    const outcome = run({ abortSignal: stop.signal }).then(result => result, error => error)
    await vi.waitFor(() => expect(calls).toEqual(['app']), { timeout: 10_000 })
    const at = Date.now()
    stop.abort(new Error('User pressed Stop'))
    const result = await outcome
    expect(Date.now() - at).toBeLessThan(5000)
    expect(result.name).toBe('SubagentCallCancelledError')
    await endedAndExited(started[0])
  }, 30_000)

  it('the stall guard stops a run that is silent mid-call and says why; usage is unknown, never zero', async () => {
    scenario([{ stallMs: 20_000, blocks: [{ type: 'text', text: 'never' }] }])
    const at = Date.now()
    const result = await run()
    expect(Date.now() - at).toBeLessThan(15_000)
    expect(modelCalls()).toBe(1)
    expect(result.status).toBe('timed_out')
    expect(result.output).toMatch(/showed no progress for .*so Batshit stopped it/)
    expect(result.provider).toBe(CLAUDE_PLAN_SERVICE)
    expect(result.intermediateSteps ?? []).toEqual([])
    expect(result.usage).toBeNull()
    await endedAndExited(started[0])
  }, 30_000)

  it('time inside a long authorized tool call is not silence', async () => {
    const calls: string[] = []
    tools = { build: slowTool(STALL_MS * 3, calls) }
    scenario([
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__build', input: { target: 'app' } }] },
      { blocks: [{ type: 'text', text: 'Build finished.' }] }
    ])
    const result = await run()
    expect(result.status, result.output).toBe('completed')
    expect(result.output).toContain('Build finished.')
    expect(calls).toEqual(['app'])
    await endedAndExited(started[0])
  }, 30_000)

  it('a set time limit ends the run with an honest timed-out result; usage is unknown, never zero', async () => {
    subagent = { ...subagent, timeout_seconds: 10 }
    const calls: string[] = []
    tools = { build: slowTool(20_000, calls) }
    scenario([
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__build', input: { target: 'app' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ])
    const at = Date.now()
    const result = await run()
    expect(Date.now() - at).toBeLessThan(10_000)
    expect(result.status).toBe('timed_out')
    expect(result.output).toMatch(/did not return a complete result within its time limit of 1 second/)
    // The limit fired while the authorized tool call was running.
    expect(calls).toEqual(['app'])
    expect(result.usage).toBeNull()
    await endedAndExited(started[0])
  }, 30_000)

  it('a set tool-step limit returns the work so far, marked partial, and ends the run', async () => {
    subagent = { ...subagent, max_tool_steps: 1 }
    const calls: string[] = []
    tools = { build: slowTool(10, calls) }
    scenario([
      { blocks: [{ type: 'text', text: 'Building app first.' }, { type: 'tool_use', name: 'mcp__batshit__build', input: { target: 'app' } }] },
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__build', input: { target: 'docs' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ])
    const result = await run()
    expect(calls).toEqual(['app'])
    expect(result.status).toBe('partial')
    expect(result.output).toMatch(/^\[Partial result: Plan Fixture reached its limit of 1 tool step before it finished/)
    expect(result.output).toContain('Building app first.')
    expect(result.intermediateSteps).toMatchObject([{ toolName: 'build', toolOutput: 'built app' }])
    // Accounting: the delegated run's usage is Claude Code's own (input 3 + cache 100 + 50, output 42), provider claude-plan.
    expect(result.provider).toBe(CLAUDE_PLAN_SERVICE)
    expect(result.usage).toMatchObject({ inputTokens: 153, outputTokens: 42, cachedInputTokens: 50 })
    await endedAndExited(started[0])
    expect(modelCalls()).toBe(1)
  }, 30_000)

  it('BL-2356: a Claude plan Subagent cut at its output limit returns its words so far, marked partial, and its run ends', async () => {
    scenario([{ stop_reason: 'max_tokens', blocks: [{ type: 'text', text: 'Half an answ' }] }])
    const result = await run()
    expect(result.status).toBe('partial')
    expect(result.output).toMatch(/^\[Partial result: Plan Fixture stopped at its model's output limit before it finished, so its last words may be cut off\./)
    expect(result.output).toContain('Half an answ')
    await endedAndExited(started[0])
    expect(modelCalls()).toBe(1)
  }, 30_000)

  it('a completed run whose Claude Code reported no usage records usage as unknown, never zero', async () => {
    writeFileSync(path.join(project, 'scenario.json'), JSON.stringify({ noUsage: true, turns: [{ blocks: [{ type: 'text', text: 'Done without counts.' }] }] }))
    const result = await run()
    expect(result.status, result.output).toBe('completed')
    expect(result.output).toContain('Done without counts.')
    // Through the AI SDK's step sums and the loop's usage normalizer: no count, never a zero.
    expect(result.usage ?? null).toBeNull()
    await endedAndExited(started[0])
  }, 30_000)

  const parent = () => ({ userId: USER, sessionId: SESSION, parentAgentId: PARENT, parentMessageId: 'sa139-limits-msg', projectPath: project, lane: 'api' as const,
    parentModelId: 'claude-haiku-5-5', parentConnection: CONNECTION as any, providerSettings: {}, selectedGateways: [], toolSelections: null, selectedCliToolIds: [],
    defaultGateways: [], dcmDisplaySettings: null, assignedSubagents: [subagent] })

  it(`runs ${WORKERS_MAX_CONCURRENT} Workers at once, each on its own Claude Code run, and refuses another while they run`, async () => {
    // Each Worker is silent for half the (shortened) stall window, so all of them are running together.
    scenario([{ stallMs: STALL_MS / 2, blocks: [{ type: 'text', text: 'Worker done.' }] }])
    const batch = spawnWorkers({ parent: parent(), workers: Array.from({ length: WORKERS_MAX_CONCURRENT }, (_, i) => ({ task: `Task ${i + 1}` })) })
    await vi.waitFor(() => expect(started).toHaveLength(WORKERS_MAX_CONCURRENT), { timeout: 10_000 })
    // All six are running at the same moment, on six separate runs.
    expect(new Set(started).size).toBe(WORKERS_MAX_CONCURRENT)
    expect(started.every(worker => !worker.isEnded)).toBe(true)
    const another = await spawnWorkers({ parent: parent(), workers: [{ task: 'One more' }] })
    expect(another.success).toBe(false)
    expect(another.message).toMatch(new RegExp(`${WORKERS_MAX_CONCURRENT} at a time`))
    expect(started).toHaveLength(WORKERS_MAX_CONCURRENT)
    const done = await batch
    expect(done.success, JSON.stringify(done)).toBe(true)
    expect(done.workers.map((worker: any) => worker.status)).toEqual(Array(WORKERS_MAX_CONCURRENT).fill('completed'))
    for (const worker of started) await endedAndExited(worker)
    expect(requests).toHaveLength(WORKERS_MAX_CONCURRENT)
    expect(requests.every(request => request.claudePlanConsumer === 'worker')).toBe(true)
    const pids = new Set(fakeLog().filter(entry => entry.kind === 'start').map(entry => entry.pid))
    expect(pids.size).toBe(WORKERS_MAX_CONCURRENT)
  }, 60_000)

  it('a base Worker started through the batch tool runs on its Subagent\'s Claude plan model', async () => {
    const done = await spawnWorkers({ parent: parent(), workers: [{ task: 'Check the build', base: 'plan_fixture' }] })
    expect(done.success, JSON.stringify(done)).toBe(true)
    expect(done.workers.map((worker: any) => worker.status)).toEqual(['completed'])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ claudePlanConsumer: 'worker', connection: { id: CLAUDE_PLAN_CONNECTION_ID } })
    expect(started).toHaveLength(1)
    await endedAndExited(started[0])
  }, 30_000)

  it('no nesting: the tool builder is never asked for a Worker tool or assigned Subagents on a delegated run', async () => {
    tools = { build: slowTool(10) }
    await run()
    await run({ delegationKind: 'worker', delegationSlug: 'worker_fixture', workerRole: 'Fixture worker' })
    await spawnWorkers({ parent: parent(), workers: [{ task: 'Built-in' }, { task: 'Based', base: 'plan_fixture' }] })
    expect(requests).toHaveLength(4)
    for (const request of requests) expect(request.workersEnabled).not.toBe(true)
    expect(builds).toHaveLength(4)
    for (const args of builds) {
      const native = args.find((arg): arg is Record<string, unknown> => !!arg && typeof arg === 'object' && 'workersEnabled' in arg)
      expect(native, 'the builder gets the native context that decides the Worker tool').toBeDefined()
      expect(native!.workersEnabled).not.toBe(true)
      const agentContext = args.find((arg): arg is Record<string, unknown> => !!arg && typeof arg === 'object' && 'assignedSubagents' in arg)
      expect(agentContext, 'the builder gets the agent context that decides Subagent tools').toBeDefined()
      expect((agentContext!.assignedSubagents as unknown[] | null | undefined) ?? []).toEqual([])
    }
    // Claude Code lists exactly the tools Batshit prepared, nothing more.
    const listed = fakeLog().filter(entry => entry.kind === 'tools').map(entry => entry.tools.map((listedTool: any) => listedTool.name))
    expect(listed).toHaveLength(4)
    for (const names of listed) expect(names).toEqual(['build'])
  }, 60_000)
})
