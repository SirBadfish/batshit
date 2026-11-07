// @vitest-environment node
/** SA-139: Compact on a Claude plan preset refuses readably (never a 500) and builds no paid client; P4 admits it (consumer `compact`). */
import { beforeEach, expect, it, vi } from 'vitest'
const pm = vi.hoisted(() => ({ createForUser: vi.fn() }))
vi.mock('$lib/server/services/providers', async original => ({ ...await original<Record<string, unknown>>(), ProviderManager: { createForUser: pm.createForUser } }))
// SA-139: this build has the Claude plan runtime, so admission reads Claude Code; a signed-out stand-in here.
vi.mock('$lib/server/services/claudePlanReadiness', () => ({
  readClaudePlanReadiness: vi.fn(async () => ({ state: 'unavailable', code: 'signed_out', reason: 'Claude Code is signed out, so the Claude plan connection cannot start (test).' }))
}))
vi.mock('$lib/server/services/contextTokenPreview', async original => ({
  ...(await original<Record<string, unknown>>()),
  estimateCurrentContextTokens: vi.fn(async () => ({ budget: { contextLimit: 10000 }, tokens: 1000 })),
  loadContextProtections: vi.fn(async () => ({ protectedMessageIds: [], protectedUnzippedZipIds: [], activeClipIds: [] }))
}))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { POST } from './+server'
import { beginSessionDelete, endSessionDelete } from '$lib/server/services/streamAbortRegistry'
useRedisTestServer()
const USER = 'sa139-compact-user', AGENT = 'sa139-compact-agent', SESSION = 'sa139-compact-session', PRESET = 'sa139-compact-plan'
const messages = ['Old question.', 'Old answer.', 'Recent question.', 'Recent answer.'].map((content, index) => ({ id: `m${index}`, session_id: SESSION, agent_id: index % 2 ? AGENT : undefined, role: index % 2 ? 'assistant' : 'user', content, timestamp: `2026-10-27T00:0${index}:00.000Z` }))
const connection = { id: 'claude-plan:local', type: 'direct', service: 'claude-plan' }
const run = () => POST({ request: new Request('http://fixture/api/messages/compact', { method: 'POST', body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, mode: 'manual', messages }) }), locals: { user: { id: USER } }, fetch: globalThis.fetch } as any)
beforeEach(async () => {
  pm.createForUser.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await redis.set(`agent:${AGENT}`, { id: AGENT, user_id: USER, name: 'Fixture', agentType: 'api', primary_model_preset_id: PRESET })
  await redis.createSession({ id: SESSION, user_id: USER, title: 'Fixture Compact', agent_id: AGENT } as any)
})

it('refuses a plan preset holding a setting Claude Code cannot take with a readable 400, and a valid one Claude Code cannot run yet with a readable 409', async () => {
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5', connection, settings: { temperature: 0.5 }, pricing: {} })
  const bad = await run()
  expect(bad.status).toBe(400)
  expect((await bad.json()).error).toMatch(/The Claude plan connection does not support temperature/)
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5', connection, settings: { anthropicEffort: 'high' }, pricing: {} })
  const valid = await run()
  expect(valid.status).toBe(409)
  expect((await valid.json()).error).toBe('Claude Code is signed out, so the Claude plan connection cannot start (test).')
  expect(pm.createForUser).not.toHaveBeenCalled()
})

it('BL-2357: a Compact that starts while its chat is being deleted runs nothing and says why', async () => {
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5', connection, settings: { anthropicEffort: 'high' }, pricing: {} })
  expect(beginSessionDelete(SESSION)).toBe(true)
  try {
    const answer = await run()
    expect(answer.status).toBe(409)
    expect(await answer.json()).toEqual({ error: 'A delete of this chat was requested, so Compact stopped. It wrote nothing.', code: 'ended_early', reason: 'session_deleted' })
    expect(pm.createForUser).not.toHaveBeenCalled()
  } finally {
    endSessionDelete(SESSION)
  }
})
