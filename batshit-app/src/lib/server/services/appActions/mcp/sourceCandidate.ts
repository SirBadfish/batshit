import { INFRA_API_KEY_SERVICES, normalizeApiKeyServiceName } from '$lib/services/apiKey.server'
import { getBlockedBatshitServerGatewayReason, isBlockedBatshitServerGatewayUrl } from '../../mcpGatewayPolicy'
import { validateStdioGatewayConfig, stdioCommandNeedsInstallation } from '../../mcpGatewayStdio'
import { parseMcpSourceCandidateData, type McpSourceCandidate } from '$lib/appActions/settings/mcpConfiguration'
import { invalidMcpInput } from './requestValidation'
export type { McpSourceCandidate, McpSourceEvidence } from '$lib/appActions/settings/mcpConfiguration'

function reference(value: string): string {
  const name = normalizeApiKeyServiceName(value)
  if (!name || INFRA_API_KEY_SERVICES.has(name)) invalidMcpInput('MCP_INFRASTRUCTURE_KEY_FORBIDDEN')
  return name
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
/** Shared finite wire validator plus the existing server-owned key/launch policies. No key/executable/cwd resolution. */
export function parseMcpSourceCandidate(value: unknown): McpSourceCandidate {
  let candidate: McpSourceCandidate
  try { candidate = parseMcpSourceCandidateData(value) } catch { return invalidMcpInput('INVALID_MCP_SOURCE_CANDIDATE') }
  if (candidate.kind === 'http') {
    if (isBlockedBatshitServerGatewayUrl(candidate.url)) invalidMcpInput(getBlockedBatshitServerGatewayReason())
    return freeze({ ...candidate, ...(candidate.savedKeyRef !== undefined ? { savedKeyRef: reference(candidate.savedKeyRef) } : {}) })
  }
  if (candidate.kind === 'stdio') {
    const normalized = { ...candidate, envRefs: candidate.envRefs.map(row => ({ envVar: row.envVar, savedKeyRef: reference(row.savedKeyRef) })) }
    const validation = validateStdioGatewayConfig({ ...normalized, args: [...normalized.args], envRefs: [...normalized.envRefs] })
    if (!validation.valid) invalidMcpInput('INVALID_MCP_STDIO_LAUNCH')
    return freeze(normalized)
  }
  return freeze(candidate)
}
/** Package launch is never reported as installed. No executable/cwd/key is resolved. */
export function describeCandidatePrerequisite(candidate: McpSourceCandidate): 'current-configuration-verification' | 'approved-install-or-host-prerequisite' {
  if (candidate.kind !== 'stdio') return 'current-configuration-verification'
  return stdioCommandNeedsInstallation(candidate.command)
    ? 'approved-install-or-host-prerequisite' : 'current-configuration-verification'
}
