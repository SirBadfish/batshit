import { describe, expect, it } from 'vitest'
import { projectSkillAccess, type SkillAlias } from './skillAccessReport'
import type { SettingsSubjectManifest } from './subjects'

function alias(id: string, fields: Record<string, unknown> = {}): SkillAlias {
  return { key: `slash_command:owner:${id}`, raw: [], record: {
    id, user_id: 'owner', type: 'skill', skill_id: 'notes', name: 'Notes', enabled_agent_ids: [], ...fields
  } }
}
function manifest(): SettingsSubjectManifest {
  return { ownerUserId: 'owner', digest: 'held', excluded: [{ kind: 'primary', id: 'excluded' }], entries: [
    { subject: { kind: 'primary', id: 'A-B' }, status: 'available', type: 'api' },
    { subject: { kind: 'subagent', id: 'a_b' }, status: 'available', type: 'cli' }
  ] }
}

describe('skill-access metadata projection', () => {
  it('reports effective OR across skill aliases and never counts a prompt as a granting alias', () => {
    const result = projectSkillAccess([
      alias('first', { enabled_agent_ids: ['A-B'] }), alias('second', { enabled_agent_ids: ['a_b'] }),
      alias('prompt', { type: 'prompt', enabled_for_all_agents: true })
    ], { skillIds: ['notes'] }, manifest())
    expect(result.rows.map(row => row.effective)).toEqual([true, true])
    expect(result.choices[0].aliases).toEqual(['first', 'second'])
    expect(result.rows[0].aliases.map(item => item.enabled)).toEqual([true, false])
    expect(result.rows[1].aliases.map(item => item.enabled)).toEqual([false, true])
  })

  it('distinguishes absence, empty, global and exact lists while honoring both runtime gates', () => {
    const absent = alias('legacy'); Reflect.deleteProperty(absent.record, 'enabled_agent_ids')
    const cases: Array<[SkillAlias, boolean, string]> = [
      [absent, true, 'absent-list'], [alias('empty'), false, 'none'],
      [alias('global', { enabled_for_all_agents: true }), true, 'global'],
      [alias('listed', { enabled_agent_ids: ['A-B'] }), true, 'list'],
      [alias('inactive', { enabled_for_all_agents: true, is_active: false }), false, 'global'],
      [alias('not_invocable', { enabled_for_all_agents: true, can_be_invoked_in_chat: false }), false, 'global']
    ]
    for (const [command, enabled, source] of cases) {
      const row = projectSkillAccess([command], { skillIds: ['notes'] }, manifest()).rows[0]
      expect(row.effective).toBe(enabled)
      expect(row.aliases[0].source).toBe(source)
    }
  })

  it('keeps exact IDs separate, records invalid legacy storage honestly and does not migrate it', () => {
    const command = alias('legacy', { enabled_agent_ids: [' A-B '] })
    const result = projectSkillAccess([command], { skillIds: ['notes'] }, manifest())
    // The actual load/DCM predicate ignores malformed entries without altering saved identities.
    expect(result.rows.map(row => row.effective)).toEqual([false, false])
    expect(result.rows[0].aliases[0].source).toBe('invalid')
    expect(command.record.enabled_agent_ids).toEqual([' A-B '])
  })

  it('withholds per-alias facts for denied/unavailable and Worker subjects', () => {
    const held = manifest()
    const denied: SettingsSubjectManifest = { ...held, entries: [
      { subject: { kind: 'primary', id: 'denied' }, status: 'unavailable', reason: 'read_not_allowed' },
      { subject: { kind: 'worker', id: 'worker_1' }, status: 'unavailable', reason: 'not_an_agent_subject' }
    ] }
    const result = projectSkillAccess([alias('global', { enabled_for_all_agents: true })], { skillIds: ['notes'] }, denied)
    expect(result.rows.map(row => [row.effective, row.reason, row.aliases])).toEqual([
      [null, 'read_not_allowed', []], [null, 'not_an_agent_subject', []]
    ])
    expect(held.excluded).toEqual([{ kind: 'primary', id: 'excluded' }])
  })

  it('lists compact metadata choices without an implicit full subject matrix or skill content', () => {
    const result = projectSkillAccess([alias('one', { prompt_template: 'PRIVATE', skill_source_ref: '/private/path' })], {}, manifest())
    expect(result.rows).toEqual([])
    expect(result.choices).toEqual([{ skillId: 'notes', label: 'Notes', aliases: ['one'], available: true }])
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(JSON.stringify(result)).not.toContain('/private/path')
    expect(Object.isFrozen(result.choices[0])).toBe(true)
  })

  it('refuses ambiguous/nonfinite selectors and names a missing skill without granting it', () => {
    for (const skillIds of [[], ['notes', 'notes'], ['Notes'], ['notes/path'], Array.from({ length: 33 }, (_, i) => `notes_${i}`)]) {
      expect(() => projectSkillAccess([alias('one')], { skillIds }, manifest())).toThrow('invalid_skill_access_arguments')
    }
    const result = projectSkillAccess([alias('one')], { skillIds: ['missing'] }, manifest())
    expect(result.rows.every(row => row.effective === null && row.reason === 'skill_not_listed')).toBe(true)
    expect(() => projectSkillAccess([alias('invalid', { skill_id: 'Notes/Path' })], {}, manifest())).toThrow('invalid binding')
  })

  it('labels exact legacy references as a stored list while retaining the actual predicate result', () => {
    const result = projectSkillAccess([alias('legacy_refs', { enabled_agent_ids: ['odd.id', 'A-B'] })], { skillIds: ['notes'] }, manifest())
    expect(result.rows.map(row => row.effective)).toEqual([true, false])
    expect(result.rows.every(row => row.aliases[0].source === 'list')).toBe(true)
  })

})
