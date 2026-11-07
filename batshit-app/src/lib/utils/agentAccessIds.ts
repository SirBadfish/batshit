/** Existing references are exact identities, including legitimate legacy punctuation.
 * Reading never trims/coerces an entry into a different subject. Creation has its own rule. */
export function isExactSavedAccessAgentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value.isWellFormed()
}

type ArtifactAccessInput = {
  agent_allowlist?: unknown
  agent_access_scope?: unknown
  agent_use_enabled?: unknown
  metadata?: unknown
}

/** Read stored permission intent without converting one reference into another identity.
 * Raw nonempty configuration remains restrictive even when every effective ref is invalid. */
export function readArtifactAgentAccess(artifact: ArtifactAccessInput): Readonly<{
  ids: readonly string[]; raw: readonly unknown[]; configuredNonempty: boolean; scope: 'all' | 'selected'
}> {
  const metadata = artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
    ? artifact.metadata as Record<string, unknown> : {}
  const fallback = metadata.agent_allowlist ?? metadata.agentAllowlist ?? metadata.assigned_agent_ids ?? metadata.assignedAgentIds
  const direct = artifact.agent_allowlist
  const source = Array.isArray(direct) ? direct : Array.isArray(fallback) ? fallback : []
  const raw = [...source]
  const ids = [...new Set(raw.filter(isExactSavedAccessAgentId))]
  const nonempty = (value: unknown) => value !== undefined && value !== null &&
    (Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.length > 0 : true)
  const configuredNonempty = Array.isArray(direct) ? direct.length > 0 : nonempty(direct) || nonempty(fallback)
  const namedScope = typeof artifact.agent_access_scope === 'string' ? artifact.agent_access_scope.trim().toLowerCase() : ''
  const scope = namedScope === 'all' || namedScope === 'selected' ? namedScope :
    configuredNonempty || artifact.agent_use_enabled === true ? 'selected' : 'all'
  return { ids, raw, configuredNonempty, scope }
}
