import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-762 (2026-09-28): the Subagent edit (`PUT /api/subagents/[id]`) spreads `...updates` onto
 * the existing record and keeps only `id`, `user_id`, and `created_at` as they were. A hand-made
 * request with a `slug` field (the panel sends none) changed the stored slug, and
 * `resolveSubagentSlug` reads `slug` ahead of `id`/`displayName`, so the edit renamed the
 * Subagent's managed CLI profile folder. Fix: `slug` is kept like `id`.
 */

const syncManagedCliSubagentProfile = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/cliSubagentProfileSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/cliSubagentProfileSync')>()
  return { ...actual, syncManagedCliSubagentProfile }
})
vi.mock('$lib/server/services/codexProfileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/codexProfileManager')>()
  return { ...actual, syncAgentCodexProfiles: vi.fn(async () => {}) }
})
vi.mock('$lib/server/services/claudeProfileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/claudeProfileManager')>()
  return { ...actual, syncAgentClaudeProfiles: vi.fn(async () => {}) }
})
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

useRedisTestServer()

const USER = 'zcsubag_slug_user'
const SUB = 'zcsubag_slug_route'
const SERVER = 'http://batshit-server.test:5613'

async function seedSubagent() {
  await redis.json.set(`subagent:${SUB}`, '$', {
    id: SUB,
    user_id: USER,
    displayName: 'zcsubag slug route',
    slug: 'zcsubag_slug_original',
    subagentType: 'cli',
    primary_model_provider: 'openai-codex',
    primary_model_name: 'codex-cli',
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  })
  await redis.sAdd(`user:${USER}:subagents`, SUB)
}

async function callPut(updates: Record<string, unknown>) {
  const { PUT } = await import('./+server')
  const request = { json: async () => updates }
  const response = (await PUT({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
  return { status: response.status, body: await response.json() }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', 'zcsubag-slug-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === `${SERVER}/health` && method === 'GET') {
        return jsonResponse(200, { ok: true, service: 'batshit-server', checks: { http: true, redis: true } })
      }
      throw new Error(`unexpected batshit-server call ${method} ${url}`)
    })
  )
  syncManagedCliSubagentProfile.mockReset()
  syncManagedCliSubagentProfile.mockImplementation(async () => ({ runtime: 'codex', profileId: 'p', written: true }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await redis.del(`subagent:${SUB}`)
  await redis.del(`user:${USER}:subagents`)
})

describe('PUT /api/subagents/[id] keeps the stored slug (BL-762)', () => {
  it('control: an edit with no slug field leaves the stored slug unchanged', async () => {
    await seedSubagent()

    const { status, body } = await callPut({ description: 'edited' })

    expect(status).toBe(200)
    expect(body.subagent.slug).toBe('zcsubag_slug_original')
    expect(((await redis.json.get(`subagent:${SUB}`)) as any).slug).toBe('zcsubag_slug_original')
  })

  it('a hand-made edit with a slug field does not change the stored slug', async () => {
    await seedSubagent()

    const { status, body } = await callPut({ slug: 'zcsubag_slug_hijacked' })

    expect(status).toBe(200)
    expect(body.subagent.slug).toBe('zcsubag_slug_original')
    expect(((await redis.json.get(`subagent:${SUB}`)) as any).slug).toBe('zcsubag_slug_original')
  })
})
