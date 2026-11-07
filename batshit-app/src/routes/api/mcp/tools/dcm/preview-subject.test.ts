// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
const index = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => ({ text: 'index' })))
vi.mock('$lib/server/services/dynamicMcpIndex', async original => ({
  ...await original<typeof import('$lib/server/services/dynamicMcpIndex')>(), buildDynamicMcpIndex: index
}))
import { POST } from './+server'
useRedisTestServer()
async function preview(body: unknown, userId: string | null = 'owner') {
  return POST({ locals: userId ? { user: { id: userId } } : {}, request: new Request('http://localhost/api/mcp/tools/dcm', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as never)
}
beforeEach(async () => {
  index.mockClear()
  await redis.json.set('agent:same', '$', { id: 'same', user_id: 'owner', agentType: 'api' })
  await redis.json.set('subagent:same', '$', { id: 'same', user_id: 'owner', subagentType: 'api' })
  vi.mocked(redis.get).mockClear()
})
afterEach(() => vi.restoreAllMocks())
describe('typed human DCM preview projection, independent of effect authority', () => {
  it('verifies the exact Primary namespace; same-ID Subagent runtime does not establish Primary identity', async () => {
    const reads = vi.spyOn(redis, 'get')
    expect((await preview({ agentId: 'same', subjectKind: 'primary', primarySettingsActor: false, controlActorType: 'service', ownedPrimaryPreview: false })).status).toBe(200)
    expect(index).toHaveBeenLastCalledWith(expect.objectContaining({ primarySettingsActor: true, controlActorType: 'session' }))
    // The index derives preview metadata from this verified pair; JSON cannot supply its flag.
    expect(index.mock.calls.at(-1)?.[0]).not.toHaveProperty('ownedPrimaryPreview')
    expect(reads).toHaveBeenCalledWith('agent:same', { throwOnError: true })
    expect((await preview({ agentId: 'same', subjectKind: 'subagent', primarySettingsActor: true, controlActorType: 'session', ownedPrimaryPreview: true })).status).toBe(200)
    expect(index).toHaveBeenLastCalledWith(expect.objectContaining({ primarySettingsActor: false }))
    expect(index.mock.calls.at(-1)?.[0].controlActorType).toBeUndefined()
    expect(index.mock.calls.at(-1)?.[0]).not.toHaveProperty('ownedPrimaryPreview')
    expect(index).toHaveBeenLastCalledWith(expect.objectContaining({
      allowFabricControlTools: false, memoryControlsEnabled: false, dmControlsEnabled: false,
      scheduleControlsEnabled: false, judgeControlsEnabled: false
    }))
  })
  it('BL-2239: a legacy omitted kind verifies the owned Primary for session discovery without asserting the explicit namespace marker', async () => {
    const reads = vi.spyOn(redis, 'get')
    expect((await preview({ agentId: 'same', primarySettingsActor: true, controlActorType: 'in-process', ownedPrimaryPreview: true, runtime: 'api' })).status).toBe(200)
    expect(reads).toHaveBeenCalledWith('agent:same', { throwOnError: true })
    expect(index).toHaveBeenLastCalledWith(expect.objectContaining({ primarySettingsActor: false, controlActorType: 'session' }))
    expect(index.mock.calls.at(-1)?.[0]).not.toHaveProperty('ownedPrimaryPreview')
  })
  it.each(['unknown', 'worker'])('unrecognized kind %j cannot infer a vouched Primary marker or trust a JSON actor field', async subjectKind => {
    expect((await preview({ agentId: 'same', subjectKind, primarySettingsActor: true, controlActorType: 'session', ownedPrimaryPreview: true, runtime: 'api' })).status).toBe(200)
    expect(index).toHaveBeenCalledWith(expect.objectContaining({ primarySettingsActor: false }))
    expect(index.mock.calls.at(-1)?.[0].controlActorType).toBeUndefined()
    expect(index.mock.calls.at(-1)?.[0]).not.toHaveProperty('ownedPrimaryPreview')
  })
  it.each(['primary', 'subagent', undefined])('does not project a missing, malformed or foreign subject with kind %j', async subjectKind => {
    for (const body of [{ agentId: 'missing', subjectKind: 'primary' }, { agentId: '../same', subjectKind: 'primary' }]) {
      expect([400, 404]).toContain((await preview({ ...body, subjectKind, controlActorType: 'session' })).status)
    }
    await redis.json.set(`${subjectKind === 'subagent' ? 'subagent' : 'agent'}:same`, '$.user_id', 'other')
    expect((await preview({ agentId: 'same', subjectKind, controlActorType: 'session' })).status).toBe(404)
    expect(index).not.toHaveBeenCalled()
  })
  it.each(['primary', undefined])('BL-2239: a retired Primary with kind %j cannot acquire session discovery from a body marker', async subjectKind => {
    await redis.json.set('agent:same', '$.agentType', 'n8n')
    expect((await preview({ agentId: 'same', subjectKind, controlActorType: 'session', primarySettingsActor: true })).status).toBe(200)
    expect(index).toHaveBeenLastCalledWith(expect.objectContaining({ primarySettingsActor: false }))
    expect(index.mock.calls.at(-1)?.[0].controlActorType).toBeUndefined()
  })
  it('BL-2239: no agent subject and body actor markers alone do not establish Primary discovery', async () => {
    expect((await preview({ primarySettingsActor: true, controlActorType: 'session' })).status).toBe(200)
    expect(index).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: null, primarySettingsActor: false }))
    expect(index.mock.calls.at(-1)?.[0].controlActorType).toBeUndefined()
  })
  it('BL-2239: body actor markers without a signed-in user are unauthorized', async () => {
    expect((await preview({ agentId: 'same', subjectKind: 'primary', controlActorType: 'session' }, null)).status).toBe(401)
    expect(index).not.toHaveBeenCalled()
  })
  it('BL-2239: an exact owned-subject read failure remains unavailable rather than becoming an empty or vouched preview', async () => {
    const reads = vi.mocked(redis.get)
    const get = reads.getMockImplementation()!
    const failure = new Error('Owned preview subject unavailable')
    expect(get).toBeTypeOf('function')
    reads.mockClear()
    try {
      reads.mockImplementation(async (key, options) => {
        if (key === 'agent:same' && options?.throwOnError === true) throw failure
        return get(key, options)
      })
      const response = await preview({ agentId: 'same', controlActorType: 'session' })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error: failure.message })
      expect(reads.mock.calls.filter(([key, options]) => key === 'agent:same' && options?.throwOnError === true)).toEqual([
        ['agent:same', { throwOnError: true }]
      ])
      expect(index).not.toHaveBeenCalled()
    } finally {
      reads.mockImplementation(get)
    }
  })
})
