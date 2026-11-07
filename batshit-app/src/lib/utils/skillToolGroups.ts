/** Display metadata only. A group never grants a tool or changes its scope. */
export function parseSkillToolGroups(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (typeof value !== 'string') throw new Error('Skill toolGroups must be a comma-separated string.')
  if (!value.trim()) return []
  const groups = [...new Set(value.split(',').map(group => group.trim()))]
  if (groups.some(group => !/^(?:sys\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*|artifact)\.\*$/.test(group))) {
    throw new Error('Skill toolGroups contains an invalid namespace pattern.')
  }
  return groups
}

export function matchesSkillToolGroup(controlId: string, groups: readonly string[]): boolean {
  return groups.some(group => controlId.startsWith(group.slice(0, -1)))
}

export interface AllowedSkillToolHint {
  ref: string
  controlId: string
  schemaHint: string | null
}

export interface OpenSkillToolGroups {
  skillId: string
  toolGroups: readonly string[]
}

/**
 * The caller supplies its actual allowed tools before presentation filtering. Preserve full
 * authored guidance; Admin/scalable budgets do not apply to deliberately opened skills.
 */
export function buildOpenSkillToolHints(
  skills: readonly OpenSkillToolGroups[],
  allowedTools: readonly AllowedSkillToolHint[],
  completeSetupRefs: ReadonlySet<string> = new Set()
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>()
  const used = new Set(completeSetupRefs)
  for (const skill of skills) {
    if (result.has(skill.skillId)) throw new Error('Open skill hints contain a duplicate skill.')
    const candidates = new Map<string, AllowedSkillToolHint>()
    for (const tool of allowedTools) {
      if (!matchesSkillToolGroup(tool.controlId, skill.toolGroups)) continue
      const prior = candidates.get(tool.ref)
      if (prior && (prior.controlId !== tool.controlId || prior.schemaHint !== tool.schemaHint)) {
        throw new Error(`Current tool guidance conflicts for ${tool.ref}. Nothing was sent.`)
      }
      candidates.set(tool.ref, tool)
    }
    const lines: string[] = []
    for (const tool of [...candidates.values()].sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)) {
      if (used.has(tool.ref)) continue
      if (!tool.schemaHint?.trim()) throw new Error(`Open skill ${skill.skillId} has no field guidance for ${tool.ref}. Nothing was sent.`)
      used.add(tool.ref)
      lines.push(`${tool.ref} — ${tool.schemaHint.trim()}`)
    }
    result.set(skill.skillId, lines)
  }
  return result
}
