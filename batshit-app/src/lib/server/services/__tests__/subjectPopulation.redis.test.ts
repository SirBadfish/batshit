import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { withSettingsRecordReplacement } from '../appActions/settings/lifecycle'
import { createSubjectPopulation, deletePrimaryPopulation, deleteSubagentPopulation, CREATE_SUBJECT_POPULATION_SCRIPT } from '../subjectPopulation'
import { newSlashCommandRevision, slashCommandRevisionKey } from '../slashCommandRevisionProtocol'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'p3_population_fixture'
const PRIMARY = 'p3_population_primary'
const SUB = 'p3_population_subagent'
const LEGACY = 'p3_population.legacy'
const COLLISION = 'p3_population_shared'
const REVISION = slashCommandRevisionKey(USER)
const KEYS = [`agent:${LEGACY}`, `subagent:${LEGACY}`, `whiteboard:p3_population_legacy:${LEGACY}`, `agent:${COLLISION}`, `subagent:${COLLISION}`, `agent:${PRIMARY}`, `agent:${PRIMARY}:subagents`, `subagent:${SUB}`, `user:${USER}:agents`, `user:${USER}:subagents`, REVISION,
  `whiteboard:p3_population_session:${PRIMARY}`, `whiteboard:p3_population_other:${PRIMARY}`]
const row = (id: string) => ({ id, user_id: USER, created_at: '2026-10-17T00:00:00.000Z', displayName: 'Fixture', extension: { keep: true }, provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false, artifactRuntimeEnabled: true } } })
const create = (kind: 'primary' | 'subagent', mode: 'create' | 'replace-owned' = kind === 'primary' ? 'replace-owned' : 'create') => {
  const id = kind === 'primary' ? PRIMARY : SUB
  return withSettingsRecordReplacement(`${kind === 'primary' ? 'agent' : 'subagent'}:${id}`, () => redis.execute(client =>
    createSubjectPopulation(client, { userId: USER, subjectId: id, kind, mode, record: row(id) }).then(result => result.status)))
}

describe.runIf(REAL)('atomic subject population and catalogue nonce on the admitted Redis boundary', () => {
  const admission = useSkillSessionRedisTestServer()
  beforeEach(() => admission.requireAdmission())
  afterEach(async () => { admission.requireAdmission(); for (const key of KEYS) await redis.del(key) })

  it.each(['primary', 'subagent'] as const)('creates %s record, exact index and nonce together', async kind => {
    expect(await create(kind)).toBe('CREATED')
    const id = kind === 'primary' ? PRIMARY : SUB
    expect(await redis.json.get(`${kind === 'primary' ? 'agent' : 'subagent'}:${id}`)).toEqual(row(id))
    expect(await redis.execute(client => client.sMembers(`user:${USER}:${kind === 'primary' ? 'agents' : 'subagents'}`))).toEqual([id])
    expect(await redis.get(REVISION)).toMatch(/^[a-f0-9]{64}$/)
  })
  it('stores no zip row in a new Primary record, and keeps the rows its caller chose (SA-126, 2026-10-19)', async () => {
    const zipRows = (record: unknown) => Object.fromEntries(Object.entries(record as Record<string, unknown>)
      .filter(([key]) => /^(buffer_size|zip_threshold|auto_zip|zip_disabled)_/.test(key)))
    await redis.createAgent({ id: PRIMARY, user_id: USER, displayName: 'Fixture', agentType: 'api' })
    expect(zipRows(await redis.json.get(`agent:${PRIMARY}`))).toEqual({})
    await redis.del(`agent:${PRIMARY}`)
    await redis.createAgent({ id: PRIMARY, user_id: USER, displayName: 'Fixture', agentType: 'api',
      buffer_size_read_file: 4, auto_zip_edit_file: false })
    expect(zipRows(await redis.json.get(`agent:${PRIMARY}`))).toEqual({ buffer_size_read_file: 4, auto_zip_edit_file: false })
  })
  it('preserves Primary owned replacement and Subagent create-only refusal with no nonce advance on refusal', async () => {
    await create('primary'); await create('subagent')
    const before = await redis.get(REVISION)
    await expect(create('subagent')).rejects.toMatchObject({ code: 'SUBJECT_POPULATION_CONFLICT', uncertain: false })
    expect(await redis.get(REVISION)).toBe(before)
    expect(await create('primary')).toBe('REPLACED')
    expect(await redis.get(REVISION)).not.toBe(before)
  })
  it('preserves saved historical alias fields while creating a live API subject', async () => {
    const record = { ...row(PRIMARY), agentType: 'api', claude_settings: { profileId: 'batshit_agent_old_alias', future: 'keep' },
      provider_specific_settings: { ...row(PRIMARY).provider_specific_settings, claude_profile_id: 'batshit_agent_other_alias' } }
    await withSettingsRecordReplacement(`agent:${PRIMARY}`, () => redis.execute(client =>
      createSubjectPopulation(client, { userId: USER, subjectId: PRIMARY, kind: 'primary', mode: 'create', record })))
    expect(await redis.json.get(`agent:${PRIMARY}`)).toMatchObject({ claude_settings: record.claude_settings,
      provider_specific_settings: { claude_profile_id: 'batshit_agent_other_alias' } })
  })

  it('holds Subagent population issue behind its canonical shared folder deletion turn', async () => {
    const { withProfileFolderTurn } = await import('../agentProfileFolderQueue')
    let entered!: () => void, release!: () => void, issues = 0
    const ready = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const folder = withProfileFolderTurn('batshit_agent_subagent_cli_shared', async () => { entered(); await held })
    const client = await redis.execute(async value => value), evaluate = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementation((async (script: string, command: any) => {
      if (script === CREATE_SUBJECT_POPULATION_SCRIPT) issues++
      return evaluate(script, command)
    }) as never)
    await ready
    const creating = withSettingsRecordReplacement(`subagent:${SUB}`, () => redis.execute(actual =>
      createSubjectPopulation(actual, { userId: USER, subjectId: SUB, kind: 'subagent', mode: 'create', record: { ...row(SUB), slug: 'shared' } })))
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      expect(issues).toBe(0)
      expect(await redis.exists(`subagent:${SUB}`)).toBe(false)
    } finally { release() }
    try {
      await folder
      await expect(creating).resolves.toMatchObject({ status: 'CREATED' })
      expect(issues).toBe(1)
    } finally { spy.mockRestore() }
  })
  it('refuses an intervening raw replacement and foreign ownership before nonce, record or index mutation', async () => {
    await create('primary')
    const beforeNonce = await redis.get(REVISION)
    const expected = await redis.execute(client => client.sendCommand(['JSON.GET', `agent:${PRIMARY}`, '$'])) as string
    await redis.json.set(`agent:${PRIMARY}`, '$.displayName', 'Intervening')
    const current = await redis.json.get(`agent:${PRIMARY}`)
    const invoke = (raw: string) => redis.execute(client => client.eval(CREATE_SUBJECT_POPULATION_SCRIPT, {
      keys: [`agent:${PRIMARY}`, `user:${USER}:agents`, REVISION, `subagent:${PRIMARY}`], arguments: [raw, JSON.stringify(row(PRIMARY)), PRIMARY, USER, 'replace-owned', newSlashCommandRevision()]
    }))
    expect(await invoke(expected)).toBe('CONFLICT')
    await redis.json.set(`agent:${PRIMARY}`, '$.user_id', 'foreign')
    expect(await invoke(expected)).toBe('FORBIDDEN')
    expect(await redis.get(REVISION)).toBe(beforeNonce)
    expect(await redis.json.get(`agent:${PRIMARY}`)).toEqual({ ...current as object, user_id: 'foreign' })
  })
  it.each(['index', 'revision'] as const)('preflights invalid %s before a create has any effect', async invalid => {
    await redis.set(invalid === 'index' ? `user:${USER}:subagents` : REVISION, 'wrong-shape')
    await expect(create('subagent')).rejects.toMatchObject({ uncertain: false })
    expect(await redis.exists(`subagent:${SUB}`)).toBe(false)
    if (invalid === 'index') expect(await redis.exists(REVISION)).toBe(false)
    else expect(await redis.exists(`user:${USER}:subagents`)).toBe(false)
  })
  it('deletes Subagent record and index together, rotates identical recreation, and keeps missing deletion a no-op', async () => {
    await create('subagent')
    const old = await redis.get(REVISION)
    const remove = async () => { const removedRevision = await redis.get(REVISION) as string | null; return withSettingsRecordReplacement(`subagent:${SUB}`, () => redis.execute(client => deleteSubagentPopulation(client, { userId: USER, subjectId: SUB, expectedCatalogueRevision: removedRevision }))) }
    expect(await remove()).toBe('DELETED')
    const removed = await redis.get(REVISION)
    expect(removed).not.toBe(old)
    expect(await redis.exists(`subagent:${SUB}`)).toBe(false)
    expect(await redis.execute(client => client.sMembers(`user:${USER}:subagents`))).toEqual([])
    expect(await remove()).toBe('MISSING')
    expect(await redis.get(REVISION)).toBe(removed)
    await create('subagent')
    expect(await redis.get(REVISION)).not.toBe(removed)
    expect(await redis.json.get(`subagent:${SUB}`)).toEqual(row(SUB))
  })
  it('retains full Whiteboard preflight before any Primary or population deletion', async () => {
    await create('primary')
    const board = `whiteboard:p3_population_session:${PRIMARY}`
    await redis.json.set(board, '$', { schema_version: 1, agent_id: PRIMARY, user_id: 'foreign', session_id: 'p3_population_session', content: 'keep' })
    const before = await redis.get(REVISION)
    const remove = () => withSettingsRecordReplacement(`agent:${PRIMARY}`, () => redis.execute(client => deletePrimaryPopulation(client, { userId: USER, subjectId: PRIMARY, expectedCatalogueRevision: before as string | null })))
    await expect(remove()).rejects.toMatchObject({ uncertain: false })
    expect(await redis.get(REVISION)).toBe(before)
    expect(await redis.json.get(`agent:${PRIMARY}`)).toEqual(row(PRIMARY))
    expect(await redis.execute(client => client.sMembers(`user:${USER}:agents`))).toEqual([PRIMARY])
    await redis.json.set(board, '$.user_id', USER)
    await redis.execute(client => client.sAdd(`agent:${PRIMARY}:subagents`, SUB))
    expect(await remove()).toBe('DELETED')
    expect(await redis.get(REVISION)).not.toBe(before)
    expect(await redis.exists(board)).toBe(false)
    expect(await redis.exists(`agent:${PRIMARY}:subagents`)).toBe(false)
    expect(await redis.exists(`agent:${PRIMARY}`)).toBe(false)
    expect(await redis.execute(client => client.sMembers(`user:${USER}:agents`))).toEqual([])
  })
  it('atomically preserves cross-kind ID separation during concurrent opposite-kind create (BL-187)', async () => {
    const results = await Promise.allSettled((['primary', 'subagent'] as const).map(kind =>
      withSettingsRecordReplacement(`${kind === 'primary' ? 'agent' : 'subagent'}:${COLLISION}`, () => redis.execute(client =>
        createSubjectPopulation(client, { userId: USER, subjectId: COLLISION, kind, mode: 'create', record: row(COLLISION) })))))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ uncertain: false, status: 409, code: 'SUBJECT_POPULATION_CONFLICT' })
    const present = await Promise.all([redis.exists(`agent:${COLLISION}`), redis.exists(`subagent:${COLLISION}`)])
    expect(present.filter(Boolean)).toHaveLength(1)
    const ids = await redis.execute(async client => [await client.sMembers(`user:${USER}:agents`), await client.sMembers(`user:${USER}:subagents`)])
    expect(ids.flat()).toEqual([COLLISION])
  })

  it.each(['primary', 'subagent'] as const)('deletes an exact legacy %s ID through the existing owner while creation stays canonical', async kind => {
    const key = `${kind === 'primary' ? 'agent' : 'subagent'}:${LEGACY}`
    await redis.json.set(key, '$', row(LEGACY))
    await redis.execute(client => client.sAdd(`user:${USER}:${kind === 'primary' ? 'agents' : 'subagents'}`, LEGACY))
    if (kind === 'primary') await redis.json.set(`whiteboard:p3_population_legacy:${LEGACY}`, '$', {
      schema_version: 1, agent_id: LEGACY, user_id: USER, session_id: 'p3_population_legacy', content: 'Owned legacy board.' })
    const revision = await redis.get(REVISION) as string | null
    const removed = await withSettingsRecordReplacement(key, () => redis.execute(client => (kind === 'primary' ? deletePrimaryPopulation : deleteSubagentPopulation)(client, { userId: USER, subjectId: LEGACY, expectedCatalogueRevision: revision })))
    expect(removed).toBe('DELETED')
    expect(await redis.exists(key)).toBe(false)
    expect(await redis.exists(`whiteboard:p3_population_legacy:${LEGACY}`)).toBe(false)
    expect(await redis.execute(client => client.sMembers(`user:${USER}:${kind === 'primary' ? 'agents' : 'subagents'}`))).toEqual([])
  })

  it.each(['primary', 'subagent'] as const)('retains the %s record/index when the captured cleanup nonce changes before final deletion', async kind => {
    await create(kind)
    const expectedCatalogueRevision = await redis.get(REVISION) as string | null
    const changed = newSlashCommandRevision()
    await redis.set(REVISION, changed)
    const id = kind === 'primary' ? PRIMARY : SUB, key = `${kind === 'primary' ? 'agent' : 'subagent'}:${id}`
    await expect(withSettingsRecordReplacement(key, () => redis.execute(client => (kind === 'primary' ? deletePrimaryPopulation : deleteSubagentPopulation)(client,
      { userId: USER, subjectId: id, expectedCatalogueRevision })))).rejects.toMatchObject({ code: 'SUBJECT_POPULATION_CONFLICT', uncertain: false, status: 409 })
    expect(await redis.json.get(key)).toEqual(row(id))
    expect(await redis.get(REVISION)).toBe(changed)
    expect(await redis.execute(client => client.sMembers(`user:${USER}:${kind === 'primary' ? 'agents' : 'subagents'}`))).toEqual([id])
  })

})
