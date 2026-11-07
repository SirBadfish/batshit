import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { redis } from '$lib/server/redis'
import { buildAgentProfileId } from '$lib/server/services/managedProfileIdentity'
import { buildCliWorkerRuntimeId, normalizeSubagentSlugValue } from '$lib/utils/subagentSlug'

/**
 * SA-139 R4 add-on: the one-time sweep of retired-type records (`retiredTypeSweep.ts`). Real Redis
 * only: the sweep is Lua type checks, key scans and the two DELETE route handlers' own scripts,
 * which the default lane's fake does not model. Every retired family is seeded beside the live
 * records that must survive byte for byte, and beside the managed Claude Code install and a
 * Claude sign-in home on disk, which no Redis sweep may touch.
 */

// One home for the whole file, set before any module reads it: the profile folder delete keeps
// its root from the first load (`managedProfileFolderDelete.ts`).
const disk = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const names = ['BATSHIT_HOME_DIR', 'BATSHIT_AGENT_RUNTIME_ROOT', 'BATSHIT_MANAGED_INSTALLS_ROOT', 'CLAUDE_CONFIG_DIR'] as const
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  const home = mkdtempSync(join(tmpdir(), 'rts-home-'))
  const claudeHome = mkdtempSync(join(tmpdir(), 'rts-claude-home-'))
  process.env.BATSHIT_HOME_DIR = home
  delete process.env.BATSHIT_AGENT_RUNTIME_ROOT
  process.env.BATSHIT_MANAGED_INSTALLS_ROOT = join(home, 'installs')
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  return { home, claudeHome, saved }
})

const USER = 'user-retired-type-sweep'
const SERVER = 'http://batshit-server.test:5613'
const LIVE_CHAT = 'rts_live_chat'
const RETIRED_CHAT = 'rts_retired_chat'
const MODE4_PROMPT = 'batshit:batshit_mode4_system_prompt'

// Keep the ordinary real lane; use the existing strict admission for an explicitly allocated DB15.
if (process.env.BATSHIT_SKILL_COMMIT_REDIS_ADMISSION) useSkillSessionRedisTestServer()
else useRedisTestServer()

const RETIRED_KEYS = {
  agents: ['agent:rts_old_claude_cli', 'agent:rts_old_codex', 'agent:rts_old_n8n',
    'agent:rts_typeless_mode_cli', 'agent:rts_typeless_mode_n8n', 'agent:rts_typeless_claude_cli'],
  subagents: ['subagent:rts_old_workflow', 'subagent:rts_old_codex_sub', 'subagent:rts_typeless_workflow', 'subagent:rts_old_shared'],
  inert: [
    'subagent_thread:rts_live_chat:rts_old_workflow', 'n8n:sse-callback:rts_live_chat:m1', 'compatibility:matrix:n8n:v1',
    'codex_cleanup_warnings:rts_live_chat', 'codex_cleanup_warning:rts_live_chat:m1',
    'subagent_sessions:rts_live_chat:subagent:rts_old_workflow:thread-1',
  ],
  /** What the retired Claude Code CLI agent's delete removes with it (`--chats delete`). */
  withAgent: [`session:${RETIRED_CHAT}`, 'session:rts_retired_infinite', 'memory:rts_old_claude_cli:m1'],
}

/** Every live record the sweep must leave as it was. */
const LIVE_AGENTS = ['rts_claude_plan', 'rts_typeless_plain', 'rts_typeless_plan', 'rts_chatgpt_codex', 'rts_local_codex', 'rts_openai_codex']
const LIVE_SUBAGENTS = ['rts_live_claude_cli', 'rts_live_api_sub', 'rts_cli_no_lane', 'rts_cli_plan_sub', 'rts_api_codex_sub', 'rts_live_shared']
const LIVE_IDS = ['rts_live_api', ...LIVE_AGENTS, ...LIVE_SUBAGENTS]

/** Every live key the sweep must leave byte-identical (the live API agent is compared apart). */
const KEEP_KEYS = [
  ...LIVE_AGENTS.map((id) => `agent:${id}`), ...LIVE_SUBAGENTS.map((id) => `subagent:${id}`),
  `subagent_sessions:${LIVE_CHAT}:subagent:rts_live_claude_cli`,
  `subagent_sessions:${LIVE_CHAT}:subagent:rts_live_claude_cli:thread-2`,
  `subagent_sessions:${LIVE_CHAT}:subagent:rtsshared:thread-9`,
  'compatibility:matrix:v1', 'model:rts_claude_cli_preset', 'model:rts_claude_plan_preset', 'model:rts_codex_preset',
  `user:${USER}:settings`, `api_keys:${USER}:n8n_instance_mcp_token`, 'batshit:batshit_mode3_system_prompt',
  `session:${LIVE_CHAT}`, 'session:rts_retired_locked', 'memory:rts_live_api:m1',
]

async function dump(key: string): Promise<string | null> {
  return redis.execute(async (client) => {
    const kind = await client.type(key)
    if (kind === 'none') return null
    if (kind === 'ReJSON-RL') return `json:${JSON.stringify(await client.json.get(key))}`
    if (kind === 'string') return `string:${await client.get(key)}`
    if (kind === 'list') return `list:${JSON.stringify(await client.lRange(key, 0, -1))}`
    if (kind === 'set') return `set:${JSON.stringify((await client.sMembers(key)).sort())}`
    return `${kind}:?`
  })
}

/** The live API agent without the fields the sweep's owners may change on it. */
async function liveApiRest() {
  const { codex_settings: _codex, assigned_subagent_ids: _assigned, updated_at: _updated, ...rest } = await redis.json.get('agent:rts_live_api') as Record<string, any>
  return rest
}

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out[path.relative(root, full)] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root)
  return out
}

async function seedAgent(id: string, fields: Record<string, unknown>) {
  await redis.json.set(`agent:${id}`, '$', { id, user_id: USER, displayName: id, created_at: '2026-10-27T00:00:00.000Z', ...fields })
  await redis.sAdd(`user:${USER}:agents`, id)
}

async function seedSubagent(id: string, fields: Record<string, unknown>) {
  await redis.json.set(`subagent:${id}`, '$', { id, user_id: USER, displayName: id, created_at: '2026-10-27T00:00:00.000Z', ...fields })
  await redis.sAdd(`user:${USER}:subagents`, id)
}

async function seedChat(id: string, agent: string, extra: Record<string, unknown> = {}) {
  await redis.json.set(`session:${id}`, '$', { id, user_id: USER, agent_id: agent, title: id, created_at: '2026-10-27T00:00:00.000Z', ...extra })
  await redis.sAdd(`user:${USER}:sessions`, id)
}

async function seed() {
  // Retired Primaries: the Claude Code CLI lane (R4), a Codex CLI agent (R1), an n8n Primary
  // (SA-106), and three untyped legacy records that read as one of those types.
  await seedAgent('rts_old_claude_cli', { agentType: 'cli', displayName: 'Old Claude CLI', primary_model_provider: 'claude-cli',
    primary_model_connection: { id: 'claude-cli', service: 'claude-cli' }, claude_settings: { permissionMode: 'acceptEdits' } })
  await seedAgent('rts_old_codex', { agentType: 'cli', primary_model_provider: 'openai-codex', primary_model_connection: { id: 'codex-cli' } })
  await seedAgent('rts_old_n8n', { agentType: 'n8n' })
  await seedAgent('rts_typeless_mode_cli', { batshitMode: 'cli' })
  await seedAgent('rts_typeless_mode_n8n', { mode: 'n8n-native' })
  await seedAgent('rts_typeless_claude_cli', { primary_model_connection: { id: 'claude-cli', type: 'direct' } })
  // Live Primaries: an API agent with leftover lane blocks; a Claude plan agent named like Josh's
  // test agent; untyped plain and Claude plan records; API agents whose model names "codex".
  await seedAgent('rts_live_api', { agentType: 'api', displayName: 'Live API', claude_settings: { profileId: 'batshit_agent_rts_live_api' },
    codex_settings: { model: 'gpt-5-codex' }, assigned_subagent_ids: ['rts_live_claude_cli', 'rts_old_workflow'] })
  await seedAgent('rts_claude_plan', { agentType: 'api', displayName: 'Chloe', primary_model_provider: 'anthropic',
    primary_model_connection: { type: 'direct', id: 'claude-plan:local', service: 'claude-plan' } })
  await seedAgent('rts_typeless_plain', { displayName: 'Typeless plain' })
  await seedAgent('rts_typeless_plan', { primary_model_name: 'opus', primary_model_connection: { type: 'direct', id: 'claude-plan:local', service: 'claude-plan' } })
  await seedAgent('rts_chatgpt_codex', { agentType: 'api', primary_model_name: 'gpt-5-codex',
    primary_model_connection: { type: 'direct', id: 'chatgpt-plan:local', service: 'chatgpt-plan' } })
  await seedAgent('rts_local_codex', { agentType: 'api', primary_model_name: 'qwen3-codex', primary_model_provider: 'local-ai',
    primary_model_connection: { type: 'local', id: 'local-ai:koboldcpp', service: 'local-ai' } })
  await seedAgent('rts_openai_codex', { agentType: 'api', primary_model_provider: 'openai', primary_model_name: 'gpt-5.1-codex',
    primary_model_connection: { type: 'direct', id: 'direct:openai', service: 'openai' } })
  await redis.sAdd('agent:rts_live_api:subagents', ['rts_live_claude_cli', 'rts_old_workflow'])

  // Retired Subagents: n8n Workflow, a Codex CLI Subagent, a typeless record with a workflow
  // target, and an n8n Workflow Subagent whose slug a live Subagent shares.
  await seedSubagent('rts_old_workflow', { subagentType: 'n8n-workflow', workflowName: 'Researcher' })
  await seedSubagent('rts_old_codex_sub', { subagentType: 'cli', primary_model_provider: 'codex', primary_model_name: 'gpt-5-codex' })
  await seedSubagent('rts_typeless_workflow', { webhookUrl: 'http://127.0.0.1:5678/webhook/x' })
  await seedSubagent('rts_old_shared', { subagentType: 'n8n-workflow', slug: 'rtsshared' })
  // Kept Subagents: Claude Code CLI Subagents (retired in SA-139 R5, but this sweep never deletes
  // them: they go in Settings), with and without a lane, one on the Claude plan, API Subagents, one
  // whose model names "codex", and the slug sharer.
  await seedSubagent('rts_live_claude_cli', { subagentType: 'cli', primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli',
    claude_settings: { chrome: true, permissionMode: 'acceptEdits' } })
  await seedSubagent('rts_live_api_sub', { subagentType: 'api', primary_model_provider: 'openai', primary_model_name: 'gpt-5' })
  await seedSubagent('rts_cli_no_lane', { subagentType: 'cli' })
  await seedSubagent('rts_cli_plan_sub', { subagentType: 'cli', primary_model_connection: { type: 'direct', id: 'claude-plan:local', service: 'claude-plan' } })
  await seedSubagent('rts_api_codex_sub', { subagentType: 'api', primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex' })
  await seedSubagent('rts_live_shared', { subagentType: 'cli', slug: 'rtsshared', primary_model_provider: 'claude-cli' })

  // Chats of the retired Claude Code CLI agent: regular, Infinite Session, locked, group; one of the live API agent.
  await seedChat(RETIRED_CHAT, 'rts_old_claude_cli')
  await seedChat('rts_retired_infinite', 'rts_old_claude_cli', { metadata: { fixedSession: { enabled: true } } })
  await seedChat('rts_retired_locked', 'rts_old_claude_cli', { locked: true })
  await seedChat('rts_retired_group', 'rts_old_claude_cli', { metadata: { group_chat: { members: ['rts_old_claude_cli', 'rts_live_api'] } } })
  await seedChat(LIVE_CHAT, 'rts_live_api')
  // Memories: the retired agent's go with it, the live agent's stay.
  await redis.json.set('memory:rts_old_claude_cli:m1', '$', { id: 'm1', agent_id: 'rts_old_claude_cli', content: 'old' })
  await redis.json.set('memory:rts_live_api:m1', '$', { id: 'm1', agent_id: 'rts_live_api', content: 'live' })

  // Inert keys of removed lanes.
  await redis.set('subagent_thread:rts_live_chat:rts_old_workflow', '0f8fad5b-d9cb-469f-a165-70867728950e')
  await redis.set('n8n:sse-callback:rts_live_chat:m1', JSON.stringify({ token: 't', expiresAt: 1 }))
  await redis.json.set('compatibility:matrix:n8n:v1', '$', { rows: [] })
  await redis.sAdd('codex_cleanup_warnings:rts_live_chat', 'm1')
  await redis.json.set('codex_cleanup_warning:rts_live_chat:m1', '$', { messageId: 'm1', kind: 'recorded_processes_ended' })
  await redis.execute((client) => client.rPush('subagent_sessions:rts_live_chat:subagent:rts_old_workflow:thread-1', 'old n8n memory'))

  // Live keys that look close to the retired ones.
  await redis.json.set(`subagent_sessions:${LIVE_CHAT}:subagent:rts_live_claude_cli`, '$', [{ role: 'user', content: 'live thread' }])
  await redis.execute((client) => client.rPush(`subagent_sessions:${LIVE_CHAT}:subagent:rts_live_claude_cli:thread-2`, 'kept: live slug'))
  await redis.execute((client) => client.rPush(`subagent_sessions:${LIVE_CHAT}:subagent:rtsshared:thread-9`, 'kept: a live Subagent shares the slug'))
  await redis.json.set('compatibility:matrix:v1', '$', { live: true })
  await redis.json.set('model:rts_claude_cli_preset', '$', { id: 'rts_claude_cli_preset', user_id: USER, connection: { id: 'claude-cli' } })
  await redis.json.set('model:rts_claude_plan_preset', '$', { id: 'rts_claude_plan_preset', user_id: USER, connection: { id: 'claude-plan:local', service: 'claude-plan' } })
  await redis.json.set('model:rts_codex_preset', '$', { id: 'rts_codex_preset', user_id: USER, connection: { id: 'codex-cli', service: 'codex' } })
  await redis.json.set(`user:${USER}:settings`, '$', { user_id: USER, n8n_api_url: 'http://127.0.0.1:5678' })
  await redis.set(`api_keys:${USER}:n8n_instance_mcp_token`, 'encrypted-value')
  await redis.set('batshit:batshit_mode3_system_prompt', 'live API Primary prompt')
}

async function cleanup() {
  const patterns = ['agent:rts_*', 'subagent:rts_*', 'session:rts_*', 'model:rts_*', 'subagent_thread:rts_*', 'n8n:sse-callback:rts_*',
    'codex_cleanup_warning*:rts_*', 'subagent_sessions:rts_*', `user:${USER}:*`, `api_keys:${USER}:*`, 'message:rts_*', 'memory:rts_*']
  for (const pattern of patterns) for (const key of await redis.keys(pattern)) await redis.del(key)
  for (const key of ['compatibility:matrix:n8n:v1', 'compatibility:matrix:v1', 'batshit:batshit_mode3_system_prompt', MODE4_PROMPT]) await redis.del(key)
}

const installsRoot = () => path.join(disk.home, 'installs')
const agentsRoot = () => path.join(disk.home, 'agents')
const retiredFolder = () => path.join(agentsRoot(), 'batshit_agent_rts_old_claude_cli')
const liveFolder = () => path.join(agentsRoot(), 'batshit_agent_subagent_cli_rts_live_claude_cli')
/** The retired agent's first Worker slot folder, named as the agent delete's Worker plan names it. */
const WORKER_PROFILE = buildAgentProfileId(buildCliWorkerRuntimeId(`worker_${normalizeSubagentSlugValue('rts_old_claude_cli', 'agent')}_1`))
const workerFolder = () => path.join(agentsRoot(), WORKER_PROFILE)

function seedDisk() {
  for (const dir of [installsRoot(), agentsRoot()]) rmSync(dir, { recursive: true, force: true })
  for (const name of readdirSync(disk.claudeHome)) rmSync(path.join(disk.claudeHome, name), { recursive: true, force: true })
  // The managed Claude Code install, where the real install root is (BATSHIT_MANAGED_INSTALLS_ROOT).
  const install = path.join(installsRoot(), 'cli', 'claude', '2.1.296')
  mkdirSync(install, { recursive: true })
  writeFileSync(path.join(install, 'batshit-managed-cli.json'), JSON.stringify({ runtime: 'claude', version: '2.1.296' }))
  mkdirSync(path.join(installsRoot(), 'cli', 'bin'), { recursive: true })
  writeFileSync(path.join(installsRoot(), 'cli', 'bin', 'claude'), '#!/bin/sh\n')
  // The Claude sign-in home.
  writeFileSync(path.join(disk.claudeHome, '.credentials.json'), '{"signed":"in"}')
  writeFileSync(path.join(disk.claudeHome, 'settings.json'), '{}')
  // The live CLI Subagent's profile folder, and the retired Claude Code CLI agent's.
  mkdirSync(path.join(liveFolder(), '.claude'), { recursive: true })
  writeFileSync(path.join(liveFolder(), '.claude', 'settings.json'), '{"live":true}')
  mkdirSync(path.join(retiredFolder(), '.claude'), { recursive: true })
  writeFileSync(path.join(retiredFolder(), '.claude', 'settings.json'), '{"retired":true}')
  mkdirSync(path.join(workerFolder(), '.claude'), { recursive: true })
  writeFileSync(path.join(workerFolder(), '.claude', 'settings.json'), '{"worker":true}')
}

/** Every batshit-server call the owners made, as text, so no live id can hide in one. */
let serverCalls: string[] = []

beforeEach(async () => {
  seedDisk()
  serverCalls = []
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', 'route-test-token')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    serverCalls.push(`${String(url)} ${typeof init?.body === 'string' ? init.body : ''}`)
    return String(url) === `${SERVER}/health`
      ? Response.json({ ok: true, checks: { http: true, redis: true } })
      : Response.json({ success: true, deletedRecords: [], deletedFiles: [] })
  }))
  await cleanup()
  await seed()
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(() => {
  for (const [name, value] of Object.entries(disk.saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(disk.home, { recursive: true, force: true })
  rmSync(disk.claudeHome, { recursive: true, force: true })
})

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('the one-time retired-type sweep (SA-139 R4 add-on)', () => {
  it('lists every retired family and nothing live, with each agent’s chats, memories and folder; the dry run changes nothing', async () => {
    const { planRetiredTypeSweep } = await import('../retiredTypeSweep')
    const before = await Promise.all([...KEEP_KEYS, ...RETIRED_KEYS.agents, 'agent:rts_live_api'].map(dump))

    const plan = await planRetiredTypeSweep()
    const byFamily = (family: string) => plan.items.filter((item) => item.family === family).map((item) => item.key).sort()

    expect(plan.blockers).toEqual([])
    expect(byFamily('retired-primary-agents')).toEqual([...RETIRED_KEYS.agents].sort())
    expect(byFamily('retired-subagents')).toEqual([...RETIRED_KEYS.subagents].sort())
    expect(byFamily('subagent-thread-keys')).toEqual(['subagent_thread:rts_live_chat:rts_old_workflow'])
    expect(byFamily('n8n-callback-keys')).toEqual(['n8n:sse-callback:rts_live_chat:m1'])
    expect(byFamily('n8n-compatibility-keys')).toEqual(['compatibility:matrix:n8n:v1'])
    expect(byFamily('codex-cleanup-warnings')).toEqual(['codex_cleanup_warning:rts_live_chat:m1', 'codex_cleanup_warnings:rts_live_chat'])
    expect(byFamily('n8n-workflow-memory')).toEqual(['subagent_sessions:rts_live_chat:subagent:rts_old_workflow:thread-1'])
    expect(byFamily('codex-settings-fields')).toEqual(['agent:rts_live_api'])
    for (const key of [...KEEP_KEYS, 'agent:rts_live_api']) {
      expect(plan.items.some((item) => item.key === key && item.family !== 'codex-settings-fields'), key).toBe(false)
    }

    const claudeCli = plan.items.find((item) => item.key === 'agent:rts_old_claude_cli')!
    expect(claudeCli.label).toBe('Old Claude CLI (Claude Code CLI Primary)')
    expect(plan.items.find((item) => item.key === 'agent:rts_old_codex')?.label).toMatch(/\(Codex CLI Primary\)$/)
    expect(plan.items.find((item) => item.key === 'agent:rts_old_n8n')?.label).toMatch(/\(n8n Primary\)$/)
    expect(claudeCli.primary).toEqual({ chats: 1, infiniteSessions: 1, keptLockedChats: 1, memories: 1,
      chatTitles: expect.arrayContaining([RETIRED_CHAT, 'rts_retired_infinite']) })
    expect(claudeCli.primary!.chatTitles).toHaveLength(2)
    expect(claudeCli.profileFolder).toEqual({ profileId: 'batshit_agent_rts_old_claude_cli', path: retiredFolder(), exists: true })
    // The Worker slot folders the agent delete removes are listed too (only those that exist).
    expect(claudeCli.workerFolders).toEqual([{ profileId: WORKER_PROFILE, path: workerFolder(), exists: true }])
    expect(plan.instanceOwners).toContain(USER)
    // The Subagent delete keeps a folder another record resolves to (BL-157), and the plan says so.
    expect(plan.items.find((item) => item.key === 'subagent:rts_old_shared')?.profileFolder?.sharedWith).toBe('subagent:rts_live_shared')
    expect(plan.kept).toEqual(expect.arrayContaining([
      expect.objectContaining({ what: 'claude_settings on API agents', count: 1 }),
      expect.objectContaining({ what: 'model presets on the removed Codex CLI connection', count: 1 }),
      // SA-139 R5 (Design 7, 12): counted, never deleted (rts_live_claude_cli, rts_cli_no_lane,
      // rts_cli_plan_sub, rts_live_shared).
      expect.objectContaining({ what: 'Claude Code CLI Subagents', count: 4 }),
    ]))

    expect((await planRetiredTypeSweep()).planId).toBe(plan.planId)
    expect(await Promise.all([...KEEP_KEYS, ...RETIRED_KEYS.agents, 'agent:rts_live_api'].map(dump))).toEqual(before)
    expect(existsSync(retiredFolder())).toBe(true)
  })

  it('deletes nothing when the plan id does not match, or when the plan has Primaries and no chats choice', async () => {
    const { planRetiredTypeSweep, applyRetiredTypeSweep } = await import('../retiredTypeSweep')
    const plan = await planRetiredTypeSweep()
    const owners = { deleteAgent: vi.fn(), deleteSubagent: vi.fn() }

    await expect(applyRetiredTypeSweep({ expectedPlanId: 'not-the-plan', chats: 'delete', owners })).rejects.toThrow(/Nothing was deleted/)
    await expect(applyRetiredTypeSweep({ expectedPlanId: plan.planId, chats: null, owners })).rejects.toThrow(/--chats delete or --chats keep/)

    expect(owners.deleteAgent).not.toHaveBeenCalled()
    expect(owners.deleteSubagent).not.toHaveBeenCalled()
    expect((await planRetiredTypeSweep()).planId).toBe(plan.planId)
  })

  it('refuses to run against a Batshit older than R4 (its old Claude Code CLI Primary prompt is still stored)', async () => {
    const { planRetiredTypeSweep, applyRetiredTypeSweep } = await import('../retiredTypeSweep')
    await redis.set(MODE4_PROMPT, 'old CLI Primary prompt, seeded at every start before R4')
    const before = await Promise.all([...KEEP_KEYS, ...RETIRED_KEYS.agents].map(dump))
    const owners = { deleteAgent: vi.fn(), deleteSubagent: vi.fn() }

    const plan = await planRetiredTypeSweep()
    expect(plan.blockers).toEqual([expect.stringContaining('older than SA-139 R4')])
    await expect(applyRetiredTypeSweep({ expectedPlanId: plan.planId, chats: 'delete', owners })).rejects.toThrow(/Nothing was deleted\..*older than SA-139 R4/)

    expect(owners.deleteAgent).not.toHaveBeenCalled()
    expect(owners.deleteSubagent).not.toHaveBeenCalled()
    expect(await Promise.all([...KEEP_KEYS, ...RETIRED_KEYS.agents].map(dump))).toEqual(before)
    expect(await dump(MODE4_PROMPT)).not.toBeNull()
  })

  it('refuses while a live record retains a folder alias a retired record’s delete removes', async () => {
    const { planRetiredTypeSweep, applyRetiredTypeSweep } = await import('../retiredTypeSweep')
    await redis.json.set('agent:rts_live_api', '$.claude_settings.profileId', 'batshit_agent_rts_old_claude_cli')
    const owners = { deleteAgent: vi.fn(), deleteSubagent: vi.fn() }

    const plan = await planRetiredTypeSweep()
    expect(plan.blockers).toEqual([expect.stringContaining('agent:rts_live_api (Live API) retains a reference to profile folder batshit_agent_rts_old_claude_cli')])
    await expect(applyRetiredTypeSweep({ expectedPlanId: plan.planId, chats: 'delete', owners })).rejects.toThrow(/Nothing was deleted/)
    expect(owners.deleteAgent).not.toHaveBeenCalled()
    expect(existsSync(retiredFolder())).toBe(true)
  })

  it('also refuses for a Worker slot folder the retired agent’s delete would remove that does not exist yet', async () => {
    const { planRetiredTypeSweep } = await import('../retiredTypeSweep')
    const absentSlot = buildAgentProfileId(buildCliWorkerRuntimeId(`worker_${normalizeSubagentSlugValue('rts_old_claude_cli', 'agent')}_2`))
    expect(existsSync(path.join(agentsRoot(), absentSlot))).toBe(false)
    await redis.json.set('agent:rts_live_api', '$.claude_settings.profileId', absentSlot)

    const plan = await planRetiredTypeSweep()
    expect(plan.blockers).toEqual([expect.stringContaining(`retains a reference to profile folder ${absentSlot}, which the delete of agent:rts_old_claude_cli would remove`)])
    expect(plan.items.find((item) => item.key === 'agent:rts_old_claude_cli')?.workerFolders?.map((folder) => folder.profileId)).toEqual([WORKER_PROFILE])
  })

  it('deletes exactly the plan through the real delete owners; live records, the managed Claude install and the sign-in stay', { timeout: 60_000 }, async () => {
    const { planRetiredTypeSweep, applyRetiredTypeSweep } = await import('../retiredTypeSweep')
    const keepBefore = await Promise.all(KEEP_KEYS.map(dump))
    const liveApiBefore = await liveApiRest()
    const installBefore = hashTree(installsRoot())
    const signInBefore = hashTree(disk.claudeHome)
    const liveProfileBefore = hashTree(liveFolder())
    const plan = await planRetiredTypeSweep()

    const result = await applyRetiredTypeSweep({ expectedPlanId: plan.planId, chats: 'delete' })

    expect(result.failed, JSON.stringify(result.failed)).toBeNull()
    expect(result.done).toHaveLength(plan.items.length)
    expect(result.gone).toEqual([])
    for (const key of [...RETIRED_KEYS.agents, ...RETIRED_KEYS.subagents, ...RETIRED_KEYS.inert, ...RETIRED_KEYS.withAgent]) {
      expect(await dump(key), key).toBeNull()
    }
    expect(existsSync(retiredFolder())).toBe(false)
    expect(existsSync(workerFolder())).toBe(false)
    expect(await redis.sMembers(`user:${USER}:agents`)).toEqual(expect.not.arrayContaining(RETIRED_KEYS.agents.map((key) => key.slice('agent:'.length))))
    expect(await redis.sMembers(`user:${USER}:subagents`)).toEqual(expect.not.arrayContaining(RETIRED_KEYS.subagents.map((key) => key.slice('subagent:'.length))))
    // The Subagent owner took the retired assignment off the surviving agent; the live one stays.
    expect((await redis.sMembers('agent:rts_live_api:subagents')).sort()).toEqual(['rts_live_claude_cli'])
    const liveApi = await redis.json.get('agent:rts_live_api') as Record<string, any>
    expect(liveApi.codex_settings).toBeUndefined()
    expect(await liveApiRest()).toEqual(liveApiBefore)
    // The locked chat and the group chat stay without their agent, as the Settings delete keeps them.
    expect(await dump('session:rts_retired_group')).not.toBeNull()

    expect(await Promise.all(KEEP_KEYS.map(dump))).toEqual(keepBefore)
    expect(hashTree(installsRoot())).toEqual(installBefore)
    expect(hashTree(disk.claudeHome)).toEqual(signInBefore)
    expect(hashTree(liveFolder())).toEqual(liveProfileBefore)
    // batshit-server was asked only about retired records.
    expect(serverCalls.length).toBeGreaterThan(0)
    for (const call of serverCalls) for (const id of LIVE_IDS) expect(call, call).not.toContain(id)

    const after = await planRetiredTypeSweep()
    expect(after.items).toEqual([])
  })

  it('reads each record again before its owner runs, and stops at one that is no longer of a retired type', async () => {
    const { planRetiredTypeSweep, applyRetiredTypeSweep } = await import('../retiredTypeSweep')
    const plan = await planRetiredTypeSweep()
    // Subagents go first; while they go, the n8n Primary becomes an API agent.
    const owners = {
      deleteSubagent: vi.fn(async () => {
        await redis.json.set('agent:rts_old_n8n', '$.agentType', 'api')
        return Response.json({ success: true })
      }),
      deleteAgent: vi.fn(async () => Response.json({ success: true })),
    }

    const result = await applyRetiredTypeSweep({ expectedPlanId: plan.planId, chats: 'delete', owners })

    expect(result.failed?.item.key).toBe('agent:rts_old_n8n')
    expect(result.failed?.error).toMatch(/no longer of a retired type/)
    expect(owners.deleteAgent.mock.calls.map((call) => call[0])).not.toContain('rts_old_n8n')
    expect(await dump('agent:rts_old_n8n')).not.toBeNull()
  })

  it('keeps the retired agent’s chats when told to keep them', { timeout: 60_000 }, async () => {
    const { planRetiredTypeSweep, applyRetiredTypeSweep } = await import('../retiredTypeSweep')
    const plan = await planRetiredTypeSweep()

    const result = await applyRetiredTypeSweep({ expectedPlanId: plan.planId, chats: 'keep' })

    expect(result.failed, JSON.stringify(result.failed)).toBeNull()
    expect(await dump('agent:rts_old_claude_cli')).toBeNull()
    for (const id of [RETIRED_CHAT, 'rts_retired_infinite', 'rts_retired_locked']) expect(await dump(`session:${id}`), id).not.toBeNull()
  })

  it('lists a retired record with no owner and leaves it; everything else still goes', { timeout: 60_000 }, async () => {
    const { planRetiredTypeSweep, applyRetiredTypeSweep } = await import('../retiredTypeSweep')
    await redis.json.set('agent:rts_ownerless_cli', '$', { id: 'rts_ownerless_cli', agentType: 'cli', displayName: 'No owner' })
    const plan = await planRetiredTypeSweep()
    expect(plan.items.find((item) => item.key === 'agent:rts_ownerless_cli')).toMatchObject({ ownerless: true })

    const result = await applyRetiredTypeSweep({ expectedPlanId: plan.planId, chats: 'delete' })

    expect(result.failed, JSON.stringify(result.failed)).toBeNull()
    expect(result.done.map((item) => item.key)).not.toContain('agent:rts_ownerless_cli')
    expect(await dump('agent:rts_ownerless_cli')).not.toBeNull()
    for (const key of RETIRED_KEYS.agents) expect(await dump(key), key).toBeNull()
    expect((await planRetiredTypeSweep()).items.map((item) => item.key)).toEqual(['agent:rts_ownerless_cli'])
  })
})
