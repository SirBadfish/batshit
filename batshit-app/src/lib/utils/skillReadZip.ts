import { parseCoolToolPayload } from './coolToolAiContent'
import { normalizeCompactTool, normalizeExplicitOperationKind } from './toolActivityContract'
import { resolveZipToolIdentity } from './zipActivation'
import { canonicalToolName } from './toolRenderMap'

type StoredZip = { type?: unknown; metadata?: Record<string, any>; content?: unknown; name?: string }

/** Same canonical stored identity as activation. Unknown grants no inferred write. */
export function classifyStoredSkillReadZip(value: unknown): 'skill' | 'non_skill' | 'unknown' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  const zip = value as StoredZip
  if (typeof zip.type !== 'string') return 'unknown'
  if (zip.type !== 'cool_tool') return ['error', 'image', 'tool_raw'].includes(zip.type) ? 'non_skill' : 'unknown'
  const toolName = zip.metadata?.toolName ?? zip.metadata?.tool_name ?? zip.name
  const identity = resolveZipToolIdentity(toolName, { ...zip, type: zip.type })
  const kind = normalizeExplicitOperationKind(identity.operationKind) ?? normalizeExplicitOperationKind(canonicalToolName(identity.toolName ?? ''))
  if (kind === 'skill_read') return 'skill'
  if (kind && kind !== 'unknown_tool') return 'non_skill'
  const payload = parseCoolToolPayload(zip.content)
  const normalized = normalizeCompactTool({
    toolName: identity.toolName ?? payload?.toolName ?? 'unknown_tool',
    originalToolName: payload?.originalToolName,
    toolArgs: payload?.toolArgs ?? {},
    toolResult: payload?.toolResult ?? payload?.result,
    metadata: payload?.metadata,
    toolProvider: payload?.toolProvider
  })
  return normalized.operationKind === 'skill_read' ? 'skill' :
    normalized.operationKind !== 'unknown_tool' ? 'non_skill' : 'unknown'
}

/** Classifies presentation only; actual-read lifecycle OPEN has its own producer/actor gate. */
export function isStoredSkillReadZip(zip: StoredZip | null | undefined): boolean {
  return classifyStoredSkillReadZip(zip) === 'skill'
}
