/** Exact API utility refs. CLI helper names and their scopes are unchanged. */
export const API_UTILITY_CONTROL_IDS = {
  webSearch: 'sys.web_search.search',
  workers: 'sys.workers.spawn',
  skill: 'sys.skill.use',
  subagent: 'sys.subagent.call'
} as const

export type ApiUtilityKind = keyof typeof API_UTILITY_CONTROL_IDS

export function isApiUtilityControlId(value: string): boolean {
  return (Object.values(API_UTILITY_CONTROL_IDS) as string[]).includes(value)
}

/** Current API read continuation from structured native facts, never rewritten skill text. */
export function formatApiSkillReadMore(result: Record<string, unknown>): string | null {
  if (result.action !== 'read' || result.success !== true || typeof result.skillId !== 'string' || !result.skillId ||
      typeof result.path !== 'string' || !result.path || typeof result.content !== 'string') return null
  const offset = result.offset ?? 0
  const returned = result.returnedChars
  const original = result.originalChars
  if (![offset, returned, original].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
      returned !== result.content.length) return null
  const end = (offset as number) + (returned as number)
  if (end > (original as number) || end === original && offset === 0) return null
  const count = (value: number) => value.toLocaleString('en-US')
  const shown = `Showing characters ${count((offset as number) + 1)} to ${count(end)} of ${count(original as number)}`
  if (end === original) return `${shown}: the end of ${result.path}.`
  if (result.nextOffset !== end) return null
  return `${shown}. To read on, call native_batshit_tool_use with ref "batshit:${API_UTILITY_CONTROL_IDS.skill}" and input ${JSON.stringify({
    skillId: result.skillId, action: 'read', path: result.path, offset: end
  })}.`
}
