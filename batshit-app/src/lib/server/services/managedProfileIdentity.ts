/** Pure managed-folder identity. No profile creation, credential or runtime imports. */
export function managedProfileId(runtimeAgentId: string): string {
  return `batshit_agent_${runtimeAgentId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`
}

/** The managed profile id (folder name) of an agent, CLI Subagent or Worker runtime id. */
export function buildAgentProfileId(agentId: string | null | undefined) {
  return managedProfileId(agentId ?? 'unknown')
}
