import type { AgentMemorySettingsDraft } from '$lib/utils/memoryControl'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'

/**
 * SA-122 A-1y (LS-067/LS-068, BL-1294): the fields of Agent Settings' basic form that a save made
 * elsewhere can change while the form holds an edit: the agent's own Settings save (App Actions)
 * changes the name and the memory settings, and the memory settings save as one group.
 */
export interface AgentWritableBasicFields {
  displayName: string
  memory_settings: AgentMemorySettingsDraft
}

export interface AgentWritableRebase<F extends AgentWritableBasicFields> {
  /** The live form, with each field the user did not edit taken from the record. */
  draft: F
  /** The baseline, with these fields taken from the record: the next save is diffed from it. */
  base: F
  /** Whether the record differs from the baseline it was compared with in any of these fields. */
  baseChanged: boolean
  /** Fields both the user and the record changed, each to its own value: the user's value is kept. */
  conflicts: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type Node = { draft: unknown; base: unknown; baseChanged: boolean; conflicts: string[] }

/**
 * Leaf by leaf (a nested object is walked; a list, a number or a text is one leaf): a leaf the user
 * did not edit (draft equals base) takes the record's value in the draft and the base; an edited
 * leaf keeps the user's value and its base takes the record's, so the next save still carries it.
 */
function rebaseNode(draft: unknown, base: unknown, server: unknown, path: string): Node {
  if (isPlainObject(draft) && isPlainObject(base) && isPlainObject(server)) {
    const result: Node = { draft: { ...draft }, base: { ...base }, baseChanged: false, conflicts: [] }
    for (const key of new Set([...Object.keys(draft), ...Object.keys(base), ...Object.keys(server)])) {
      const child = rebaseNode(draft[key], base[key], server[key], path ? `${path}.${key}` : key)
      ;(result.draft as Record<string, unknown>)[key] = child.draft
      ;(result.base as Record<string, unknown>)[key] = child.base
      result.baseChanged ||= child.baseChanged
      result.conflicts.push(...child.conflicts)
    }
    return result
  }
  const baseChanged = !sameJsonValue(server ?? null, base ?? null)
  if (sameJsonValue(draft ?? null, base ?? null)) return { draft: server, base: server, baseChanged, conflicts: [] }
  const conflict = baseChanged && !sameJsonValue(server ?? null, draft ?? null)
  return { draft, base: server, baseChanged, conflicts: conflict ? [path] : [] }
}

/**
 * Rebases the name and the memory settings of `draft` onto `server` (the record, read again), from
 * `base`: the baseline the conflicting save was worked out from (Ashe's refinement e), or the
 * form's baseline for a read. Every other field of both forms is returned as it was given.
 */
export function rebaseAgentWritableFields<F extends AgentWritableBasicFields>(
  draft: F,
  base: AgentWritableBasicFields,
  server: AgentWritableBasicFields,
  currentBase: F
): AgentWritableRebase<F> {
  const name = rebaseNode(draft.displayName, base.displayName, server.displayName, 'displayName')
  const memory = rebaseNode(draft.memory_settings, base.memory_settings, server.memory_settings, 'memory_settings')
  return {
    draft: { ...draft, displayName: name.draft as string, memory_settings: memory.draft as AgentMemorySettingsDraft },
    base: { ...currentBase, displayName: name.base as string, memory_settings: memory.base as AgentMemorySettingsDraft },
    baseChanged: name.baseChanged || memory.baseChanged,
    conflicts: [...name.conflicts, ...memory.conflicts]
  }
}

const CONFLICT_LABELS: Array<[RegExp, string]> = [
  [/^displayName$/, 'Display Name'],
  [/^memory_settings\.enabled$/, 'Agent Memory'],
  [/^memory_settings\.budgets\.onMyMind$/, 'Awareness'],
  [/^memory_settings\.budgets\.triggers$/, 'Triggers (STM)'],
  [/^memory_settings\.budgets\.recalled$/, 'Recalled (LTM)'],
  [/^memory_settings\.lingerTurns$/, 'STM Trigger Linger Default'],
  [/^memory_settings\.recallLingerTurns$/, 'Recall Linger'],
  [/^memory_settings\.window(\.|$)/, 'Infinite Session Window']
]

/** The Settings names of conflicting fields (`rebaseAgentWritableFields`), each once, in order. */
export function agentWritableConflictLabels(conflicts: readonly string[]): string[] {
  const labels: string[] = []
  for (const path of conflicts) {
    const label = CONFLICT_LABELS.find(([pattern]) => pattern.test(path))?.[1] ?? path
    if (!labels.includes(label)) labels.push(label)
  }
  return labels
}
