// @vitest-environment node
/**
 * SA-139 P2 Part 3: API Subagents and Workers on the Claude plan connection. The actual delegated
 * runner, the actual `VercelAIBrain`, the actual AI SDK loop and the Claude Code test double
 * (`fixtures/claude-plan/fake-claude.mjs`, through `BATSHIT_CLAUDE_CLI_PATH`); only live readiness
 * is faked. No model call is made.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.mock('$lib/server/services/systemSlashCommands', async importOriginal => {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return importOriginal()
  const { assertInitializedBuiltinPlugin } = await import('$lib/test-utils/initialized-builtin-plugin')
  const { redis } = await import('$lib/server/redis')
  // The built-in slash-command sync writes through a Lua script the default-lane fake lacks; it is
  // not what this file proves.
  return { ...(await importOriginal<typeof import('$lib/server/services/systemSlashCommands')>()), assertInitializedBuiltinPlugin: (userId: string) => assertInitializedBuiltinPlugin(redis, userId), ensureSystemSlashCommands: async () => undefined }
})
vi.mock('../claudePlanReadiness', () => ({ readClaudePlanReadiness: vi.fn(async () => ({ state: 'ready' })) }))

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'
import { buildDynamicOnlySelectionResetKey } from '$lib/server/services/mcpRuntimePolicy'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_SERVICE } from '$lib/utils/claudePlanConnection'
import { VercelAIBrain } from '../vercelBrain'
import { executeManagedSubagent } from '../subagentRunner'
import { listClaudePlanRuns, resetClaudePlanRunRegistryForTests } from '../claudePlanRunRegistry'
import { ClaudePlanRun } from '../claudePlanRun'

useRedisTestServer()
const FAKE = path.resolve(__dirname, 'fixtures/claude-plan/fake-claude.mjs')
const USER = 'sa139-delegate-user', SESSION = 'sa139-delegate-session', PARENT = 'sa139-delegate-parent', PRESET = 'sa139-delegate-preset', SUB = 'sa139-delegate-sub'
const CONNECTION = { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: CLAUDE_PLAN_SERVICE }
let project: string, subagent: any, requests: any[], started: ClaudePlanRun[]
const originalProjectPreferences = (redis as any).getProjectPreferences

beforeEach(async () => {
  vi.stubEnv('BATSHIT_CLAUDE_CLI_PATH', FAKE)
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') {
    vi.spyOn(ArtifactsService.prototype as any, 'client').mockImplementation(() => redis.execute(async client => client))
    for (const [key, value] of initializedBuiltinPluginEntries(USER)) await redis.json.set(key, '$', value)
    // Declared post-startup input on this same reset fake store, before actors.
    // This lane does not simulate or acknowledge the production reset's Lua.
    await redis.execute(client => client.set(buildDynamicOnlySelectionResetKey(USER), '2026-10-27T00:00:00.000Z'))
  }
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa139-delegate-')))
  writeFileSync(path.join(project, 'scenario.json'), JSON.stringify({ turns: [{ blocks: [{ type: 'text', text: 'Completed delegated fixture.' }] }] }))
  requests = []
  started = []
  const start = ClaudePlanRun.prototype.start
  vi.spyOn(ClaudePlanRun.prototype, 'start').mockImplementation(function(this: ClaudePlanRun, input) { started.push(this); return start.call(this, input) })
  vi.spyOn(VercelAIBrain.prototype as any, 'buildToolsForMode3').mockResolvedValue({ tools: {}, maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null })
  const processNative = VercelAIBrain.prototype.processNativeMode
  vi.spyOn(VercelAIBrain.prototype, 'processNativeMode').mockImplementation(function(this: VercelAIBrain, request) { requests.push(request); return processNative.call(this, request) })
  await redis.set('batshit:sub_system_prompt', 'Fixture delegated identity.')
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: CLAUDE_PLAN_SERVICE, modelId: 'claude-haiku-5-5', effectiveModelId: 'claude-haiku-5-5', connection: CONNECTION, settings: {} })
  await redis.execute(client => client.sAdd(`user:${USER}:models`, PRESET))
  await redis.createAgent({ id: PARENT, user_id: USER, name: 'Parent', agentType: 'api', primary_model_preset_id: PRESET } as any)
  await redis.createSession({ id: SESSION, user_id: USER, title: 'Fixture delegation', agent_id: PARENT } as any)
  subagent = { id: SUB, user_id: USER, displayName: 'Plan Fixture', slug: 'plan_fixture', subagentType: 'api', primary_model_provider: CLAUDE_PLAN_SERVICE, primary_model_name: 'claude-haiku-5-5', primary_model_preset_id: PRESET, primary_model_connection: CONNECTION, defaultMCPGateways: [], defaultMCPToolSelections: [], defaultTools: [], provider_specific_settings: { nativeTools: { bashEnabled: false } }, skills_commands: [] }
  await redis.set(`subagent:${SUB}`, subagent)
  // Claude Code's working folder is the Default Project Directory (no chat project here, so the
  // runner scans no project skill sources).
  ;(redis as any).getProjectPreferences = vi.fn(async (userId: string) => userId === USER ? { user_id: USER, default_workspace_path: project } : null)
})

afterEach(async () => {
  await Promise.all(listClaudePlanRuns().map(run => run.settled))
  resetClaudePlanRunRegistryForTests()
  ;(redis as any).getProjectPreferences = originalProjectPreferences
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(project, { recursive: true, force: true })
})

const run = (extra = {}) => executeManagedSubagent({ userId: USER, sessionId: SESSION, parentAgentId: PARENT, chatInput: 'Delegate fixture task.', subagent, ...extra } as any)

describe('SA-139 P2 Part 3: delegated runs on the Claude plan connection', () => {
  it('an API Subagent runs as consumer subagent, records provider claude-plan, and its run ends with it', async () => {
    const result = await run()
    expect(result.status, result.output).toBe('completed')
    expect(result.output).toContain('Completed delegated fixture.')
    expect(result.provider).toBe(CLAUDE_PLAN_SERVICE)
    expect(requests[0]).toMatchObject({ claudePlanConsumer: 'subagent', claudePlanSampling: null, processOwner: { userId: USER, kind: 'subagent', id: SUB }, agentId: PARENT, toolApprovalMode: 'off' })
    // The one Claude Code run of this delegation: owned by the PARENT (agent delete sweeps it), ended, exited.
    expect(started).toHaveLength(1)
    expect(started[0].owner).toMatchObject({ userId: USER, sessionId: SESSION, agentId: PARENT, kind: 'delegated' })
    expect(started[0].isEnded).toBe(true)
    expect(await started[0].settled).toBe('exited')
  })

  it('a Worker runs as consumer worker under the parent\'s process owner', async () => {
    const result = await run({ delegationKind: 'worker', delegationSlug: 'worker_fixture', workerRole: 'Fixture worker' })
    expect(result.status, result.output).toBe('completed')
    expect(result.provider).toBe(CLAUDE_PLAN_SERVICE)
    expect(requests[0]).toMatchObject({ claudePlanConsumer: 'worker', processOwner: { userId: USER, kind: 'agent', id: PARENT } })
  })

  it('a refusal (Claude Code not ready) reaches the parent as a failed run with its own words, provider claude-plan', async () => {
    const { readClaudePlanReadiness } = await import('../claudePlanReadiness')
    vi.mocked(readClaudePlanReadiness).mockResolvedValueOnce({ state: 'unavailable', code: 'signed_out', reason: 'Claude Code is not signed in.' } as any)
    const result = await run()
    expect(result.status).toBe('failed')
    expect(result.output).toContain('Claude Code is not signed in.')
    expect(result.provider).toBe(CLAUDE_PLAN_SERVICE)
    expect(listClaudePlanRuns()).toEqual([])
  })
})
