import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { SkillSourceRow, SlashCommandRow } from '$lib/types/database'
import { withSettingsRestoreFence } from '../appActions/settings/lifecycle'
import {
  beginSlashCommandWrite, currentSlashCommandWriteRevision, captureSlashCommandWriteBasis, captureSkillSourceWriteBasis,
  COMMAND_ACCESS_FIELDS, deleteSlashCommandRecord, readSlashCommandRevision, saveSlashCommandBatch,
  saveSlashCommandRecord, slashCommandRevisionKey, saveSkillSourceRecord, updateSkillSourceScan,
  removeExplicitSkillSourceAgentAccess, WRITE_SLASH_COMMANDS_SCRIPT
} from '../slashCommandRevision'
import { removeExplicitSlashCommandAgentAccess, setSlashCommandAgentAccess } from '../agentAccessLists'

// Actual fixed Lua/basis proof. A owns process admission and the exclusive worker slot.
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'skill_revision_test'
const key = (id: string) => `slash_command:${USER}:${id}`
const SOURCE = `skill_source:${USER}:source`
const FIXTURE_KEYS = [key('one'), key('legacy'), key('missing'), key('second'), SOURCE, slashCommandRevisionKey(USER)]
const command = (id: string, fields: Partial<SlashCommandRow> = {}): SlashCommandRow => ({
  id, user_id: USER, name: id, type: 'skill', skill_id: 'notes', enabled_agent_ids: ['A-B'],
  enabled_for_all_agents: false, is_active: true, can_be_invoked_in_chat: true,
  created_at: '2026-10-17T00:00:00.000Z', updated_at: '2026-10-17T00:00:00.000Z', ...fields
})
const source = (fields: Partial<SkillSourceRow> = {}): SkillSourceRow => ({ id: 'source', user_id: USER,
  label: 'Owned source', root_path: '/owned/fixture', scope: 'global', enabled_agent_ids: ['A-B', 'kept'],
  created_at: 'same-original-date', updated_at: 'same-original-date', ...fields })
const basis = (ids: string[]) => captureSlashCommandWriteBasis(beginSlashCommandWrite(USER), ids)
const save = async (write: Parameters<typeof saveSlashCommandRecord>[1]) => saveSlashCommandRecord(USER, write, await basis([write.record.id]))
const remove = async (id: string) => deleteSlashCommandRecord(USER, id, await basis([id]))
const sourceBasis = () => captureSkillSourceWriteBasis(beginSlashCommandWrite(USER), 'source')

describe.runIf(REAL)('physical command mutation revision and original preparation owner', () => {
  const admission = useRedisTestServer()
  beforeEach(() => admission.requireAdmission())
  afterEach(async () => { vi.restoreAllMocks(); admission.requireAdmission(); for (const key of FIXTURE_KEYS) await redis.del(key) })
  afterAll(() => redis.disconnect())

  it('admits legacy absence and advances only for physical mutations, with explicit no-effect conflicts', async () => {
    const original = beginSlashCommandWrite(USER)
    expect(() => currentSlashCommandWriteRevision(original)).toThrow('not captured')
    await captureSlashCommandWriteBasis(original, [])
    expect(currentSlashCommandWriteRevision(original)).toBeNull()
    expect(await readSlashCommandRevision(USER)).toBeNull()
    expect(await remove('missing')).toBe(false)
    expect(await readSlashCommandRevision(USER)).toBeNull()
    await save({ record: command('one'), mode: 'create' })
    const first = await readSlashCommandRevision(USER)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    await expect(save({ record: command('one'), mode: 'create' })).rejects.toMatchObject({ outcome: 'not_written', code: 'SLASH_COMMAND_CONFLICT', status: 409 })
    expect(await readSlashCommandRevision(USER)).toBe(first)
    await remove('one')
    expect(await readSlashCommandRevision(USER)).not.toBe(first)
  })

  it('preserves current exact access and absence when metadata preparation uses a current basis', async () => {
    const old = command('one')
    await save({ record: old, mode: 'create' })
    await redis.json.set(key('one'), '$.enabled_agent_ids', ['bystander', 'a_b'] as never)
    await redis.json.set(key('one'), '$.is_active', false)
    const held = await basis(['one'])
    await redis.json.set(key('one'), '$.usage_count', 9)
    await redis.json.set(key('one'), '$.last_used_at', 'live-invocation')
    const result = await saveSlashCommandRecord(USER, { record: { ...old, description: 'new metadata' }, mode: 'update', preserveAccess: COMMAND_ACCESS_FIELDS }, held)
    expect(result).toMatchObject({ enabled_agent_ids: ['bystander', 'a_b'], is_active: false, description: 'new metadata', usage_count: 9, last_used_at: 'live-invocation' })
    const absent = command('legacy'); Reflect.deleteProperty(absent, 'enabled_agent_ids')
    await save({ record: absent, mode: 'create' })
    const legacy = await save({ record: command('legacy'), mode: 'update', preserveAccess: COMMAND_ACCESS_FIELDS })
    expect(Object.hasOwn(legacy!, 'enabled_agent_ids')).toBe(false)
  })

  it('merges explicit source assignments against exact bystanders', async () => {
    await save({ record: command('one'), mode: 'create' })
    const result = await save({ record: command('one', { enabled_agent_ids: [] }), mode: 'update',
      preserveAccess: COMMAND_ACCESS_FIELDS, mergeAgentIds: ['a_b', 'C-D', 'odd.id'] })
    expect(result?.enabled_agent_ids).toEqual(['A-B', 'a_b', 'C-D', 'odd.id'])
    expect(result?.enabled_for_all_agents).toBe(false)
  })

  it('rejects a complete invalid bulk before its first record or revision mutation', async () => {
    await save({ record: command('one'), mode: 'create' })
    const revision = await readSlashCommandRevision(USER)
    const original = await redis.json.get(key('one'))
    const result = await saveSlashCommandBatch(USER, [
      { record: command('one', { name: 'changed' }), mode: 'update' },
      { record: command('missing'), mode: 'update' }
    ], await basis(['one', 'missing']))
    expect(result).toBeNull()
    expect(await readSlashCommandRevision(USER)).toBe(revision)
    expect(await redis.json.get(key('one'))).toEqual(original)
    await expect(withSettingsRestoreFence(async () => 'known-no-effect-settled')).resolves.toBe('known-no-effect-settled')
  })

  it('closes identical alias ABA and refuses a stale basis instead of adopting a new nonce', async () => {
    const original = command('one')
    await save({ record: original, mode: 'create' })
    const preparation = beginSlashCommandWrite(USER)
    const held = await captureSlashCommandWriteBasis(preparation, ['one'])
    await remove('one'); await save({ record: original, mode: 'create' })
    const replacementRevision = await readSlashCommandRevision(USER)
    await expect(saveSlashCommandRecord(USER, { record: command('one', { enabled_agent_ids: [] }), mode: 'update' }, held)).rejects.toMatchObject({ outcome: 'not_written', code: 'SLASH_COMMAND_CONFLICT' })
    await expect(captureSlashCommandWriteBasis(preparation, ['one'])).rejects.toMatchObject({ code: 'SLASH_COMMAND_CONFLICT' })
    expect(await readSlashCommandRevision(USER)).toBe(replacementRevision)
    expect((await redis.json.get(key('one')) as SlashCommandRow).enabled_agent_ids).toEqual(['A-B'])
  })

  it('pins the original lifecycle before preparation and rechecks after awaited client acquisition', async () => {
    await save({ record: command('one'), mode: 'create' })
    const original = beginSlashCommandWrite(USER)
    await withSettingsRestoreFence(async () => {})
    await expect(captureSlashCommandWriteBasis(original, ['one'])).rejects.toMatchObject({ outcome: 'not_written' })
    const held = await basis(['one'])
    const execute = redis.execute.bind(redis)
    vi.spyOn(redis, 'execute').mockImplementationOnce(operation => execute(async client => {
      await withSettingsRestoreFence(async () => {})
      return operation(client)
    }))
    await expect(saveSlashCommandRecord(USER, { record: command('one', { enabled_agent_ids: [] }), mode: 'update' }, held)).rejects.toMatchObject({ outcome: 'not_written' })
    expect((await redis.json.get(key('one')) as SlashCommandRow).enabled_agent_ids).toEqual(['A-B'])
  })

  it('allows only its own confirmed nonce chain during a fixed source scan and preserves access in bookkeeping', async () => {
    await saveSkillSourceRecord(source(), await sourceBasis())
    const preparation = beginSlashCommandWrite(USER)
    const pinned = await captureSkillSourceWriteBasis(preparation, 'source')
    for (const id of ['one', 'second']) {
      const held = await captureSlashCommandWriteBasis(preparation, [id], pinned)
      await saveSlashCommandRecord(USER, { record: command(id), mode: 'create' }, held)
    }
    expect(currentSlashCommandWriteRevision(preparation)).toBe(await readSlashCommandRevision(USER))
    const checked = await updateSkillSourceScan(USER, 'source', { last_scan_status: 'success', updated_at: 'scan-finished', discovered_command_ids: ['one', 'second'] }, pinned)
    expect(checked).toMatchObject({ enabled_agent_ids: ['A-B', 'kept'], root_path: '/owned/fixture', last_scan_status: 'success', discovered_command_ids: ['one', 'second'] })
  })

  it('refuses changed or identical-replaced source configuration at alias issue and sparse bookkeeping', async () => {
    await saveSkillSourceRecord(source(), await sourceBasis())
    const preparation = beginSlashCommandWrite(USER)
    const pinned = await captureSkillSourceWriteBasis(preparation, 'source')
    const held = await captureSlashCommandWriteBasis(preparation, ['one'], pinned)
    await saveSkillSourceRecord(source({ enabled_agent_ids: ['replacement'] }), await sourceBasis())
    await saveSkillSourceRecord(source(), await sourceBasis())
    await expect(saveSlashCommandRecord(USER, { record: command('one'), mode: 'create' }, held)).rejects.toMatchObject({ code: 'SLASH_COMMAND_CONFLICT', outcome: 'not_written' })
    await expect(updateSkillSourceScan(USER, 'source', { last_scan_status: 'error', updated_at: 'old-scan' }, pinned)).rejects.toMatchObject({ code: 'SLASH_COMMAND_CONFLICT' })
    expect(await redis.exists(key('one'))).toBe(false)
    expect((await redis.json.get(SOURCE) as SkillSourceRow).updated_at).toBe('same-original-date')
  })

  it('scrubs a source explicit ID without converting absent universal access or changing siblings', async () => {
    await saveSkillSourceRecord(source(), await sourceBasis())
    expect(await removeExplicitSkillSourceAgentAccess(USER, 'source', 'A-B', await sourceBasis())).toBe(true)
    expect(await redis.json.get(SOURCE)).toMatchObject({ enabled_agent_ids: ['kept'], label: 'Owned source' })
    const absent = source(); Reflect.deleteProperty(absent, 'enabled_agent_ids')
    await saveSkillSourceRecord(absent, await sourceBasis())
    const revision = await readSlashCommandRevision(USER)
    expect(await removeExplicitSkillSourceAgentAccess(USER, 'source', 'A-B', await sourceBasis())).toBe(false)
    expect(await readSlashCommandRevision(USER)).toBe(revision)
    expect(Object.hasOwn(await redis.json.get(SOURCE) as object, 'enabled_agent_ids')).toBe(false)
    // Deletion is exact equality, never new-grant validation or stored-data migration.
    const legacyEntries = ['odd.id', 'odd_id', 7, [], { keep: [] }, 'odd.id']
    await saveSkillSourceRecord(source({ enabled_agent_ids: legacyEntries as never }), await sourceBasis())
    expect(await removeExplicitSkillSourceAgentAccess(USER, 'source', 'odd.id', await sourceBasis())).toBe(true)
    expect(await redis.json.get(SOURCE)).toMatchObject({ enabled_agent_ids: ['odd_id', 7, [], { keep: [] }] })
    await save({ record: command('legacy', { enabled_agent_ids: legacyEntries as never }), mode: 'create' })
    expect(await removeExplicitSlashCommandAgentAccess(USER, 'legacy', 'odd.id', await basis(['legacy']))).toBe('OK')
    expect(await redis.json.get(key('legacy'))).toMatchObject({ enabled_agent_ids: ['odd_id', 7, [], { keep: [] }] })
    await redis.json.set(key('legacy'), '$.enabled_agent_ids', legacyEntries as never)
    expect(await setSlashCommandAgentAccess(USER, 'legacy', 'odd.id', false, await basis(['legacy']))).toBe('OK')
    expect(await redis.json.get(key('legacy'))).toMatchObject({ enabled_agent_ids: ['odd_id', 7, [], { keep: [] }] })
  })

  it('compares held raw access and source configuration even when a fixture bypasses nonce rotation', async () => {
    await save({ record: command('one'), mode: 'create' })
    const held = await basis(['one'])
    await redis.json.set(key('one'), '$.enabled_agent_ids', ['raw-current'] as never)
    await expect(saveSlashCommandRecord(USER, { record: command('one'), mode: 'update' }, held)).rejects.toMatchObject({ outcome: 'not_written' })
    await saveSkillSourceRecord(source(), await sourceBasis())
    const preparation = beginSlashCommandWrite(USER)
    const pinned = await captureSkillSourceWriteBasis(preparation, 'source')
    const alias = await captureSlashCommandWriteBasis(preparation, ['second'], pinned)
    await redis.json.set(SOURCE, '$.enabled_agent_ids', ['current-source'] as never)
    await expect(saveSlashCommandRecord(USER, { record: command('second'), mode: 'create' }, alias)).rejects.toMatchObject({ outcome: 'not_written' })
    expect(await redis.exists(key('second'))).toBe(false)
    expect(await redis.json.get(SOURCE)).toMatchObject({ enabled_agent_ids: ['current-source'] })
  })

  it('refuses malformed revision state instead of resetting it', async () => {
    await redis.json.set(key('one'), '$', command('one') as never)
    await redis.set(slashCommandRevisionKey(USER), 'not-a-nonce')
    await expect(readSlashCommandRevision(USER)).rejects.toThrow('unreadable')
    await expect(basis(['one'])).rejects.toMatchObject({ outcome: 'not_written' })
    expect((await redis.json.get(key('one')) as SlashCommandRow).enabled_agent_ids).toEqual(['A-B'])
    expect(await redis.get(slashCommandRevisionKey(USER))).toBe('not-a-nonce')
  })

  // Unknown holds process-local restore custody, so it is deliberately the final case.
  it('holds an ambiguous issued write, never replays it, and fences its actual late EVAL after replacement', async () => {
    await save({ record: command('one'), mode: 'create' })
    const preparation = beginSlashCommandWrite(USER)
    const held = await captureSlashCommandWriteBasis(preparation, ['one'])
    const execute = redis.execute.bind(redis)
    let captured: { keys: string[]; arguments: string[] } | undefined
    vi.spyOn(redis, 'execute').mockImplementationOnce(operation => execute(client => operation(new Proxy(client, {
      get(target, property) {
        if (property === 'eval') return async (script: string, options: typeof captured) => {
          expect(script).toBe(WRITE_SLASH_COMMANDS_SCRIPT); captured = options; throw new Error('lost reply')
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }))))
    await expect(saveSlashCommandRecord(USER, { record: command('one', { enabled_agent_ids: [] }), mode: 'update' }, held)).rejects.toMatchObject({ outcome: 'unknown', status: 503 })
    vi.restoreAllMocks()
    await expect(saveSlashCommandRecord(USER, { record: command('one'), mode: 'update' }, held)).rejects.toMatchObject({ outcome: 'not_written' })
    await expect(withSettingsRestoreFence(async () => 'must-not-run')).rejects.toThrow('unknown outcome')
    await remove('one'); await save({ record: command('one', { enabled_agent_ids: ['replacement'] }), mode: 'create' })
    expect(await execute(client => client.eval(WRITE_SLASH_COMMANDS_SCRIPT, captured!))).toEqual(['CONFLICT'])
    expect((await redis.json.get(key('one')) as SlashCommandRow).enabled_agent_ids).toEqual(['replacement'])
  })
})
