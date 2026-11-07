import { describe, expect, it } from 'vitest'
import { buildOpenSkillToolHints, matchesSkillToolGroup, parseSkillToolGroups } from './skillToolGroups'

describe('opened skill tool metadata and complete guidance', () => {
  it('validates namespace-only metadata without arbitrary wildcard or scope expansion', () => {
    const groups = parseSkillToolGroups('sys.artifact.*, artifact.*,sys.artifact.*')
    expect(groups).toEqual(['sys.artifact.*', 'artifact.*'])
    expect(matchesSkillToolGroup('artifact.saved-id.settings.read', groups)).toBe(true)
    expect(matchesSkillToolGroup('sys.artifact_other.create', groups)).toBe(false)
    for (const invalid of [null, [], {}, 'sys.*', '*', 'sys.artifact.*.delete', 'sys.ui.*,']) {
      expect(() => parseSkillToolGroups(invalid)).toThrow()
    }
  })

  it('keeps full long hints and only tools supplied by current allowance', () => {
    const hint = 'required: `artifactId` · optional: ' + 'complete-field-guidance '.repeat(500)
    const lines = buildOpenSkillToolHints([{ skillId: 'artifact_creator', toolGroups: ['sys.artifact.*'] }],
      [{ ref: 'fabric:sys.artifact.get', controlId: 'sys.artifact.get', schemaHint: hint }])
    expect(lines.get('artifact_creator')).toEqual([`fabric:sys.artifact.get — ${hint.trim()}`])
    expect(lines.get('artifact_creator')?.[0]).not.toContain('sys.artifact.create')
  })

  it('deduplicates complete Setup and shared groups, restoring shared hints when their first skill closes', () => {
    const skills = [{ skillId: 'first', toolGroups: ['sys.skill.*'] }, { skillId: 'second', toolGroups: ['sys.skill.*'] }]
    const tools = ['save', 'read'].map(action => ({ ref: `fabric:sys.skill.${action}`, controlId: `sys.skill.${action}`, schemaHint: 'required: `skillId`' }))
    const fixed = new Set(['fabric:sys.skill.save'])
    expect([...buildOpenSkillToolHints(skills, tools, fixed).values()]).toEqual([['fabric:sys.skill.read — required: `skillId`'], []])
    expect(buildOpenSkillToolHints(skills.slice(1), tools, fixed).get('second')).toEqual(['fabric:sys.skill.read — required: `skillId`'])
  })

  it('refuses missing or conflicting matching guidance instead of silently omitting it', () => {
    const skills = [{ skillId: 'creator', toolGroups: ['sys.skill.*'] }]
    const tool = { ref: 'fabric:sys.skill.save', controlId: 'sys.skill.save', schemaHint: null }
    expect(() => buildOpenSkillToolHints(skills, [tool])).toThrow('no field guidance')
    expect(() => buildOpenSkillToolHints(skills, [{ ...tool, schemaHint: 'one' }, { ...tool, schemaHint: 'two' }])).toThrow('conflicts')
  })
})
