import { reportObject, SettingsReportRefusal } from './settings/reportContract'

export const SKILL_ACCESS_INPUT_LIMIT = 32
export type SkillAccessQuery = Readonly<{ skillIds?: readonly string[] }>
export type SkillAccessChange = Readonly<{
  assignments: readonly Readonly<{ skillId: string; enabled: boolean }>[]
  universalConversion?: 'preserve-current-population'
}>
function invalid(): never { throw new SettingsReportRefusal('invalid_skill_access_arguments') }
function skillId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,128}$/.test(value)) invalid()
  return value
}
function bounded(values: unknown): unknown[] {
  if (!Array.isArray(values) || !values.length || values.length > SKILL_ACCESS_INPUT_LIMIT) invalid()
  return values
}
export function parseSkillAccessQuery(input: unknown = {}): SkillAccessQuery {
  const value = reportObject(input, ['skillIds'])
  if (value.skillIds === undefined) return Object.freeze({})
  const ids = bounded(value.skillIds).map(skillId)
  if (new Set(ids).size !== ids.length) invalid()
  return Object.freeze({ skillIds: Object.freeze(ids) })
}
export function parseSkillAccessChange(input: unknown): SkillAccessChange {
  const value = reportObject(input, ['assignments', 'universalConversion'])
  const assignments = bounded(value.assignments).map(item => {
    const assignment = reportObject(item, ['skillId', 'enabled'])
    if (typeof assignment.enabled !== 'boolean') invalid()
    return Object.freeze({ skillId: skillId(assignment.skillId), enabled: assignment.enabled })
  })
  if (new Set(assignments.map(item => item.skillId)).size !== assignments.length ||
    value.universalConversion !== undefined && value.universalConversion !== 'preserve-current-population') invalid()
  return Object.freeze({ assignments: Object.freeze(assignments), ...(value.universalConversion !== undefined
    ? { universalConversion: 'preserve-current-population' as const } : {}) })
}
