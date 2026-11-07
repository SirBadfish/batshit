// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { nativePolicyResponse, saveNativePolicy, policyContainsSubject } from './authority'
import { admitSettingsManagementActor, refreshSettingsOperationAuthority } from './managementActor'
import { withSettingsRecordReplacement, assertSettingsLifecycle } from './lifecycle'
import { createSettingsSubjectResolver } from './subjects'
import { readSkillAccess, skillAccessSnapshot } from './skillAccessReport'
import { prepareSkillAccessChange, commitSkillAccessChange } from './skillAccessOperations'
import { beginSlashCommandWrite, captureSlashCommandWriteBasis, deleteSlashCommandRecord as physicalDelete, readSlashCommandRevision, saveSlashCommandRecord as physicalSave } from '../../slashCommandRevision'
import { createSubjectPopulation } from '../../subjectPopulation'
import { CONDITIONAL_SKILL_ACCESS_SCRIPT } from './conditionalSkillAccess'
import type { AdapterCommitContext } from '../managementTypes'
import type { AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import type { SlashCommandRow } from '$lib/types/database'

// Actual metadata/Lua/custody owner proof. This test worker is not a production actor.
// Native route/managed Stop/consent proof remains the existing shared owner's boundary.
vi.mock('../runtime', () => ({ requireAppActionTopology() {} }))
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const admission = useRedisTestServer()
beforeEach(() => { if (REAL) admission.requireAdmission() })
afterAll(async () => { if (REAL) await redis.disconnect() })
const USER = 'p4_owner'
const ACTOR = 'p4_actor'
const A = 'P4-A'
const B = 'p4_a'
const RETAINED = 'p4_retained'
const FIXTURE_KEYS = [`agent:${ACTOR}`, `agent:${A}`, `subagent:${B}`, `agent:${RETAINED}`, `user:${USER}:agents`, `user:${USER}:subagents`, `slash_command:${USER}:one`, `slash_command:${USER}:two`, `slash_command:${USER}:new_alias`, `slash_command_revision:${USER}`]
afterEach(async () => { if (REAL) { admission.requireAdmission(); for (const key of FIXTURE_KEYS) await redis.del(key) } })
const CREATED = '2026-10-17T00:00:00.000Z'
function command(id: string, extra: Partial<SlashCommandRow> = {}): SlashCommandRow {
  return { id, user_id: USER, type: 'skill', name: 'Notes', displayName: 'Notes', skill_id: 'notes',
    enabled_agent_ids: [], enabled_for_all_agents: false, is_active: true, can_be_invoked_in_chat: true,
    created_at: CREATED, updated_at: CREATED, ...extra }
}
async function saveSlashCommandRecord(userId: string, write: Parameters<typeof physicalSave>[1]) {
  return physicalSave(userId, write, await captureSlashCommandWriteBasis(beginSlashCommandWrite(userId), [write.record.id]))
}
async function deleteSlashCommandRecord(userId: string, id: string) {
  return physicalDelete(userId, id, await captureSlashCommandWriteBasis(beginSlashCommandWrite(userId), [id]))
}
async function fixture(selection: unknown = { subjects: [{ kind: 'primary', id: A }, { kind: 'subagent', id: B }] }, unsupportedPopulation = false) {
  await redis.createAgent({ id: ACTOR, user_id: USER, agentType: 'api', displayName: 'Actor', created_at: CREATED })
  await redis.createAgent({ id: A, user_id: USER, agentType: 'api', displayName: 'Exact A', created_at: CREATED })
  await redis.json.set(`subagent:${B}`, '$', { id: B, user_id: USER, subagentType: 'api', displayName: 'Exact B', created_at: CREATED })
  await redis.sAdd(`user:${USER}:subagents`, B)
  if (unsupportedPopulation) {
    await redis.json.set(`agent:${RETAINED}`, '$', { id: RETAINED, user_id: USER, agentType: 'retired', created_at: CREATED } as never)
    await redis.sAdd(`user:${USER}:agents`, RETAINED)
  }
  const baseline = await nativePolicyResponse(USER, ACTOR)
  const policy = { ...defaultAppActionsPolicy(), enabled: true, scope: { mode: 'all' as const, subjects: [], except: [] } }
  policy.management.skillAccess = 'allow'
  await saveNativePolicy(USER, ACTOR, { expectedGeneration: baseline.generation, expectedSubjectRevision: baseline.subjectRevision, policy })
  const abort = new AbortController()
  const admission = await admitSettingsManagementActor({ userId: USER, agentId: ACTOR, sessionId: 'owned_fixture', actorType: 'in-process', abortSignal: abort.signal }, 'native')
  const progress: AppActionsTargetOutcome[] = []
  const state = { failReadback: false }
  const deadlineAt = Date.now() + 30_000
  const ctx: AdapterCommitContext = { admission, signal: abort.signal, deadlineAt,
    async refreshAuthority() {
      if (state.failReadback && progress.some(outcome => outcome.saved === 'saved')) throw new Error('readback unavailable')
      await refreshSettingsOperationAuthority(admission)
    },
    assertCurrent() {
      if (abort.signal.aborted || Date.now() >= deadlineAt) throw new Error('operation ended')
      assertSettingsLifecycle(admission.fence.lifecycle!)
    },
    execution: { signal: abort.signal, actor: admission.actor, deadlineAt, targetStarted() {}, recordOutcome(outcome) { progress.push(structuredClone(outcome)) } }
  }
  const manifest = await createSettingsSubjectResolver({
    listIds: (userId, kind) => redis.sMembers(`user:${userId}:${kind === 'subagent' ? 'subagents' : 'agents'}`),
    read: (_userId, subject) => redis.json.get(`${subject.kind === 'subagent' ? 'subagent' : 'agent'}:${subject.id}`)
  })(selection, { userId: USER,
    canRead: subject => policyContainsSubject(admission.policy, subject, ACTOR), check: ctx.assertCurrent })
  return { ctx, abort, manifest, progress, state }
}

describe.runIf(REAL)('P4 actual Redis alias metadata and conditional access owner', () => {
  it('reads metadata with no skill files/seeding, grants exact typed subjects and checks saved values', async () => {
    const f = await fixture()
    await saveSlashCommandRecord(USER, { record: command('one', { enabled_agent_ids: ['kept'] }), mode: 'create' })
    const before = await readSlashCommandRevision(USER)
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    expect(report.rows.map(row => row.effective)).toEqual([false, false])
    expect(await readSlashCommandRevision(USER)).toBe(before)
    expect(await redis.exists(`skill:${USER}:notes`)).toBe(false)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: true }] })
    const result = await commitSkillAccessChange(f.ctx, prepared.plan)
    expect(result.map(outcome => [outcome.status, outcome.saved, outcome.readback])).toEqual([
      ['applied', 'saved', 'verified'], ['applied', 'saved', 'verified']
    ])
    expect((await redis.json.get(`slash_command:${USER}:one`) as SlashCommandRow).enabled_agent_ids).toEqual(['kept', A, B])
    expect(f.progress[0]).toMatchObject({ saved: 'saved', readback: 'not_requested' })
    expect(await commitSkillAccessChange(f.ctx, prepared.plan)).toEqual(result)
  })

  it('revokes every granting alias while preserving bystanders and unrelated metadata', async () => {
    const f = await fixture()
    for (const id of ['one', 'two']) await saveSlashCommandRecord(USER, { record: command(id, { enabled_agent_ids: [A, 'kept'], description: 'Keep metadata' }), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: false }] })
    const result = await commitSkillAccessChange(f.ctx, prepared.plan)
    expect(result.find(outcome => outcome.subject.id === A)).toMatchObject({ saved: 'saved', readback: 'verified' })
    expect(result.find(outcome => outcome.subject.id === B)).toMatchObject({ status: 'unchanged', saved: 'not_requested' })
    for (const id of ['one', 'two']) expect(await redis.json.get(`slash_command:${USER}:${id}`)).toMatchObject({ enabled_agent_ids: ['kept'], description: 'Keep metadata', skill_id: 'notes' })
  })

  it('refuses newly created aliases and identical alias replacement before issue', async () => {
    const f = await fixture()
    const initial = command('one', { enabled_agent_ids: [A] })
    await saveSlashCommandRecord(USER, { record: initial, mode: 'create' })
    const old = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    await saveSlashCommandRecord(USER, { record: command('new_alias', { enabled_agent_ids: [A] }), mode: 'create' })
    await expect(prepareSkillAccessChange(f.ctx, old.handle, { assignments: [{ skillId: 'notes', enabled: false }] })).rejects.toThrow('changed')
    const current = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, current.handle, { assignments: [{ skillId: 'notes', enabled: false }] })
    await deleteSlashCommandRecord(USER, 'one')
    await saveSlashCommandRecord(USER, { record: initial, mode: 'create' })
    expect((await commitSkillAccessChange(f.ctx, prepared.plan)).find(outcome => outcome.subject.id === A)).toMatchObject({ status: 'conflict', saved: 'not_requested' })
    expect((await redis.json.get(`slash_command:${USER}:one`) as SlashCommandRow).enabled_agent_ids).toEqual([A])
  })

  it('records known saves before failed readback and preserves that distinction', async () => {
    const f = await fixture()
    await saveSlashCommandRecord(USER, { record: command('one'), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: true }] })
    f.state.failReadback = true
    const result = await commitSkillAccessChange(f.ctx, prepared.plan)
    expect(result.every(outcome => outcome.saved === 'saved' && outcome.readback === 'unavailable')).toBe(true)
    expect(f.progress[0]).toMatchObject({ saved: 'saved', readback: 'not_requested' })
    expect((await redis.json.get(`slash_command:${USER}:one`) as SlashCommandRow).enabled_agent_ids).toEqual([A, B])
  })

  it('a stopped pre-issue operation changes neither access nor revision', async () => {
    const f = await fixture()
    await saveSlashCommandRecord(USER, { record: command('one'), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: true }] })
    const revision = await readSlashCommandRevision(USER)
    f.abort.abort()
    await expect(commitSkillAccessChange(f.ctx, prepared.plan)).rejects.toThrow('operation ended')
    expect(await readSlashCommandRevision(USER)).toBe(revision)
    expect((await redis.json.get(`slash_command:${USER}:one`) as SlashCommandRow).enabled_agent_ids).toEqual([])
  })

  it('keeps valid report rows and the unavailable manifest row when optional retention population is unsupported (BL1629)', async () => {
    const f = await fixture({ allAgents: true }, true)
    await saveSlashCommandRecord(USER, { record: command('one', { enabled_for_all_agents: true }), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    expect(report.rows.find(row => row.subject.id === A)).toMatchObject({ effective: true })
    expect(report.rows.find(row => row.subject.id === RETAINED)).toMatchObject({ effective: null, reason: 'unsupported_subject_type', aliases: [] })
    expect(report.rows).toHaveLength(f.manifest.entries.length)
    expect(skillAccessSnapshot(f.ctx, report.handle).population).toBeNull()
    await expect(prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: false }], universalConversion: 'preserve-current-population' })).rejects.toThrow('population is unavailable')
    expect(await redis.json.get(`slash_command:${USER}:one`)).toMatchObject({ enabled_for_all_agents: true })
  })

  it('converts universal access only with exact exclusions and preserves every current unselected subject', async () => {
    const f = await fixture({ allAgents: true, except: [{ kind: 'primary', id: ACTOR }, { kind: 'subagent', id: B }] })
    await saveSlashCommandRecord(USER, { record: command('one', { enabled_for_all_agents: true, enabled_agent_ids: [] }), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: false }], universalConversion: 'preserve-current-population' })
    expect(prepared.preview.targets.map(target => target.subject)).toEqual([{ kind: 'primary', id: A }])
    expect(prepared.closure.excluded).toEqual(f.manifest.excluded)
    expect(prepared.closure.retainedSubjects.map(subject => subject.id).sort()).toEqual([ACTOR, B].sort())
    expect(prepared.preview.effects.join(' ')).toContain('Future agents and built-in Workers')
    const outcome = await commitSkillAccessChange(f.ctx, prepared.plan)
    expect(outcome).toEqual([expect.objectContaining({ subject: { kind: 'primary', id: A }, saved: 'saved', readback: 'verified' })])
    expect(await redis.json.get(`slash_command:${USER}:one`)).toMatchObject({ enabled_for_all_agents: false, enabled_agent_ids: [B, ACTOR].sort() })
  })

  it('refuses a new actual atomically-created retained subject after universal preview', async () => {
    const f = await fixture()
    await saveSlashCommandRecord(USER, { record: command('one', { enabled_for_all_agents: true }), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: false }], universalConversion: 'preserve-current-population' })
    const retainedRecord = { id: RETAINED, user_id: USER, agentType: 'api', displayName: 'Retained', created_at: CREATED }
    await withSettingsRecordReplacement(`agent:${RETAINED}`, () => redis.execute(client => createSubjectPopulation(client, {
      userId: USER, subjectId: RETAINED, kind: 'primary', mode: 'create',
      record: retainedRecord
    })))
    expect((await commitSkillAccessChange(f.ctx, prepared.plan)).every(outcome => outcome.saved === 'not_requested')).toBe(true)
    expect(await redis.json.get(`slash_command:${USER}:one`)).toMatchObject({ enabled_for_all_agents: true })
  })

  it('checks the complete population indexes even when a historical fixture bypasses nonce advancement', async () => {
    const f = await fixture()
    await saveSlashCommandRecord(USER, { record: command('one', { enabled_for_all_agents: true }), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: false }], universalConversion: 'preserve-current-population' })
    await redis.json.set(`agent:${RETAINED}`, '$', { id: RETAINED, user_id: USER, agentType: 'api', created_at: CREATED } as never)
    await redis.sAdd(`user:${USER}:agents`, RETAINED)
    const result = await commitSkillAccessChange(f.ctx, prepared.plan)
    expect(result.every(outcome => outcome.saved === 'not_requested' && outcome.status === 'conflict')).toBe(true)
    expect(await redis.json.get(`slash_command:${USER}:one`)).toMatchObject({ enabled_for_all_agents: true })
  })

  it('holds an uncertain issue without replay and refuses its actual late EVAL after a new nonce', async () => {
    const f = await fixture()
    await saveSlashCommandRecord(USER, { record: command('one'), mode: 'create' })
    const report = await readSkillAccess(f.ctx, { skillIds: ['notes'] }, f.manifest)
    const prepared = await prepareSkillAccessChange(f.ctx, report.handle, { assignments: [{ skillId: 'notes', enabled: true }] })
    const realExecute = redis.execute.bind(redis)
    let captured: { keys: string[]; arguments: string[] } | undefined
    // Refresh authority uses execute too; arm the interceptor only at the physical command.
    const refresh = f.ctx.refreshAuthority
    const ctx: AdapterCommitContext = { ...f.ctx, async refreshAuthority() {
      await refresh()
      vi.spyOn(redis, 'execute').mockImplementationOnce(operation => realExecute(client => operation(new Proxy(client, {
        get(target, property) {
          if (property === 'withAbortSignal') return () => ({ eval: async (script: string, options: typeof captured) => {
            expect(script).toBe(CONDITIONAL_SKILL_ACCESS_SCRIPT); captured = options; throw new Error('transport uncertainty')
          } })
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }))))
    } }
    const unknown = await commitSkillAccessChange(ctx, prepared.plan)
    vi.restoreAllMocks()
    expect(unknown.every(outcome => outcome.saved === 'unknown')).toBe(true)
    expect(captured).toBeDefined()
    await deleteSlashCommandRecord(USER, 'one')
    await saveSlashCommandRecord(USER, { record: command('one', { enabled_agent_ids: ['new_owner_choice'] }), mode: 'create' })
    expect(await realExecute(client => client.eval(CONDITIONAL_SKILL_ACCESS_SCRIPT, captured!))).toBe('CONFLICT')
    expect((await redis.json.get(`slash_command:${USER}:one`) as SlashCommandRow).enabled_agent_ids).toEqual(['new_owner_choice'])
    expect(await commitSkillAccessChange(ctx, prepared.plan)).toEqual(unknown)
    expect(skillAccessSnapshot(ctx, report.handle).revision).not.toBe(await readSlashCommandRevision(USER))
  })
})
