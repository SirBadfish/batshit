import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { withSettingsRecordReplacement } from '../appActions/settings/lifecycle'
import { createSubjectPopulation } from '../subjectPopulation'
const USER = 'tool_settings_create_test'
describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('permanent subject creation: actual explicit tool choice', () => {
  const admission = useSkillSessionRedisTestServer()
  afterEach(async () => {
    admission.requireAdmission()
    for (const pattern of [`user:${USER}:*`, 'agent:tool_create_*', 'subagent:tool_create_*', `slash_command_revision:${USER}`]) for (const key of await redis.execute(client => client.keys(pattern))) await redis.del(key)
  })
  async function create(id: string, kind: 'primary' | 'subagent', provider?: unknown) {
    admission.requireAdmission()
    const prefix = kind === 'primary' ? 'agent' : 'subagent'
    return withSettingsRecordReplacement(`${prefix}:${id}`, () => redis.execute(client => createSubjectPopulation(client,
      { userId: USER, subjectId: id, kind, mode: 'create', record: { id, user_id: USER, provider_specific_settings: provider } })))
  }
  it.each(['primary', 'subagent'] as const)('creates explicit factoryfalse for a new %s even when a legacy global would be true', async kind => {
    await redis.json.set(`user:${USER}:settings`, '$', { user_id: USER, global_tool_grid_settings: { typed_file_tools: true } })
    await create('tool_create_new', kind)
    expect(await redis.json.get(`${kind === 'primary' ? 'agent' : 'subagent'}:tool_create_new`)).toMatchObject({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false } } })
  })
  it('duplicates the explicit source grant and complete active alias without inheriting a different global', async () => {
    const source = { batshitNativeTools: { typedFileToolsEnabled: false, bashEnabled: false, unknown: 'keep' }, modelKey: 'keep' }
    await create('tool_create_source', 'primary', source)
    const original = await redis.json.get('agent:tool_create_source') as any
    await create('tool_create_copy', 'primary', original.provider_specific_settings)
    expect(await redis.json.get('agent:tool_create_copy')).toMatchObject({ provider_specific_settings: { modelKey: 'keep', nativeTools: { typedFileToolsEnabled: false, bashEnabled: false, unknown: 'keep' } } })
    expect(source.batshitNativeTools).toEqual({ typedFileToolsEnabled: false, bashEnabled: false, unknown: 'keep' })
  })
  it.each(['agent', 'subagent'] as const)('returns the SAME canonical postimage from the actual %s create handler for default and alias source', async kind => {
    admission.requireAdmission()
    const handler = kind === 'agent' ? (await import('../../../../routes/api/agents/+server')).POST : (await import('../../../../routes/api/subagents/+server')).POST
    for (const shape of ['default', 'alias', 'fabricfalse', 'explicitfalse']) {
      const alias = shape === 'alias'
      const id = `tool_create_http_${kind}_${shape}`
      const provider = alias ? { batshitNativeTools: { typedFileToolsEnabled: true, bashEnabled: false, unknown: 'keep' } } : shape === 'fabricfalse' ? { nativeTools: { batshitToolsEnabled: false } } : shape === 'explicitfalse' ? { nativeTools: { artifactRuntimeEnabled: false } } : undefined
      const request = new Request(`http://localhost/api/${kind === 'agent' ? 'agents' : 'subagents'}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, displayName: 'Fixture',
          ...(kind === 'agent' ? { agentType: 'api' } : { subagentType: 'api' }), provider_specific_settings: provider }) })
      const response = await handler({ request, locals: { user: { id: USER } } } as any)
      expect(response.ok).toBe(true)
      const data = await response.json(); const returned = kind === 'agent' ? data : data.subagent
      const stored = await redis.json.get(`${kind}:${id}`) as any
      expect(returned.provider_specific_settings).toEqual(stored.provider_specific_settings)
      expect(returned.provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(alias)
      expect(returned.provider_specific_settings.nativeTools.artifactRuntimeEnabled).toBe(shape === 'default' || alias)
      if (alias) expect(returned.provider_specific_settings.nativeTools).toMatchObject({ bashEnabled: false, unknown: 'keep' })
    }
  })

  it('refuses stale per-agent operational writes before any record, index or population revision', async () => {
    await expect(create('tool_create_retired', 'primary', { nativeTools: { webSearchProvider: 'exa' } })).rejects.toMatchObject({ status: 400 })
    expect(await redis.exists('agent:tool_create_retired')).toBe(false)
    expect(await redis.execute(client => client.sMembers(`user:${USER}:agents`))).toEqual([])
    expect(await redis.get(`slash_command_revision:${USER}`)).toBeNull()
  })
})
