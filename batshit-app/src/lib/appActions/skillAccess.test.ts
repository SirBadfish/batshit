import { describe, expect, it } from 'vitest'
import { parseSkillAccessChange, parseSkillAccessQuery } from './skillAccess'

describe('finite skill-access inputs', () => {
  it('keeps canonical exact skill IDs and only the explicit conversion intent', () => {
    expect(parseSkillAccessQuery()).toEqual({})
    expect(parseSkillAccessQuery({ skillIds: ['notes', 'other_2'] })).toEqual({ skillIds: ['notes', 'other_2'] })
    const change = parseSkillAccessChange({ assignments: [{ skillId: 'notes', enabled: false }], universalConversion: 'preserve-current-population' })
    expect(change).toEqual({ assignments: [{ skillId: 'notes', enabled: false }], universalConversion: 'preserve-current-population' })
    expect(Object.isFrozen(change.assignments[0])).toBe(true)
  })
  it('refuses wildcards, alias/path injection, duplicate/nonfinite IDs and unknown authority fields', () => {
    for (const input of [{ skillIds: [] }, { skillIds: ['notes', 'notes'] }, { skillIds: ['Notes'] },
      { skillIds: ['notes/path'] }, { skillIds: ['*'] }, { skillIds: [12] },
      { skillIds: Array.from({ length: 33 }, (_, index) => `skill_${index}`) }, { all: true }, { skillIds: ['notes'], agentId: 'other' }]) {
      expect(() => parseSkillAccessQuery(input)).toThrow()
    }
  })
  it('refuses model-set grant/target/preimage fields, coercions and invented conversion modes', () => {
    for (const input of [{ assignments: [] }, { assignments: [{ skillId: 'notes', enabled: 'false' }] },
      { assignments: [{ skillId: 'notes', enabled: true, commandId: 'alias' }] },
      { assignments: [{ skillId: 'notes', enabled: true }], allowRisky: true },
      { assignments: [{ skillId: 'notes', enabled: true }], subjects: [{ kind: 'primary', id: 'other' }] },
      { assignments: [{ skillId: 'notes', enabled: true }], expectedRevision: 'forged' },
      { assignments: [{ skillId: 'notes', enabled: true }], universalConversion: true },
      { assignments: [{ skillId: 'notes', enabled: true }, { skillId: 'notes', enabled: false }] }]) {
      expect(() => parseSkillAccessChange(input)).toThrow()
    }
  })
})
