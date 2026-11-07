/** Facts supplied by the owning detail route, never write authority or stored fields. */
export const INSTRUCTIONS_REVISION_HEADER = 'X-Batshit-Instructions-Revision'
export type InstructionsRevisions = Readonly<{ customPrompt: string; includeGlobalPrompt: string }>
export type InstructionsBaseline = Readonly<{
  kind: 'agent' | 'subagent'
  id: string
  type: 'api'
  tokens: InstructionsRevisions
  group: Readonly<Record<string, unknown>>
}>
const FIELDS = { system_prompt: 'customPrompt', include_global_prompt: 'includeGlobalPrompt' } as const

export function isInstructionsRevision(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function freezeDetached<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDetached(child)
    Object.freeze(value)
  }
  return value
}

export function captureInstructionsBaseline(kind: InstructionsBaseline['kind'], row: Record<string, unknown>, header: unknown): InstructionsBaseline | null {
  const type = row[kind === 'agent' ? 'agentType' : 'subagentType']
  // SA-139 R4/R5: only the live API type has instructions to edit; a retired `cli` record has none.
  if (typeof header !== 'string' || typeof row.id !== 'string' || !row.id || type !== 'api') return null
  try {
    const tokens: unknown = JSON.parse(header)
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) ||
      Object.keys(tokens).length !== 2 || !Object.hasOwn(tokens, 'customPrompt') || !Object.hasOwn(tokens, 'includeGlobalPrompt') ||
      !isInstructionsRevision((tokens as InstructionsRevisions).customPrompt) || !isInstructionsRevision((tokens as InstructionsRevisions).includeGlobalPrompt)) return null
    const group = structuredClone(Object.fromEntries(Object.keys(FIELDS).filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])))
    return freezeDetached({ kind, id: row.id, type, tokens: { ...(tokens as InstructionsRevisions) }, group })
  } catch { return null }
}

/** Only fixed physical leaves count; semantic aliases and inherited properties never do. */
export function namesInstructions(body: Record<string, unknown>): boolean {
  return Object.keys(FIELDS).some(field => Object.hasOwn(body, field))
}

export function instructionsExpectedForWrites(baseline: InstructionsBaseline | null | undefined, body: Record<string, unknown>): Partial<InstructionsRevisions> | null {
  if (!baseline || !namesInstructions(body)) return null
  return Object.fromEntries(Object.entries(FIELDS).filter(([field]) => Object.hasOwn(body, field)).map(([, token]) => [token, baseline.tokens[token]]))
}
