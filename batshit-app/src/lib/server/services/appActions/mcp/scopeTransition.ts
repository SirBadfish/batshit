import { isProfileText, ProfilePublicationRefusal } from './profilePrimitives'

export type ApprovedMcpScopeDelta = Readonly<{ add: readonly string[]; remove: readonly string[] }>
export type McpScopeProvenance = 'human-selection' | 'saved-defaults' | 'inherited-run' | 'management-continuation'
export type ActualMcpScopeSnapshot = Readonly<{ gatewayIds: readonly string[]; provenance: McpScopeProvenance; snapshotId: string }>
function ids(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 256 || value.some(id => !isProfileText(id, 128)) || new Set(value).size !== value.length) {
    throw new ProfilePublicationRefusal('MCP_SCOPE_INVALID', 'An exact bounded MCP gateway scope is required.')
  }
  return [...value].sort()
}
/** Capture actual server resolution, including an explicit empty human selection. */
export function snapshotActualMcpScope(value: ActualMcpScopeSnapshot): ActualMcpScopeSnapshot {
  if (!['human-selection', 'saved-defaults', 'inherited-run', 'management-continuation'].includes(value.provenance) ||
    !isProfileText(value.snapshotId, 256)) {
    throw new ProfilePublicationRefusal('MCP_SCOPE_INVALID', 'The original actual run scope provenance is unavailable.')
  }
  return Object.freeze({ ...value, gatewayIds: Object.freeze(ids(value.gatewayIds)) })
}
/**
 * Defaults are deliberately not an input. Current configuration/authority may only
 * SUBTRACT here; additions come from this operation's exact verified approved delta.
 * Removal-only proof does not require contacting the removed source.
 */
export function planFreshMcpScope(previous: ActualMcpScopeSnapshot, delta: ApprovedMcpScopeDelta,
  current: { verifiedAdditions: readonly string[]; permittedGatewayIds: readonly string[]; nextSnapshotId: string }): ActualMcpScopeSnapshot {
  const baseline = snapshotActualMcpScope(previous), additions = ids(delta.add), removals = ids(delta.remove)
  const verified = new Set(ids(current.verifiedAdditions)), permitted = new Set(ids(current.permittedGatewayIds))
  if (additions.some(id => removals.includes(id))) throw new ProfilePublicationRefusal('MCP_SCOPE_DELTA_CONFLICT', 'One operation cannot both add and remove the same source.')
  if (additions.some(id => !verified.has(id)) || [...verified].some(id => !additions.includes(id))) {
    throw new ProfilePublicationRefusal('MCP_POSITIVE_VERIFICATION_REQUIRED', 'Only this operation’s exact approved additions may enter the fresh run scope.')
  }
  const next = new Set(baseline.gatewayIds.filter(id => !removals.includes(id)))
  for (const id of additions) next.add(id)
  return snapshotActualMcpScope({ gatewayIds: [...next].filter(id => permitted.has(id)), provenance: 'management-continuation', snapshotId: current.nextSnapshotId })
}
