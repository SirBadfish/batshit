import { describe, expect, it } from 'vitest'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import type { AdapterContext } from '../managementTypes'
import { captureSettingsLifecycle } from './lifecycle'
import { planSkillAccessChange } from './conditionalSkillAccess'
import type { SkillAccessSnapshot, SkillAlias } from './skillAccessReport'

const a = { kind: 'primary' as const, id: 'A-B' }
const b = { kind: 'subagent' as const, id: 'a_b' }
const c = { kind: 'primary' as const, id: 'kept' }
function alias(id: string, fields: Record<string, unknown> = {}): SkillAlias {
  return { key: `slash_command:owner:${id}`, raw: [], record: {
    id, user_id: 'owner', type: 'skill', name: 'Notes', skill_id: 'notes', enabled_agent_ids: ['A-B'], ...fields
  } }
}
function fixture(aliases = [alias('one')]) {
  const policy = defaultAppActionsPolicy(); policy.enabled = true; policy.scope.mode = 'all'
  const ctx: AdapterContext = { admission: { actor: { userId: 'owner', kind: 'native', id: 'actor', generation: 1, label: 'Actor' },
    policy, fence: { key: 'agent:actor', paths: [] } }, deadlineAt: Date.now() + 30_000,
    assertCurrent() {}, async refreshAuthority() {} }
  const subjects = [a, b, c].map(subject => ({ subject, key: `${subject.kind === 'subagent' ? 'subagent' : 'agent'}:${subject.id}`, raw: [] }))
  const snapshot: SkillAccessSnapshot = { owner: 'owner', actor: 'unused_pure_projection', revision: null, aliases,
    manifest: { ownerUserId: 'owner', digest: 'held', excluded: [c], entries: [
      { subject: a, status: 'available', type: 'api', label: 'A' }, { subject: b, status: 'available', type: 'cli', label: 'B' }
    ] }, subjects, namespace: [], collidingIds: [], lifecycle: captureSettingsLifecycle([]), population: { primary: ['A-B', 'kept'], subagent: ['a_b'], subjects } }
  return { ctx, snapshot }
}
const grant = { assignments: [{ skillId: 'notes', enabled: true }] }
const revoke = { assignments: [{ skillId: 'notes', enabled: false }] }

describe('access-only skill plan', () => {
  it('grants through one deterministic active alias, keeping exact bystander assignments', () => {
    const { ctx, snapshot } = fixture([alias('z', { enabled_agent_ids: [] }), alias('a', { enabled_agent_ids: ['kept'] })])
    const plan = planSkillAccessChange(ctx, snapshot, grant)
    expect(plan.writes).toEqual([{ key: 'slash_command:owner:a', commandId: 'a', skillId: 'notes', enabledAgentIds: ['kept', 'A-B', 'a_b'] }])
    expect(plan.preview.targets.map(target => target.subject)).toEqual([a, b])
    expect(plan.closure.excluded).toEqual([c])
    expect(snapshot.aliases[1].record.enabled_agent_ids).toEqual(['kept'])
  })

  it('effective revoke removes every granting alias and keeps unrelated/prompt access', () => {
    const { ctx, snapshot } = fixture([alias('one', { enabled_agent_ids: ['A-B', 'kept'] }),
      alias('two', { enabled_agent_ids: ['a_b', 'kept'] }), alias('prompt', { type: 'prompt', enabled_for_all_agents: true })])
    const plan = planSkillAccessChange(ctx, snapshot, revoke)
    expect(plan.writes.map(write => [write.commandId, write.enabledAgentIds])).toEqual([['one', ['kept']], ['two', ['kept']]])
    expect(plan.closure.aliasIds).not.toContain('prompt')
    expect(plan.preview.targets.every(target => target.changes[0].before === true && target.changes[0].after === false)).toBe(true)
  })

  it('keeps absent universal grants as a no-op and does not activate inactive aliases', () => {
    const legacy = alias('legacy'); Reflect.deleteProperty(legacy.record, 'enabled_agent_ids')
    const first = fixture([legacy])
    expect(planSkillAccessChange(first.ctx, first.snapshot, grant).writes).toEqual([])
    const inactive = fixture([alias('off', { is_active: false, enabled_agent_ids: [] })])
    expect(() => planSkillAccessChange(inactive.ctx, inactive.snapshot, grant)).toThrow('no active, invocable alias')
    expect(inactive.snapshot.aliases[0].record.is_active).toBe(false)
  })

  it('requires explicit conversion and whole-population authority, preserving current exclusions', () => {
    const { ctx, snapshot } = fixture([alias('global', { enabled_for_all_agents: true })])
    expect(() => planSkillAccessChange(ctx, snapshot, revoke)).toThrow('explicit conversion')
    const exact = { ...revoke, universalConversion: 'preserve-current-population' as const }
    const plan = planSkillAccessChange(ctx, snapshot, exact)
    expect(plan.writes[0]).toMatchObject({ enabledAgentIds: ['kept'], enabledForAll: false })
    expect(plan.closure.retainedSubjects).toEqual([c])
    expect(plan.closure.futureAgentAccessLost).toBe(true)
    expect(plan.closure.builtInWorkerAccessLost).toBe(true)
    ctx.admission.policy.scope.except = [c]
    expect(() => planSkillAccessChange(ctx, snapshot, exact)).toThrow('whole-population authority')
  })

  it('refuses saved malformed lists, missing full population and ambiguous namespaces without migration', () => {
    const invalid = fixture([alias('bad', { enabled_agent_ids: [' A-B ', 'A-B'] })])
    expect(() => planSkillAccessChange(invalid.ctx, invalid.snapshot, revoke)).toThrow('saved agent access')
    expect(invalid.snapshot.aliases[0].record.enabled_agent_ids).toEqual([' A-B ', 'A-B'])
    const global = fixture([alias('global', { enabled_for_all_agents: true })])
    expect(() => planSkillAccessChange(global.ctx, { ...global.snapshot, population: null }, { ...revoke, universalConversion: 'preserve-current-population' })).toThrow('population is unavailable')
    const collision = fixture()
    expect(() => planSkillAccessChange(collision.ctx, { ...collision.snapshot, collidingIds: ['A-B'] }, revoke)).toThrow('share an ID')
  })

  it('retains unavailable/no-op outcomes instead of manufacturing management targets', () => {
    const { ctx, snapshot } = fixture([alias('none', { enabled_agent_ids: [] })])
    const plan = planSkillAccessChange(ctx, { ...snapshot, manifest: { ...snapshot.manifest, entries: [...snapshot.manifest.entries,
      { subject: { kind: 'worker', id: 'worker_1' }, status: 'unavailable', reason: 'not_an_agent_subject' }] } }, revoke)
    expect(plan.targets).toEqual([])
    expect(plan.initialOutcomes.map(outcome => [outcome.subject.id, outcome.status])).toEqual([
      ['worker_1', 'unavailable'], ['A-B', 'unchanged'], ['a_b', 'unchanged']
    ])
    expect(() => planSkillAccessChange(ctx, snapshot, { assignments: [{ skillId: 'missing', enabled: true }] })).toThrow('held existing catalogue')
  })

  it('obeys current subject/category admission and refuses an oversized complete plan', () => {
    const blocked = fixture(); blocked.ctx.admission.policy.management.skillAccess = 'block'
    expect(() => planSkillAccessChange(blocked.ctx, blocked.snapshot, grant)).toThrow('blocked skill-access')
    const scope = fixture(); scope.ctx.admission.policy.scope.except = [a]
    expect(() => planSkillAccessChange(scope.ctx, scope.snapshot, grant)).toThrow('outside the current grant')
    const large = fixture([alias('large', { enabled_agent_ids: [] })])
    const snapshot = { ...large.snapshot, aliases: [{ ...large.snapshot.aliases[0], raw: ['x'.repeat(1024 * 1024)] }] }
    expect(() => planSkillAccessChange(large.ctx, snapshot, grant)).toThrow('operation budget')
  })

  it('keeps exact legacy bystander references while granting or revoking canonical managed subjects', () => {
    const f = fixture([alias('legacy_refs', { enabled_agent_ids: ['odd.id'] })])
    expect(planSkillAccessChange(f.ctx, f.snapshot, grant).writes[0].enabledAgentIds).toEqual(['odd.id', 'A-B', 'a_b'])
    const current = fixture([alias('legacy_refs', { enabled_agent_ids: ['odd.id', 'A-B'] })])
    expect(planSkillAccessChange(current.ctx, current.snapshot, revoke).writes[0].enabledAgentIds).toEqual(['odd.id'])
  })

})
