import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis'))
// No filesystem seeding: this packet proves real access persistence, not home-folder edits.
vi.mock('../systemSlashCommands', async importOriginal => ({
  ...(await importOriginal<typeof import('../systemSlashCommands')>()), ensureSystemSlashCommands: vi.fn()
}))
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { BUILTIN_PLUGIN_SKILLS, LEGACY_BUILTIN_PLUGIN_SKILLS, BUNDLED_BATSHIT_PLUGIN_VERSION } from '../systemPluginPackage'
import { UPGRADE_BUILTIN_PLUGIN_SCRIPT, agentPluginKey, ensureBuiltinAgentPlugin, getAgentPlugin, listAgentPlugins, pluginEnabledForAgent, projectPluginCommand, registerAgentPlugin, finishAgentPluginImport, removeAgentPlugin, finishRemoveAgentPlugin, removeAgentPluginAgentReferences, refusePluginMemberWrite, setAgentPluginGlobalAccess, setAgentPluginAgentAccess } from '../agentPlugins'
import { getEnabledAgentSlashCapabilities, listAllSlashCapabilities, resolveSkillAccessForActor } from '../slashCommandCapabilities'
import { ensureSystemSlashCommands } from '../systemSlashCommands'
import { slashCommandRevisionKey } from '../slashCommandRevision'
import { withSettingsRecordReplacement, withSettingsRestoreFence } from '../appActions/settings/lifecycle'
import { projectSkillAccess } from '../appActions/settings/skillAccessReport'
import { planSkillAccessChange } from '../appActions/settings/conditionalSkillAccess'
import type { SlashCommandRow } from '$lib/types/database'
const USER = 'sa138_plugin_test'
const groupKey = agentPluginKey(USER, 'batshit')
const key = (id: string) => `slash_command:${USER}:${id}`
const row = (index: number, fields: Record<string, unknown> = {}): SlashCommandRow => ({
  id: BUILTIN_PLUGIN_SKILLS[index].commandId, skill_id: BUILTIN_PLUGIN_SKILLS[index].skillId, user_id: USER,
  name: BUILTIN_PLUGIN_SKILLS[index].commandId, type: 'skill', is_active: true, can_be_invoked_in_chat: true,
  enabled_for_all_agents: false, enabled_agent_ids: [], created_at: 'original', updated_at: 'original', ...fields
})
async function legacy(fields: Record<string, unknown> = {}) {
  for (let index = 0; index < 6; index++) await redis.json.set(key(row(index).id), '$', row(index, fields))
}
async function actor(id: string) { await redis.json.set(`agent:${id}`, '$', { id, user_id: USER }) }
const savedSeven = (fields: Record<string, unknown> = {}) => ({ id: 'batshit', user_id: USER, name: 'Batshit', description: 'Seven skills for using and extending Batshit.',
  builtIn: true, version: '1.0.0', skills: LEGACY_BUILTIN_PLUGIN_SKILLS.map(skill => ({ commandId: skill.commandId, skillId: skill.skillId, name: skill.displayName, invocation: `/batshit:${skill.commandId}` })),
  enabled_for_all_agents: false, enabled_agent_ids: [], revision: 'old-seven', created_at: 'original', updated_at: 'original', ...fields })

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('SA-138 grouped plugin access: actual RedisJSON scripts', () => {
  const admission = useSkillSessionRedisTestServer()
  beforeEach(() => admission.requireAdmission())
  afterEach(async () => {
    vi.restoreAllMocks(); admission.requireAdmission()
    for (const pattern of [`agent_plugin:${USER}:*`, `slash_command:${USER}:*`, 'agent:sa138_*']) {
      for (const fixtureKey of await redis.execute(client => client.keys(pattern))) await redis.del(fixtureKey)
    }
  })
  it('fresh install creates eight grouped skills with the existing global intent', async () => {
    const plugin = await ensureBuiltinAgentPlugin(USER)
    expect(plugin.skills).toHaveLength(8); expect(plugin.enabled_for_all_agents).toBe(true)
    expect(plugin.enabled_agent_ids).toEqual([]); expect(pluginEnabledForAgent(plugin, 'worker_any')).toBe(true)
    expect((await listAgentPlugins(USER)).map(plugin => plugin.id)).toEqual(['batshit'])
  })
  it.each([
    { enabled_for_all_agents: false, enabled_agent_ids: [] },
    { enabled_for_all_agents: false, enabled_agent_ids: ['Exact.Agent', 'another'] },
    { enabled_for_all_agents: true, enabled_agent_ids: ['retained'] }
  ])('upgrades the exact saved seven inventory while preserving grants %j and making no repeat write', async grants => {
    await redis.json.set(groupKey, '$', savedSeven({ ...grants, unknown: { keep: ['one', 'two'] } }))
    const before = await redis.json.getRaw(groupKey, '$.enabled_agent_ids')
    const plugin = await ensureBuiltinAgentPlugin(USER)
    expect(plugin.skills).toHaveLength(8); expect(plugin.version).toBe(BUNDLED_BATSHIT_PLUGIN_VERSION)
    expect(plugin).toMatchObject(grants); expect(plugin.created_at).toBe('original'); expect(plugin.revision).not.toBe('old-seven')
    expect(await redis.json.getRaw(groupKey, '$.enabled_agent_ids')).toBe(before)
    const upgraded = await redis.json.getRaw(groupKey, '$')
    await ensureBuiltinAgentPlugin(USER)
    expect(await redis.json.getRaw(groupKey, '$')).toBe(upgraded)
  })
  it('read-only saved seven access is unchanged and no App Actions row is seeded', async () => {
    await redis.json.set(groupKey, '$', savedSeven({ enabled_agent_ids: ['selected'] }))
    const before = await redis.json.getRaw(groupKey, '$')
    const records = await listAgentPlugins(USER, { readOnly: true })
    expect(records[0].skills).toHaveLength(7)
    expect(await redis.json.getRaw(groupKey, '$')).toBe(before)
    expect(await redis.json.get(key('app-actions'))).toBeNull()
    expect(await redis.json.get(`skill:${USER}:app_actions`)).toBeNull()
  })
  it('leaf-appends without re-encoding unknown root or old member numeric siblings', async () => {
    const value = savedSeven({ unknownBig: 'BIG_ROOT' })
    Object.assign(value.skills[0], { unknownBig: 'BIG_MEMBER' })
    const raw = JSON.stringify(value).replace('"BIG_ROOT"', '9007199254740993').replace('"BIG_MEMBER"', '9007199254740995')
    await redis.execute(client => client.sendCommand(['JSON.SET', groupKey, '$', raw]))
    const root = await redis.json.getRaw(groupKey, '$.unknownBig'), member = await redis.json.getRaw(groupKey, '$.skills[0]')
    await ensureBuiltinAgentPlugin(USER)
    expect(await redis.json.getRaw(groupKey, '$.unknownBig')).toBe(root)
    expect(await redis.json.getRaw(groupKey, '$.skills[0]')).toBe(member)
    expect(root).toBe('[9007199254740993]')
  })
  it('uses only the original six command sources for fresh access migration, excluding a newer canonical App Actions row', async () => {
    await legacy()
    await redis.json.set(key('app-actions'), '$', { id: 'app-actions', user_id: USER, type: 'skill', skill_id: 'app_actions', plugin_id: 'batshit',
      is_system: true, skill_source: 'system', enabled_for_all_agents: true, enabled_agent_ids: ['newer-only'] })
    const plugin = await ensureBuiltinAgentPlugin(USER)
    expect(plugin.enabled_for_all_agents).toBe(false); expect(plugin.enabled_agent_ids).toEqual([])
  })
  it('rechecks exact raw source state: a concurrent human grant edit is preserved on a known-conflict retry', async () => {
    await redis.json.set(groupKey, '$', savedSeven({ enabled_agent_ids: ['before'] }))
    const original = redis.execute.bind(redis)
    let attempts = 0
    vi.spyOn(redis, 'execute').mockImplementation(async callback => original(async client => {
      const eval_ = client.eval.bind(client), wrapper = Object.create(client)
      wrapper.eval = async (script: string, options: unknown) => {
        if (script === UPGRADE_BUILTIN_PLUGIN_SCRIPT && ++attempts === 1) {
          await client.json.set(groupKey, '$.enabled_agent_ids', ['human-latest'])
          await client.json.set(groupKey, '$.revision', 'human-latest')
        }
        return eval_(script, options as never)
      }
      return callback(wrapper)
    }))
    expect((await ensureBuiltinAgentPlugin(USER)).enabled_agent_ids).toEqual(['human-latest'])
    expect(attempts).toBe(2)
  })
  it('refuses a new custom command that lands after collision preflight, before any inventory append', async () => {
    await redis.json.set(groupKey, '$', savedSeven())
    const before = await redis.json.getRaw(groupKey, '$')
    const original = redis.execute.bind(redis)
    let attempts = 0
    vi.spyOn(redis, 'execute').mockImplementation(async callback => original(async client => {
      const eval_ = client.eval.bind(client), wrapper = Object.create(client)
      wrapper.eval = async (script: string, options: unknown) => {
        if (script === UPGRADE_BUILTIN_PLUGIN_SCRIPT && ++attempts === 1) await client.json.set(key('app-actions'), '$', { id: 'app-actions', user_id: USER, type: 'prompt', instructions: 'Original user text' })
        return eval_(script, options as never)
      }
      return callback(wrapper)
    }))
    await expect(ensureBuiltinAgentPlugin(USER)).rejects.toMatchObject({ code: 'BUILTIN_SKILL_ID_COLLISION', outcome: 'not_written' })
    expect(attempts).toBe(1)
    expect(await redis.json.getRaw(groupKey, '$')).toBe(before)
    expect((await redis.json.get(key('app-actions')) as any).instructions).toBe('Original user text')
  })
  it('preserves all-off, unions exact selected IDs and never rewrites legacy command rows', async () => {
    await legacy()
    expect((await ensureBuiltinAgentPlugin(USER)).enabled_agent_ids).toEqual([])
    expect((await getAgentPlugin(USER, 'batshit'))!.enabled_for_all_agents).toBe(false)
    await redis.del(groupKey)
    await redis.json.set(key(row(0).id), '$.enabled_agent_ids', ['A-B', 'a_b', 'odd.id'])
    await redis.json.set(key(row(1).id), '$.enabled_agent_ids', ['a_b', 'second'])
    const frozen = await redis.json.get(key(row(0).id))
    expect((await ensureBuiltinAgentPlugin(USER)).enabled_agent_ids).toEqual(['A-B', 'a_b', 'odd.id', 'second'])
    expect(await redis.json.get(key(row(0).id))).toEqual(frozen)
    expect(await redis.json.get(key(row(5).id))).toEqual(row(5))
  })
  it('retains missing-list universal intent and ignores inactive legacy global flags', async () => {
    await legacy({ is_active: false, enabled_for_all_agents: true })
    await redis.json.set(key(row(0).id), '$', row(0, { enabled_agent_ids: ['selected'] }))
    const selected = await ensureBuiltinAgentPlugin(USER)
    expect(selected.enabled_for_all_agents).toBe(false); expect(selected.enabled_agent_ids).toEqual(['selected'])
    await redis.del(groupKey)
    const absent = row(0); Reflect.deleteProperty(absent, 'enabled_agent_ids')
    await redis.json.set(key(absent.id), '$', absent)
    expect((await ensureBuiltinAgentPlugin(USER)).enabled_for_all_agents).toBe(true)
  })
  it.each([{ enabled_agent_ids: null }, { enabled_agent_ids: ['bad\u00a0'] }, { is_active: 'yes' }, { skill_id: 'wrong' }])('refuses malformed legacy state before creating a group: %j', async fields => {
    await legacy(); await redis.json.set(key(row(5).id), '$', row(5, fields))
    await expect(ensureBuiltinAgentPlugin(USER)).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
    expect(await redis.exists(groupKey)).toBe(false)
  })
  it('takes one migration winner and detects a source changed between validation and issue', async () => {
    await legacy({ enabled_agent_ids: ['sa138_one'] })
    const [first, second] = await Promise.all([ensureBuiltinAgentPlugin(USER), ensureBuiltinAgentPlugin(USER)])
    expect(first.revision).toBe(second.revision)
    await redis.del(groupKey)
    const original = redis.execute.bind(redis); let changed = false
    vi.spyOn(redis, 'execute').mockImplementation(async callback => original(async client => {
      const eval_ = client.eval.bind(client), wrapper = Object.create(client)
      wrapper.eval = async (script: string, options: unknown) => {
        if (script.includes('INVALID_LEGACY') && !changed) { changed = true; await client.json.set(key(row(5).id), '$.enabled_agent_ids', ['concurrent']) }
        return eval_(script, options as never)
      }
      return callback(wrapper)
    }))
    await expect(ensureBuiltinAgentPlugin(USER)).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
    expect(await redis.exists(groupKey)).toBe(false)
  })
  it('retains distinct concurrent actor toggles, explicit choices through global switching and removes only the deleted actor', async () => {
    await legacy(); await ensureBuiltinAgentPlugin(USER); await actor('sa138_one'); await actor('sa138_two')
    await Promise.all([setAgentPluginAgentAccess(USER, 'batshit', 'sa138_one', true), setAgentPluginAgentAccess(USER, 'batshit', 'sa138_two', true)])
    expect((await getAgentPlugin(USER, 'batshit'))!.enabled_agent_ids.sort()).toEqual(['sa138_one', 'sa138_two'])
    await setAgentPluginGlobalAccess(USER, 'batshit', true)
    await expect(setAgentPluginAgentAccess(USER, 'batshit', 'sa138_one', false)).rejects.toMatchObject({ code: 'PLUGIN_GLOBAL_ACCESS' })
    await setAgentPluginGlobalAccess(USER, 'batshit', false)
    expect((await getAgentPlugin(USER, 'batshit'))!.enabled_agent_ids.sort()).toEqual(['sa138_one', 'sa138_two'])
    await withSettingsRecordReplacement('agent:sa138_one', () => removeAgentPluginAgentReferences(USER, 'sa138_one', 'primary'))
    expect((await getAgentPlugin(USER, 'batshit'))!.enabled_agent_ids).toEqual(['sa138_two'])
  })
  it('uses one group gate for seven DCM entries and canonical/bare aliases across actor roles', async () => {
    await legacy(); await redis.json.set(key(row(6).id), '$', row(6)); await actor('sa138_one')
    await ensureBuiltinAgentPlugin(USER); await setAgentPluginAgentAccess(USER, 'batshit', 'sa138_one', true)
    const capabilities = await getEnabledAgentSlashCapabilities(USER, 'sa138_one')
    expect(capabilities).toHaveLength(7); expect(capabilities.every(item => item.invocation.startsWith('/batshit:'))).toBe(true)
    await redis.json.set(key('alias'), '$', { ...row(0), id: 'alias', enabled_for_all_agents: true })
    expect(await getEnabledAgentSlashCapabilities(USER, 'sa138_one')).toHaveLength(7)
    for (const skill of LEGACY_BUILTIN_PLUGIN_SKILLS) {
      expect((await resolveSkillAccessForActor(USER, `/batshit:${skill.commandId}`, { kind: 'agent', agentId: 'sa138_one', delegated: true })).ok).toBe(true)
      expect((await resolveSkillAccessForActor(USER, skill.skillId, { kind: 'agent', agentId: 'worker_denied', delegated: true })).ok).toBe(false)
    }
    expect((await resolveSkillAccessForActor(USER, 'goon_guide', { kind: 'none', lane: 'portable' })).ok).toBe(false)
    await expect(refusePluginMemberWrite(USER, row(0))).rejects.toMatchObject({ code: 'PLUGIN_MEMBER_USER_MANAGED' })
  })
  it('adds App Actions discovery and aliases only after a positively canonical eighth command exists', async () => {
    await legacy(); await redis.json.set(key(row(6).id), '$', row(6)); await actor('sa138_one')
    await ensureBuiltinAgentPlugin(USER); await setAgentPluginAgentAccess(USER, 'batshit', 'sa138_one', true)
    expect((await resolveSkillAccessForActor(USER, 'app_actions', { kind: 'agent', agentId: 'sa138_one' })).ok).toBe(false)
    await redis.json.set(key('app-actions'), '$', row(7, { plugin_id: 'batshit', is_system: true, skill_source: 'system' }))
    expect(await getEnabledAgentSlashCapabilities(USER, 'sa138_one')).toHaveLength(8)
    for (const alias of ['/batshit:app-actions', 'app_actions', 'app-actions']) {
      expect((await resolveSkillAccessForActor(USER, alias, { kind: 'agent', agentId: 'sa138_one', delegated: true })).ok).toBe(true)
      expect((await resolveSkillAccessForActor(USER, alias, { kind: 'agent', agentId: 'worker_denied', delegated: true })).ok).toBe(false)
    }
  })
  it.each([
    { label: 'non-system metadata', fields: { is_system: false } },
    { label: 'local source', fields: { skill_source: 'local' } },
    { label: 'foreign owner', fields: { user_id: 'another_owner' } },
    { label: 'foreign plugin', fields: { plugin_id: 'another.plugin' } },
    { label: 'missing plugin ownership', fields: { plugin_id: undefined } },
    { label: 'malformed identity at the known key', fields: { id: 'custom', skill_id: 'custom_skill', type: 'prompt', plugin_id: undefined } }
  ])('refuses a present eighth with $label without issuing writes or changing saved access', async ({ fields }) => {
    await legacy(); await redis.json.set(key(row(6).id), '$', row(6)); await actor('sa138_one')
    await ensureBuiltinAgentPlugin(USER); await setAgentPluginAgentAccess(USER, 'batshit', 'sa138_one', true)
    await redis.json.set(key('app-actions'), '$', row(7, { plugin_id: 'batshit', is_system: true, skill_source: 'system', ...fields }))
    const watched = [groupKey, key('app-actions'), slashCommandRevisionKey(USER)]
    const snapshot = () => Promise.all(watched.map(async savedKey => {
      const kind = await redis.execute(client => client.type(savedKey))
      return kind === 'ReJSON-RL' ? redis.json.getRaw(savedKey, '$') : redis.execute(client => client.get(savedKey))
    }))
    const before = await snapshot()
    vi.mocked(ensureSystemSlashCommands).mockClear()
    const writes: string[] = []
    const execute = redis.execute.bind(redis)
    vi.spyOn(redis, 'execute').mockImplementation(callback => execute(client => callback(new Proxy(Object.create(null), {
      get(_target, property) {
        const value = Reflect.get(client, property, client)
        const refuse = (name: string) => { writes.push(name); throw new Error(`Catalog attempted ${name}`) }
        if (property === 'json') return new Proxy(Object.create(null), { get(_json, method) {
          const operation = Reflect.get(value, method, value)
          if (typeof operation !== 'function') return operation
          return (...args: unknown[]) => ['get', 'mGet', 'type'].includes(String(method))
            ? operation.apply(value, args) : refuse(`json.${String(method)}`)
        } })
        if (property === 'sendCommand') return (args: string[]) => ['JSON.GET', 'TYPE', 'GET'].includes(args[0])
          ? value.call(client, args) : refuse(args[0])
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => ['keys', 'get', 'type', 'sMembers'].includes(String(property))
          ? value.apply(client, args) : refuse(String(property))
      }
    }))))
    await expect(getEnabledAgentSlashCapabilities(USER, 'sa138_one')).rejects.toMatchObject({ code: 'SYSTEM_SKILLS_UNAVAILABLE' })
    await expect(listAllSlashCapabilities(USER)).rejects.toMatchObject({ code: 'SYSTEM_SKILLS_UNAVAILABLE' })
    expect(writes).toEqual([])
    expect(await snapshot()).toEqual(before)
    expect(ensureSystemSlashCommands).not.toHaveBeenCalled()
  })
  it('refuses staged/removed imported members and separates namespace invocation from internal IDs', async () => {
    const command = { ...row(0), id: 'plugin_hash_skill', skill_id: 'plugin_hash_skill', plugin_id: 'example.plugin' }
    await expect(projectPluginCommand(USER, command)).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
    await registerAgentPlugin(USER, { id: 'example.plugin', name: 'Example', description: '', builtIn: false, version: '1', skills: [{ commandId: command.id, skillId: command.skill_id, name: 'Skill', invocation: '/example.plugin:skill' }], enabled_for_all_agents: false, enabled_agent_ids: [] })
    expect((await projectPluginCommand(USER, command)).invocation_pattern).toBe('/example.plugin:skill')
    const removing = await removeAgentPlugin(USER, 'example.plugin')
    expect(removing).toMatchObject({ removing: true, enabled_for_all_agents: false, enabled_agent_ids: [] })
    expect((await projectPluginCommand(USER, command)).is_active).toBe(false)
    expect(await removeAgentPlugin(USER, 'example.plugin')).toEqual(removing)
    await expect(setAgentPluginGlobalAccess(USER, 'example.plugin', true)).rejects.toMatchObject({ code: 'PLUGIN_REMOVING' })
    await expect(finishRemoveAgentPlugin(USER, 'example.plugin', 'stale-revision')).rejects.toMatchObject({ code: 'PLUGIN_ACCESS_CHANGED' })
    expect((await getAgentPlugin(USER, 'example.plugin'))?.removing).toBe(true)
    await finishRemoveAgentPlugin(USER, 'example.plugin', removing!.revision)
    await expect(projectPluginCommand(USER, command)).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
  })
  it('reports plugin members user-managed and refuses an unchanged one-skill App Actions request', () => {
    const command = row(0), alias = { key: key(command.id), raw: [], record: command }, subject = { kind: 'primary' as const, id: 'sa138_one' }
    const manifest = { ownerUserId: USER, entries: [{ subject, status: 'available', label: 'One' }], excluded: [] } as never
    expect(projectSkillAccess([alias], { skillIds: [command.skill_id!] }, manifest).rows[0]).toMatchObject({ effective: null, reason: 'plugin_user_managed' })
    const ctx = { assertCurrent() {}, admission: { actor: { userId: USER, kind: 'native', id: 'sa138_one' }, policy: { enabled: true, management: { skillAccess: 'allow' }, scope: { mode: 'all', except: [] } } } } as never
    expect(() => planSkillAccessChange(ctx, { owner: USER, manifest, aliases: [alias], collidingIds: [] } as never, { assignments: [{ skillId: command.skill_id!, enabled: false }] })).toThrow('plugin')
  })
  it('keeps an interrupted installation visible/off and only finishes its exact original revision', async () => {
    const installing = await registerAgentPlugin(USER, { id: 'incomplete', name: 'Incomplete', description: '', builtIn: false, version: '1', installing: true,
      skills: [{ commandId: 'plugin_stage', skillId: 'plugin_stage', name: 'Stage', invocation: '/incomplete:stage' }], enabled_for_all_agents: false, enabled_agent_ids: [] })
    expect((await listAgentPlugins(USER)).find(plugin => plugin.id === 'incomplete')?.installing).toBe(true)
    const command = { ...row(0), id: 'plugin_stage', skill_id: 'plugin_stage', plugin_id: 'incomplete' }
    expect((await projectPluginCommand(USER, command)).is_active).toBe(false)
    await expect(setAgentPluginGlobalAccess(USER, 'incomplete', true)).rejects.toMatchObject({ code: 'PLUGIN_INSTALLING' })
    await expect(finishAgentPluginImport(USER, 'incomplete', 'stale')).rejects.toMatchObject({ code: 'PLUGIN_ACCESS_CHANGED' })
    const ready = await finishAgentPluginImport(USER, 'incomplete', installing.revision)
    expect(ready.installing).toBeUndefined(); expect(ready.enabled_for_all_agents).toBe(false)
    expect((await projectPluginCommand(USER, command)).is_active).toBe(true)
    await expect(removeAgentPlugin(USER, 'incomplete', undefined, installing.revision)).rejects.toMatchObject({ code: 'PLUGIN_ACCESS_CHANGED' })
    expect((await getAgentPlugin(USER, 'incomplete'))?.removing).toBeUndefined()
    const removing = await removeAgentPlugin(USER, 'incomplete', undefined, ready.revision)
    expect(removing?.removing).toBe(true)
  })
  it('refuses a plugin record whose saved ID does not match the scanned key before subject deletion', async () => {
    const original = await registerAgentPlugin(USER, { id: 'right', name: 'Right', description: '', builtIn: false, version: '1',
      skills: [{ commandId: 'right', skillId: 'right', name: 'Right', invocation: '/right:right' }], enabled_for_all_agents: false, enabled_agent_ids: ['sa138_one'] })
    await redis.json.set(agentPluginKey(USER, 'wrong'), '$', original)
    await expect(withSettingsRecordReplacement('agent:sa138_one', () => removeAgentPluginAgentReferences(USER, 'sa138_one', 'primary'))).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
    expect(await redis.json.get(agentPluginKey(USER, 'wrong'))).toEqual(original)
  })
  it('retains unknown custody when a successful issued save has malformed readback', async () => {
    await expect(withSettingsRestoreFence(async () => 'baseline-clear')).resolves.toBe('baseline-clear')
    await legacy(); await ensureBuiltinAgentPlugin(USER)
    const original = redis.execute.bind(redis)
    let writes = 0
    vi.spyOn(redis, 'execute').mockImplementation(async callback => original(async client => {
      const eval_ = client.eval.bind(client), wrapper = Object.create(client)
      wrapper.eval = async (script: string, options: unknown) => {
        const answer = await eval_(script, options as never)
        if (script.includes("local op, value = ARGV[2], ARGV[3]")) { writes++; return ['OK', '{malformed'] }
        return answer
      }
      return callback(wrapper)
    }))
    await expect(setAgentPluginGlobalAccess(USER, 'batshit', true)).rejects.toMatchObject({ code: 'PLUGIN_SAVE_UNKNOWN', status: 503, outcome: 'unknown' })
    expect(writes).toBe(1)
    await expect(withSettingsRestoreFence(async () => 'must-not-replace')).rejects.toThrow('unknown outcome')
  })
  it('does not retry a write whose reply is lost after Redis saved the group', async () => {
    await legacy(); await ensureBuiltinAgentPlugin(USER)
    const original = redis.execute.bind(redis)
    let writes = 0
    vi.spyOn(redis, 'execute').mockImplementation(async callback => original(async client => {
      const eval_ = client.eval.bind(client), wrapper = Object.create(client)
      wrapper.eval = async (script: string, options: unknown) => {
        const answer = await eval_(script, options as never)
        if (script.includes("local op, value = ARGV[2], ARGV[3]")) { writes++; throw new Error('simulated lost reply after save') }
        return answer
      }
      return callback(wrapper)
    }))
    await expect(setAgentPluginGlobalAccess(USER, 'batshit', true)).rejects.toMatchObject({ code: 'PLUGIN_SAVE_UNKNOWN', status: 503, outcome: 'unknown' })
    expect(writes).toBe(1)
    expect((await getAgentPlugin(USER, 'batshit'))!.enabled_for_all_agents).toBe(true)
  })

  it('reports a lost upgrade acknowledgement as unknown without repeating its append', async () => {
    await redis.json.set(groupKey, '$', savedSeven({ enabled_agent_ids: ['retained'] }))
    const original = redis.execute.bind(redis)
    let writes = 0
    vi.spyOn(redis, 'execute').mockImplementation(async callback => original(async client => {
      const eval_ = client.eval.bind(client), wrapper = Object.create(client)
      wrapper.eval = async (script: string, options: unknown) => {
        const result = await eval_(script, options as never)
        if (script === UPGRADE_BUILTIN_PLUGIN_SCRIPT) { writes++; throw new Error('lost reply after upgrade') }
        return result
      }
      return callback(wrapper)
    }))
    await expect(ensureBuiltinAgentPlugin(USER)).rejects.toMatchObject({ code: 'PLUGIN_SAVE_UNKNOWN', outcome: 'unknown' })
    expect(writes).toBe(1)
    expect((await redis.json.get(groupKey) as any).skills).toHaveLength(8)
    expect((await redis.json.get(groupKey) as any).enabled_agent_ids).toEqual(['retained'])
  })

  it.each(['partial', 'malformed_success'] as const)('a simulated %s issued upgrade is held across later catalogue reads rather than automatically repeated', async (kind) => {
    const owner = `${USER}_${kind}`, ownedKey = agentPluginKey(owner, 'batshit')
    await redis.json.set(ownedKey, '$', savedSeven({ user_id: owner }))
    const original = redis.execute.bind(redis)
    let writes = 0
    vi.spyOn(redis, 'execute').mockImplementation(async callback => original(async client => {
      const eval_ = client.eval.bind(client), wrapper = Object.create(client)
      wrapper.eval = async (script: string, options: unknown) => {
        if (script === UPGRADE_BUILTIN_PLUGIN_SCRIPT) { writes++; return kind === 'partial' ? ['PARTIAL', '0'] : ['UPGRADED', 'unexpected'] }
        return eval_(script, options as never)
      }
      return callback(wrapper)
    }))
    try {
      await expect(ensureBuiltinAgentPlugin(owner)).rejects.toMatchObject({ code: 'PLUGIN_SAVE_UNKNOWN', outcome: 'unknown' })
      await expect(ensureBuiltinAgentPlugin(owner)).rejects.toMatchObject({ code: 'PLUGIN_SAVE_UNKNOWN', outcome: 'unknown' })
      expect(writes).toBe(1)
      expect((await redis.json.get(ownedKey) as any).skills).toHaveLength(7)
    } finally { await redis.del(ownedKey) }
  })

})
