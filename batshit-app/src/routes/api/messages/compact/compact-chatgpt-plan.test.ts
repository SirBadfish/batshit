// @vitest-environment node
/** Real Compact route, summary service, installed SDK and Redis; synthetic OAuth/provider only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai'); vi.unmock('@ai-sdk/openai')
const slot = vi.hoisted(() => ({ runtime: null as any, look: 0, estimates: 0, beforeWrite: null as null | (() => void), afterWrite: null as null | (() => void) }))
vi.mock('$lib/server/services/chatgptPlanHost', () => ({ getChatgptPlanRuntime: () => slot.runtime }))
vi.mock('$lib/server/services/contextTokenPreview', async original => ({
  ...(await original<Record<string, unknown>>()),
  estimateCurrentContextTokens: vi.fn(async () => { if (++slot.estimates === 2) slot.afterWrite?.(); return { budget: { contextLimit: 10000 }, tokens: 1000 } }),
  loadContextProtections: vi.fn(async () => {
    if (++slot.look === 2) slot.beforeWrite?.()
    return { protectedMessageIds: [], protectedUnzippedZipIds: [], activeClipIds: [] }
  })
}))
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ChatgptPlanVault } from '$lib/server/services/chatgptPlanVault'
import { ChatgptPlanOAuth } from '$lib/server/services/chatgptPlanOAuth'
import { ChatgptPlanRuntime, type PlanLease } from '$lib/server/services/chatgptPlanRuntime'
import { __resetCompactRunRegistryForTests, stopCompactRuns, countCompactRuns } from '$lib/server/services/compactRunRegistry'
import { getContextCompactionState } from '$lib/utils/contextCompaction'
import { POST } from './+server'
useRedisTestServer()
const USER = 'sa130-compact-user', AGENT = 'sa130-compact-agent', SESSION = 'sa130-compact-session', PRESET = 'sa130-compact-preset'
let runtime: ChatgptPlanRuntime, vault: ChatgptPlanVault, root: string, lease: PlanLease | undefined, answer: string, body: any
const messages = ['Old fixture question.', 'Old fixture answer.', 'Recent fixture question.', 'Recent fixture answer.'].map((content, index) => ({ id: `m${index}`, session_id: SESSION, agent_id: index % 2 ? AGENT : undefined, role: index % 2 ? 'assistant' : 'user', content, timestamp: `2026-10-01T00:0${index}:00.000Z` }))
beforeEach(async () => {
  slot.look = 0; slot.estimates = 0; slot.beforeWrite = null; slot.afterWrite = null; lease = undefined; answer = 'Useful fixture summary.'
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-compact-')))
  vault = new ChatgptPlanVault(root, 'sa130-synthetic-compact-key-0123456789')
  const row = vault.connect({ userId: USER, issuer: 'https://auth.openai.com', subject: 'Compact-fixture', clientId: 'oaiapp_Fixture', email: '' }, { accessToken: 'COMPACT_ACCESS_FIXTURE', refreshToken: 'COMPACT_REFRESH_FIXTURE', idToken: 'COMPACT_ID_FIXTURE', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }, vault.beginAuthorization(USER))
  const http = vi.fn(async (_url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer COMPACT_ACCESS_FIXTURE')
    body = JSON.parse(String(init?.body))
    const events = [{ type: 'response.created', response: { id: 'resp_fixture', created_at: 1790000000, model: 'fixture-model' } }, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture' } }, { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, delta: answer }, { type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } } }]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  runtime = new ChatgptPlanRuntime(vault, new ChatgptPlanOAuth(vault, async () => true, http), http); slot.runtime = runtime
  const acquire = runtime.acquire.bind(runtime)
  vi.spyOn(runtime, 'acquire').mockImplementation((...args) => { lease = acquire(...args); return lease })
  vi.spyOn(runtime.oauth, 'revoke').mockResolvedValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  __resetCompactRunRegistryForTests()
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: 'openai', modelId: 'fixture-model', effectiveModelId: 'fixture-model', connection: { id: `chatgpt-plan:${row.id}`, type: 'direct', service: 'chatgpt-plan' }, settings: {} })
  await redis.set(`agent:${AGENT}`, { id: AGENT, user_id: USER, name: 'Fixture', agentType: 'api', primary_model_preset_id: PRESET })
  await redis.createSession({ id: SESSION, user_id: USER, title: 'Fixture Compact', agent_id: AGENT } as any)
})
afterEach(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); __resetCompactRunRegistryForTests() })
const events = async () => getContextCompactionState((await redis.getSession(SESSION))?.metadata).events
const run = () => POST({ request: new Request('http://fixture/api/messages/compact', { method: 'POST', body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, mode: 'manual', messages }) }), locals: { user: { id: USER } }, fetch: globalThis.fetch } as any)
describe('ChatGPT Compact final write ownership', () => {
  it('keeps the lease through the real conditional write and releases only after the route settles', async () => {
    slot.afterWrite = () => { runtime.assertLease(lease!); expect(countCompactRuns(SESSION)).toBe(1) }
    const response = await run(); expect(response.status, JSON.stringify(await response.json())).toBe(200)
    expect(await events()).toHaveLength(1); expect(body).toMatchObject({ stream: true, store: false }); expect(body).not.toHaveProperty('max_output_tokens')
    expect(JSON.stringify(body.input)).toContain('Old fixture question.')
    expect(() => runtime.assertLease(lease!)).toThrow(); expect(countCompactRuns(SESSION)).toBe(0)
  })
  it('a disconnect during the final protection read invalidates the lease before any summary write', async () => {
    let disconnect: Promise<unknown> | undefined
    slot.beforeWrite = () => { disconnect = runtime.disconnect(USER, vault.list(USER)[0].id) }
    const response = await run(); expect(response.status).toBe(499)
    expect(await events()).toEqual([]); await disconnect
    expect(() => runtime.assertLease(lease!)).toThrow(); expect(countCompactRuns(SESSION)).toBe(0)
  })
  it('Stop after generation leaves no event and releases the plan call', async () => {
    slot.beforeWrite = () => { expect(stopCompactRuns(SESSION)).toBe(1) }
    expect((await run()).status).toBe(409); expect(await events()).toEqual([])
    expect(() => runtime.assertLease(lease!)).toThrow(); expect(countCompactRuns(SESSION)).toBe(0)
  })
  it('excess summary output is a visible failure and cannot write a partial Compact', async () => {
    answer = 'Long fixture summary. '.repeat(9000)
    const response = await run(); expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('summary budget')
    expect(await events()).toEqual([]); expect(() => runtime.assertLease(lease!)).toThrow()
  })
})
