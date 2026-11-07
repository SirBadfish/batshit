/** Finite, browser-safe observations. These rows confer no runtime control. */
export const RUNTIME_INSPECTION_SOURCE_IDS = Object.freeze(['cloudflared', 'claude', 'runtime-addon-operator'] as const)
export type RuntimeInspectionSourceId = typeof RUNTIME_INSPECTION_SOURCE_IDS[number]
export const RUNTIME_INSPECTION_BUDGET_MS = 20_000
export const RUNTIME_INSPECTION_BYTE_LIMIT = 8_192
export const RUNTIME_INSPECTION_UNKNOWN_REASONS = Object.freeze([
  'source_pending', 'source_failed', 'source_deadline', 'configuration_changed', 'malformed_source', 'context_unavailable'
] as const)
export type RuntimeInspectionUnknownReason = typeof RUNTIME_INSPECTION_UNKNOWN_REASONS[number]
export type RuntimePinComparison = 'matches' | 'differs' | 'unknown'
export type RuntimeInspectionContext = {
  mode: 'mac-app' | 'docker' | 'native'
  distribution: 'mac-app' | 'docker' | 'pinokio' | 'pinokio-windows-wsl' | 'source-checkout'
  platform: 'darwin' | 'linux' | 'win32' | 'other'
  architecture: 'arm64' | 'x64' | 'other'
}
export const RUNTIME_INSPECTION_SIDECAR_STATES = ['starting', 'running', 'stopping', 'stopped', 'exited', 'error'] as const
export const RUNTIME_INSPECTION_CLI_PHASES = [
  'starting', 'metadata', 'downloading', 'verifying', 'extracting', 'validating', 'activating', 'cleaning-up'
] as const
export type CloudflaredInspection = {
  kind: 'cloudflared'
  owner: 'batshit-managed' | 'system' | 'docker-sidecar' | 'unverified'
  executableProbe: 'passed' | 'not_verified' | 'not_applicable'
  managedInstallReported: boolean
  version: string | null
  testedVersion: string | null
  pinComparison: RuntimePinComparison
  tunnel: {
    processReported: boolean | null
    urlReported: boolean
    issueReported: boolean
    sidecarState: typeof RUNTIME_INSPECTION_SIDECAR_STATES[number] | null
    stale: boolean | null
    readiness: 'not_verified'
  }
}
export type ManagedCliInspection = {
  kind: 'managed-cli'
  supported: boolean
  managedFiles: 'reported_present' | 'not_confirmed'
  version: string | null
  pinnedVersion: string | null
  pinComparison: RuntimePinComparison
  operation: {
    evidence: 'reported' | 'not_reported' | 'unverified'
    kind: 'install' | 'reinstall' | 'uninstall' | null
    phase: typeof RUNTIME_INSPECTION_CLI_PHASES[number] | null
  }
  proof: 'managed_files_only'
  readiness: 'not_checked'
}
export type RuntimeOperatorInspection = {
  kind: 'runtime-addon-operator'
  configured: boolean
  healthReported: boolean
  proof: 'health_response_only'
}
type InspectionData = {
  cloudflared: CloudflaredInspection
  claude: ManagedCliInspection
  'runtime-addon-operator': RuntimeOperatorInspection
}
export type RuntimeInspectionRow = { [Id in RuntimeInspectionSourceId]: {
  id: Id
} & ({
  status: 'observed'; reason: null; observedFrom: string; observedAt: string; data: InspectionData[Id]
} | {
  status: 'unknown'; reason: RuntimeInspectionUnknownReason; observedFrom: null; observedAt: null; data: null
} | {
  status: 'not_applicable'; reason: null; observedFrom: null; observedAt: null; data: null
}) }[RuntimeInspectionSourceId]
export type RuntimeInspectionReport = {
  version: 1
  domain: 'runtime-inspection'
  scope: 'this-instance'
  reportedAt: string
  runtime: RuntimeInspectionContext | null
  rows: RuntimeInspectionRow[]
}

/** Only a whole numeric release is displayable; never extract from stdout/errors. */
export function normalizeRuntimeInspectionVersion(value: unknown): string | null {
  return typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value) ? value : null
}
export function runtimePinComparison(version: string | null, pin: string | null): RuntimePinComparison {
  return version === null || pin === null ? 'unknown' : version === pin ? 'matches' : 'differs'
}

function exact(value: unknown, keys: string[]): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function member(value: unknown, values: readonly unknown[]): boolean { return values.includes(value) }
function iso(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function version(value: unknown): boolean { return value === null || normalizeRuntimeInspectionVersion(value) === value }
function validData(id: RuntimeInspectionSourceId, data: unknown): boolean {
  if (id === 'runtime-addon-operator') return exact(data, ['kind', 'configured', 'healthReported', 'proof']) &&
    data.kind === id && typeof data.configured === 'boolean' && typeof data.healthReported === 'boolean' && data.proof === 'health_response_only'
  if (id === 'cloudflared') {
    if (!exact(data, ['kind', 'owner', 'executableProbe', 'managedInstallReported', 'version', 'testedVersion', 'pinComparison', 'tunnel']) ||
      data.kind !== id || !member(data.owner, ['batshit-managed', 'system', 'docker-sidecar', 'unverified']) ||
      !member(data.executableProbe, ['passed', 'not_verified', 'not_applicable']) || typeof data.managedInstallReported !== 'boolean' ||
      !version(data.version) || !version(data.testedVersion) || data.pinComparison !== runtimePinComparison(data.version, data.testedVersion)) return false
    const tunnel = data.tunnel
    return exact(tunnel, ['processReported', 'urlReported', 'issueReported', 'sidecarState', 'stale', 'readiness']) &&
      (tunnel.processReported === null || typeof tunnel.processReported === 'boolean') && typeof tunnel.urlReported === 'boolean' &&
      typeof tunnel.issueReported === 'boolean' && member(tunnel.sidecarState, [null, ...RUNTIME_INSPECTION_SIDECAR_STATES]) &&
      (tunnel.stale === null || typeof tunnel.stale === 'boolean') && tunnel.readiness === 'not_verified'
  }
  if (!exact(data, ['kind', 'supported', 'managedFiles', 'version', 'pinnedVersion', 'pinComparison', 'operation', 'proof', 'readiness']) ||
    data.kind !== 'managed-cli' || typeof data.supported !== 'boolean' || !member(data.managedFiles, ['reported_present', 'not_confirmed']) ||
    !version(data.version) || !version(data.pinnedVersion) || data.pinComparison !== runtimePinComparison(data.version, data.pinnedVersion) ||
    data.proof !== 'managed_files_only' || data.readiness !== 'not_checked') return false
  const op = data.operation
  return exact(op, ['evidence', 'kind', 'phase']) &&
    (op.evidence === 'reported' ? member(op.kind, ['install', 'reinstall', 'uninstall']) && member(op.phase, RUNTIME_INSPECTION_CLI_PHASES) :
      member(op.evidence, ['not_reported', 'unverified']) && op.kind === null && op.phase === null)
}

/** Strict output boundary: raw fields cannot slip through a future source spread. */
export function isRuntimeInspectionReport(value: unknown): value is RuntimeInspectionReport {
  if (!exact(value, ['version', 'domain', 'scope', 'reportedAt', 'runtime', 'rows']) || value.version !== 1 ||
    value.domain !== 'runtime-inspection' || value.scope !== 'this-instance' || !iso(value.reportedAt)) return false
  if (value.runtime !== null && (!exact(value.runtime, ['mode', 'distribution', 'platform', 'architecture']) ||
    !member(value.runtime.mode, ['mac-app', 'docker', 'native']) ||
    !member(value.runtime.distribution, ['mac-app', 'docker', 'pinokio', 'pinokio-windows-wsl', 'source-checkout']) ||
    !member(value.runtime.platform, ['darwin', 'linux', 'win32', 'other']) || !member(value.runtime.architecture, ['arm64', 'x64', 'other']))) return false
  if (!Array.isArray(value.rows) || value.rows.length !== RUNTIME_INSPECTION_SOURCE_IDS.length) return false
  return value.rows.every((row: unknown, index: number) => {
    if (!exact(row, ['id', 'status', 'reason', 'observedFrom', 'observedAt', 'data']) || row.id !== RUNTIME_INSPECTION_SOURCE_IDS[index]) return false
    if (row.status === 'unknown') return member(row.reason, RUNTIME_INSPECTION_UNKNOWN_REASONS) && row.observedFrom === null && row.observedAt === null && row.data === null
    if (row.status === 'not_applicable') return row.id === 'runtime-addon-operator' && row.reason === null && row.observedFrom === null && row.observedAt === null && row.data === null
    return row.status === 'observed' && row.reason === null && iso(row.observedFrom) && iso(row.observedAt) &&
      row.observedFrom <= row.observedAt && row.observedAt <= value.reportedAt && validData(row.id, row.data)
  })
}
