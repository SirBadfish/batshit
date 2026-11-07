import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { CLAUDE_CLI_PRESET_REFUSAL } from '$lib/utils/cliRuntimeIdentity'

/**
 * SA-139 R1: Codex CLI was removed (Josh, 2026-10-26). Creating a Primary Agent that names it by
 * provider or connection is refused 409 `codex_cli_retired`, and a `codex_settings` block in a
 * create body is never stored. An OpenAI model whose id merely contains "codex" is an ordinary API
 * model and still saves.
 *
 * SA-139 R5: the CLI Subagent type was removed too (Claude Code CLI, and Codex CLI before it).
 * A create that asks for it, by type or by a typeless body's CLI lane, is refused 409
 * `subagent_type_retired` before anything is stored; an API Subagent that names a Claude Code CLI
 * model is refused 400, and one that names Codex CLI keeps R1's 409. A leftover CLI Subagent stays
 * in the list (so its Delete is reachable) while a removed n8n one is hidden, and it is never
 * assigned to a Primary Agent.
 *
 * Same route harness as `agent-subagent-id-rule.test.ts`.
 */

vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

// The default fake deliberately has no EVAL. Route ID/ownership tests keep
// those checks real and stub only the physical population boundary; actual
// record/index/nonce/cross-kind Lua is proved by subjectPopulation.redis.test.ts.
vi.mock('$lib/server/services/subjectPopulation', async importOriginal => {
  const original = await importOriginal<typeof import('$lib/server/services/subjectPopulation')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return original
  return { ...original, createSubjectPopulation: vi.fn(async (client: any, subject: { userId: string; subjectId: string; kind: 'primary' | 'subagent'; record: unknown }) => {
    await client.json.set(`${subject.kind === 'primary' ? 'agent' : 'subagent'}:${subject.subjectId}`, '$', subject.record)
    await client.sAdd(`user:${subject.userId}:${subject.kind === 'primary' ? 'agents' : 'subagents'}`, subject.subjectId)
    return { status: 'CREATED', record: subject.record }
  }) }
})

useRedisTestServer()

const USER = 'user-codex-retired-create'
const locals = { user: { id: USER } }
const RETIRED = { code: 'codex_cli_retired', error: 'Codex CLI agents were removed from Batshit.' }
const CLAUDE_CLI_SUBAGENT_RETIRED = { code: 'subagent_type_retired', error: 'Claude Code CLI Subagents were removed from Batshit.',
  details: 'Batshit no longer has Claude Code CLI Subagents, so a Subagent cannot be created as one or changed to one. To use your Claude plan, pick a Claude plan model.' }
const CODEX_CLI_SUBAGENT_RETIRED = { code: 'subagent_type_retired', error: 'Codex CLI Subagents were removed from Batshit.',
  details: 'Batshit no longer has Codex CLI Subagents, so a Subagent cannot be created as one or changed to one. For ChatGPT models, use the ChatGPT plan connection or an OpenAI API key.' }

// A stored leftover (the assignment case) gets the stored wording, not the request wording.
const CLAUDE_CLI_SUBAGENT_LEFTOVER = { ...CLAUDE_CLI_SUBAGENT_RETIRED,
  details: 'Probe sub ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.' }

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function createSubagent(body: Record<string, unknown>) {
  const { POST } = await import('./+server')
  return POST({ request: jsonRequest('http://localhost/api/subagents', body), locals } as any)
}

async function createAgent(body: Record<string, unknown>) {
  const { POST } = await import('../agents/+server')
  return POST({ request: jsonRequest('http://localhost/api/agents', body), locals } as any)
}

async function storedIds() {
  return {
    agents: await redis.sMembers(`user:${USER}:agents`),
    subagents: await redis.sMembers(`user:${USER}:subagents`)
  }
}

/** A record as an older app stored it (no create route makes one now). */
async function seedStoredSubagent(id: string, fields: Record<string, unknown>) {
  await redis.json.set(`subagent:${id}`, '$', { id, user_id: USER, displayName: id, ...fields } as never)
  await redis.sAdd(`user:${USER}:subagents`, id)
}

beforeEach(async () => {
  for (const key of await redis.keys('agent:*')) await redis.del(key)
  for (const key of await redis.keys('subagent:*')) await redis.del(key)
  await redis.del(`user:${USER}:agents`)
  await redis.del(`user:${USER}:subagents`)
})

describe('SA-139 R1: creating a Primary Agent on the removed Codex CLI', () => {
  it.each([
    ['provider', { primary_model_provider: 'openai-codex', primary_model_name: 'codex' }],
    ['short provider', { primary_model_provider: 'codex' }],
    ['connection', { primary_model_provider: 'openai', primary_model_connection: { type: 'direct', id: 'codex-cli', service: 'codex-cli' } }]
  ])('is refused 409 codex_cli_retired by its %s, and nothing is stored', async (_name, fields) => {
    // SA-139 R4: an API body, the one Primary type. A `cli` body is refused by its type first
    // (409 primary_agent_type_retired), before this Codex check.
    const response = await createAgent({ id: 'codex_probe', displayName: 'Codex probe', agentType: 'api', ...fields })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject(RETIRED)
    expect(body.details).toContain('Delete it and create a new agent')
    expect(await redis.json.get('agent:codex_probe')).toBeNull()
    expect(await storedIds()).toEqual({ agents: [], subagents: [] })
  })

  it('never stores a codex_settings block from the create body', async () => {
    const response = await createAgent({ id: 'api_probe', displayName: 'API probe', agentType: 'api',
      codex_settings: { permissionMode: 'chat', model: 'gpt-6-sol' } })

    expect(response.status).toBe(200)
    const record = await redis.json.get('agent:api_probe') as Record<string, unknown>
    expect(record).toMatchObject({ id: 'api_probe', agentType: 'api' })
    expect(record).not.toHaveProperty('codex_settings')
  })

  it('creates an API agent on an OpenAI model whose id contains "codex"', async () => {
    const response = await createAgent({ id: 'gpt_codex_probe', displayName: 'GPT Codex probe', agentType: 'api',
      primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex' })

    expect(response.status).toBe(200)
    expect(await redis.json.get('agent:gpt_codex_probe')).toMatchObject({ agentType: 'api', primary_model_name: 'gpt-5-codex' })
  })
})

describe('SA-139 R5: creating a Subagent of the removed CLI type', () => {
  it.each([
    ['by type alone', { subagentType: 'cli' }, CLAUDE_CLI_SUBAGENT_RETIRED],
    ['by type, on the Claude Code CLI', { subagentType: 'cli', primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli' }, CLAUDE_CLI_SUBAGENT_RETIRED],
    ['by a typeless body that names the Claude Code CLI lane', { primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli' }, CLAUDE_CLI_SUBAGENT_RETIRED],
    ['by type, on Codex CLI by its provider', { subagentType: 'cli', primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli' }, CODEX_CLI_SUBAGENT_RETIRED],
    ['by type, on Codex CLI by its model name', { subagentType: 'cli', primary_model_provider: 'openai', primary_model_name: 'codex' }, CODEX_CLI_SUBAGENT_RETIRED],
    ['by a typeless body that names the Codex CLI lane', { primary_model_provider: 'openai-codex' }, CODEX_CLI_SUBAGENT_RETIRED]
  ])('%s is refused 409 subagent_type_retired, and nothing is stored', async (_name, fields, refusal) => {
    const response = await createSubagent({ id: 'cli_sub_probe', displayName: 'Probe sub', ...fields })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(refusal)
    expect(await redis.json.get('subagent:cli_sub_probe')).toBeNull()
    expect(await storedIds()).toEqual({ agents: [], subagents: [] })
  })

  it.each([
    ['provider', { primary_model_provider: 'claude-cli' }],
    ['model', { primary_model_provider: 'anthropic', primary_model_name: 'claude-cli' }],
    ['connection id', { primary_model_provider: 'anthropic', primary_model_connection: { type: 'direct', id: 'claude-cli' } }],
    ['connection service', { primary_model_provider: 'anthropic', primary_model_connection: { type: 'direct', service: 'anthropic-claude-cli' } }]
  ])('an API Subagent that names a Claude Code CLI %s is refused 400, and nothing is stored', async (_name, fields) => {
    const response = await createSubagent({ id: 'claude_cli_model_probe', displayName: 'Probe sub', subagentType: 'api', ...fields })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: CLAUDE_CLI_PRESET_REFUSAL })
    expect(await redis.json.get('subagent:claude_cli_model_probe')).toBeNull()
    expect(await storedIds()).toEqual({ agents: [], subagents: [] })
  })

  it.each([
    ['provider', { primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli' }],
    ['connection', { primary_model_provider: 'openai', primary_model_connection: { type: 'direct', id: 'codex-cli', service: 'codex-cli' } }]
  ])('an API Subagent on the removed Codex CLI by its %s keeps R1\'s 409 codex_cli_retired, and nothing is stored', async (_name, fields) => {
    const response = await createSubagent({ id: 'codex_sub_probe', displayName: 'Codex sub', subagentType: 'api', ...fields })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ...RETIRED,
      details: 'This Subagent runs on Codex CLI, which Batshit no longer supports. Delete it and create a new Subagent.' })
    expect(await redis.json.get('subagent:codex_sub_probe')).toBeNull()
    expect(await storedIds()).toEqual({ agents: [], subagents: [] })
  })

  it('never stores a codex_settings or claude_settings block, or a Claude Code CLI check, from the create body', async () => {
    const response = await createSubagent({ id: 'api_sub_probe', displayName: 'API sub', subagentType: 'api',
      primary_model_provider: 'openai', primary_model_name: 'gpt-5.5', codex_settings: { model: 'gpt-6-sol' },
      claude_settings: { model: 'opus', permissionMode: 'plan' }, expectedCliPromotion: { runtime: 'claude' } })

    expect(response.status).toBe(200)
    const record = await redis.json.get('subagent:api_sub_probe') as Record<string, unknown>
    expect(record).toMatchObject({ id: 'api_sub_probe', subagentType: 'api', primary_model_provider: 'openai' })
    expect(record).not.toHaveProperty('codex_settings')
    expect(record).not.toHaveProperty('claude_settings')
    expect(record).not.toHaveProperty('expectedCliPromotion')
  })

  it('creates an API Subagent on an OpenAI model whose id contains "codex"', async () => {
    const response = await createSubagent({ id: 'gpt_codex_sub', displayName: 'GPT Codex sub', subagentType: 'api',
      primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex' })

    expect(response.status).toBe(200)
    expect(await redis.json.get('subagent:gpt_codex_sub')).toMatchObject({ subagentType: 'api', primary_model_name: 'gpt-5-codex' })
  })
})

describe('SA-139 R5: a leftover CLI Subagent in the list and the assignment', () => {
  it('the list shows a leftover CLI Subagent (Claude Code or Codex, typed or not) and hides a removed n8n one', async () => {
    await seedStoredSubagent('a_live', { subagentType: 'api', primary_model_provider: 'openai' })
    await seedStoredSubagent('b_claude_leftover', { subagentType: 'cli', primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli' })
    await seedStoredSubagent('c_codex_leftover', { subagentType: 'cli', primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli' })
    await seedStoredSubagent('d_typeless_leftover', { primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'claude-cli' })
    await seedStoredSubagent('e_n8n', { subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook' })
    const { GET } = await import('./+server')

    const response = await GET({ locals } as any)

    expect(response.status).toBe(200)
    const { subagents } = await response.json() as { subagents: Array<{ id: string; subagentType: string }> }
    expect(subagents.map(({ id, subagentType }) => [id, subagentType])).toEqual([
      ['a_live', 'api'], ['b_claude_leftover', 'cli'], ['c_codex_leftover', 'cli'], ['d_typeless_leftover', 'cli']
    ])
  })

  it('assigning a leftover CLI Subagent is refused 409, and the assignment is not replaced', async () => {
    await redis.json.set('agent:primary_probe', '$', { id: 'primary_probe', user_id: USER, displayName: 'Primary probe', agentType: 'api',
      assigned_subagent_ids: ['a_live'], assignedSubagents: ['a_live'] } as never)
    await redis.sAdd(`user:${USER}:agents`, 'primary_probe')
    await redis.sAdd('agent:primary_probe:subagents', 'a_live')
    await seedStoredSubagent('a_live', { subagentType: 'api', primary_model_provider: 'openai' })
    await seedStoredSubagent('b_claude_leftover', { displayName: 'Probe sub', subagentType: 'cli', primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli' })
    const before = await redis.json.get('agent:primary_probe')
    const { POST } = await import('../agents/[id]/subagents/+server')

    const response = await POST({ params: { id: 'primary_probe' }, locals,
      request: jsonRequest('http://localhost/api/agents/primary_probe/subagents', { subagentIds: ['a_live', 'b_claude_leftover'] }) } as any)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(CLAUDE_CLI_SUBAGENT_LEFTOVER)
    expect(await redis.sMembers('agent:primary_probe:subagents')).toEqual(['a_live'])
    expect(await redis.json.get('agent:primary_probe')).toEqual(before)
  })
})
