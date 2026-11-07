import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { materializeToolSettingsAtStartup, materializeToolSettingsForUser } from '../toolSettingsMigration'
import { withSettingsRecordReplacement } from '../appActions/settings/lifecycle'
const USER = 'tool_settings_migration_test'
const settingsKey = `user:${USER}:settings`
const key = (id: string) => `agent:${id}`

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('tool-settings materialization: actual original RAW publication', () => {
  const admission = useSkillSessionRedisTestServer()
  afterEach(async () => {
    vi.restoreAllMocks(); admission.requireAdmission()
    await redis.del('users:all')
    for (const pattern of [`user:${USER}:*`, 'agent:tool_migration_*', 'subagent:tool_migration_*', `slash_command_revision:${USER}`]) {
      for (const name of await redis.execute(client => client.keys(pattern))) await redis.del(name)
    }
  })
  async function subject(id: string, provider: unknown, kind: 'agent' | 'subagent' = 'agent') {
    admission.requireAdmission()
    const record = { id, user_id: USER, provider_specific_settings: provider, unrelated: 'kept' }
    await redis.json.set(`${kind}:${id}`, '$', record)
    await redis.execute(client => client.sAdd(`user:${USER}:${kind === 'agent' ? 'agents' : 'subagents'}`, id))
  }
  async function global(value: unknown) {
    admission.requireAdmission(); await redis.json.set(settingsKey, '$', { user_id: USER,
      global_tool_grid_settings: { typed_file_tools: value, other: 'keep' }, unrelated: 'keep' })
  }
  it('converts every strict indexed account before startup admission', async () => {
    await global(true); await subject('tool_migration_startup', { nativeTools: { bashEnabled: false } })
    await redis.json.set(`user:${USER}:data`, '$', { id: USER })
    await redis.execute(client => client.sAdd('users:all', USER))
    expect(await materializeToolSettingsAtStartup()).toEqual({ users: 1, subjects: 1 })
    expect(await redis.json.get(key('tool_migration_startup'))).toMatchObject({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true, bashEnabled: false } } })
  })
  it('refuses a malformed/missing indexed account before converting its settings', async () => {
    await global(true); await redis.execute(client => client.sAdd('users:all', USER))
    const before = await redis.json.getRaw(settingsKey, '$')
    await expect(materializeToolSettingsAtStartup()).rejects.toMatchObject({ outcome: 'not_written' })
    expect(await redis.json.getRaw(settingsKey, '$')).toBe(before)
  })
  it('materializes complete Primary/Subagent inventories before deleting inheritance and is idempotent', async () => {
    await global(true)
    await subject('tool_migration_primary', { nativeTools: { bashEnabled: true, webSearchProvider: 'exa' }, model: 'keep' })
    await subject('tool_migration_subagent', { nativeTools: { typedFileToolsEnabled: ' FALSE ', agentBrowserMode: 'cdp' } }, 'subagent')
    expect(await materializeToolSettingsForUser(USER)).toEqual({ subjects: 2 })
    expect(await redis.json.get(key('tool_migration_primary'))).toMatchObject({ unrelated: 'kept', provider_specific_settings: { model: 'keep', nativeTools: { bashEnabled: true, typedFileToolsEnabled: true } } })
    expect(await redis.json.get('subagent:tool_migration_subagent')).toMatchObject({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false } } })
    expect(await redis.json.get(settingsKey)).toEqual({ user_id: USER, unrelated: 'keep', global_tool_grid_settings: { other: 'keep' } })
    const before = await redis.json.getRaw(key('tool_migration_primary'), '$')
    await materializeToolSettingsForUser(USER)
    expect(await redis.json.getRaw(key('tool_migration_primary'), '$')).toBe(before)
  })
  it('freezes effective Artifact access for both inventories without using retired discoverability', async () => {
    await global(false)
    await subject('tool_migration_artifact_legacy', { nativeTools: { batshitToolsEnabled: false } })
    await subject('tool_migration_artifact_explicit', { nativeTools: { artifactRuntimeEnabled: true, batshitToolsEnabled: false } }, 'subagent')
    await materializeToolSettingsForUser(USER)
    expect((await redis.json.get(key('tool_migration_artifact_legacy')) as any).provider_specific_settings.nativeTools.artifactRuntimeEnabled).toBe(false)
    expect((await redis.json.get('subagent:tool_migration_artifact_explicit') as any).provider_specific_settings.nativeTools.artifactRuntimeEnabled).toBe(true)
    await redis.json.set(key('tool_migration_artifact_legacy'), '$.provider_specific_settings.nativeTools.batshitToolsEnabled', true)
    expect((await redis.json.get(key('tool_migration_artifact_legacy')) as any).provider_specific_settings.nativeTools.artifactRuntimeEnabled).toBe(false)
  })
  it('promotes the complete RAW active alias preserving Bash false/unknown large integers', async () => {
    await global(true)
    await subject('tool_migration_alias', {})
    await redis.execute(client => client.sendCommand(['JSON.SET', key('tool_migration_alias'), '$.provider_specific_settings',
      '{"batshitNativeTools":{"bashEnabled":false,"unknown":9007199254740993,"typedFileToolsEnabled":"true","webSearchProvider":"exa"},"unknown":9007199254740995}']))
    const source = await redis.json.getRaw(key('tool_migration_alias'), '$.provider_specific_settings.batshitNativeTools.unknown')
    await materializeToolSettingsForUser(USER)
    expect(await redis.json.getRaw(key('tool_migration_alias'), '$.provider_specific_settings.nativeTools.unknown')).toBe(source)
    expect(await redis.json.getRaw(key('tool_migration_alias'), '$.provider_specific_settings.unknown')).toBe('[9007199254740995]')
    expect(await redis.json.get(key('tool_migration_alias'))).toMatchObject({ provider_specific_settings: { nativeTools: { bashEnabled: false, typedFileToolsEnabled: true } } })
  })
  it('keeps an existing empty canonical bag authoritative over its ignored alias', async () => {
    await global(false); await subject('tool_migration_empty', { nativeTools: {}, batshitNativeTools: { typedFileToolsEnabled: true, bashEnabled: false } })
    await materializeToolSettingsForUser(USER)
    expect(await redis.json.get(key('tool_migration_empty'))).toMatchObject({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false } } })
  })
  it.each(['global', 'subject', 'population', 'lifecycle'] as const)('refuses original %s drift before any migration write', async change => {
    await global(true); await subject('tool_migration_race', { batshitNativeTools: { bashEnabled: false } })
    await expect(materializeToolSettingsForUser(USER, { beforeIssue: async () => {
      if (change === 'global') await redis.json.set(settingsKey, '$.global_tool_grid_settings.typed_file_tools', false)
      if (change === 'subject') await redis.json.set(key('tool_migration_race'), '$.provider_specific_settings.nativeTools', { bashEnabled: true })
      if (change === 'population') await subject('tool_migration_new', { nativeTools: { typedFileToolsEnabled: false } })
      if (change === 'lifecycle') await withSettingsRecordReplacement(key('tool_migration_race'), async () => {})
    } })).rejects.toMatchObject({ outcome: 'not_written' })
    expect(await redis.json.getRaw(key('tool_migration_race'), '$.provider_specific_settings.nativeTools.typedFileToolsEnabled')).toBe('[]')
    expect(await redis.json.getRaw(settingsKey, '$.global_tool_grid_settings.typed_file_tools')).not.toBe('[]')
  })
  it('prevalidates every subject, including late malformed grants, before writing the first', async () => {
    await global(true); await subject('tool_migration_a', { nativeTools: {} }); await subject('tool_migration_z', { nativeTools: { typedFileToolsEnabled: 'wrong' } })
    const before = await redis.json.getRaw(key('tool_migration_a'), '$')
    await expect(materializeToolSettingsForUser(USER)).rejects.toThrow(/malformed/)
    expect(await redis.json.getRaw(key('tool_migration_a'), '$')).toBe(before)
    expect(await redis.json.getRaw(settingsKey, '$.global_tool_grid_settings.typed_file_tools')).toBe('[true]')
  })
  it.each(['wrong', ['invalid container']])('refuses malformed global %j with ZERO subjects and preserves exact source', async value => {
    admission.requireAdmission()
    await redis.json.set(settingsKey, '$', { user_id: USER, global_tool_grid_settings: Array.isArray(value) ? value : { typed_file_tools: value } })
    const before = await redis.json.getRaw(settingsKey, '$')
    await expect(materializeToolSettingsForUser(USER)).rejects.toMatchObject({ outcome: 'not_written' })
    expect(await redis.json.getRaw(settingsKey, '$')).toBe(before)
  })
  it('classifies lifecycle rejection before issue as known no-write without calling EVAL', async () => {
    await global(true); await subject('tool_migration_lease', { nativeTools: {} })
    const original = redis.execute.bind(redis)
    const evalCall = vi.fn()
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return evalCall
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(materializeToolSettingsForUser(USER, { beforeIssue: async () => {
      await withSettingsRecordReplacement(key('tool_migration_lease'), async () => {})
    } })).rejects.toMatchObject({ outcome: 'not_written' })
    expect(evalCall).not.toHaveBeenCalled()
  })
  it.each([null, '0', -1, 1])('keeps malformed issued receipt %j unconfirmed and never retries automatically', async receipt => {
    admission.requireAdmission()
    const user = `${USER}_receipt_${String(receipt)}`
    const original = redis.execute.bind(redis)
    const evalCall = vi.fn(async () => ['APPLIED', receipt])
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return evalCall
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(materializeToolSettingsForUser(user)).rejects.toMatchObject({ outcome: 'unconfirmed' })
    await expect(materializeToolSettingsForUser(user)).rejects.toMatchObject({ outcome: 'unconfirmed' })
    expect(evalCall).toHaveBeenCalledOnce()
  })

  it('distinguishes known-absent global settings from a malformed existing root', async () => {
    await subject('tool_migration_absent', null)
    await materializeToolSettingsForUser(USER)
    expect(await redis.json.get(key('tool_migration_absent'))).toMatchObject({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false } } })
    await redis.json.set(settingsKey, '$', null)
    await expect(materializeToolSettingsForUser(USER)).rejects.toThrow(/malformed/)
  })
})
