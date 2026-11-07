import { isCanonicalAgentId } from '$lib/utils/agentId'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
/** Browser-safe disclosure only. Opaque plans, raw source cuts and approval authority never cross this boundary. */
export const MCP_CONFIGURATION_ID = 'mcp.workflow.configure' as const
export const MCP_CONFIGURATION_DOMAIN = 'mcp-configuration' as const
export const MCP_REPORT_BUDGET_MS = 120_000
export const MCP_CONFIGURATION_BUDGET_MS = 180_000
export const MCP_CONFIGURATION_LIMITS = Object.freeze({ sources: 256, rows: 64, candidateBytes: 16_384, previewBytes: 65_536 })
export const MCP_CONFIGURATION_EFFECTS = Object.freeze([
  'Saves only the exact reviewed MCP gateway configuration using existing saved-key references.',
  'A saved gateway is separate from installation, connection, verification, agent discoverability, original-task use and Zip settings. Those stages remain not started.'
])
export const MCP_CONFIGURATION_STAGES = ['installation', 'registry', 'keyReference', 'dockerFile', 'verification', 'discoverability', 'originalTaskUse', 'zip'] as const
export type McpConfigurationStage = typeof MCP_CONFIGURATION_STAGES[number]
/**
 * SA-139 R4: the stage list before the Claude Code CLI Primary's profile sync went. A review or
 * outcome saved in a chat before R4 carries it, and it still reads; its `claudeProfile` stage was
 * only ever `not_started` or `not_requested`. Nothing new is built with it.
 */
const PRE_R4_MCP_CONFIGURATION_STAGES = ['installation', 'registry', 'keyReference', 'dockerFile', 'claudeProfile', 'verification', 'discoverability', 'originalTaskUse', 'zip'] as const
function isKnownStageList(stages: unknown): boolean {
  const listed = JSON.stringify(stages)
  return listed === JSON.stringify(MCP_CONFIGURATION_STAGES) || listed === JSON.stringify(PRE_R4_MCP_CONFIGURATION_STAGES)
}
/** The stage keys a saved outcome must hold: the pre-R4 list when it names `claudeProfile`. */
function outcomeStageKeys(stages: unknown): readonly string[] {
  return stages && typeof stages === 'object' && Object.hasOwn(stages, 'claudeProfile') ? PRE_R4_MCP_CONFIGURATION_STAGES : MCP_CONFIGURATION_STAGES
}
function legacyStageReadable(stages: Record<string, unknown>): boolean {
  return !Object.hasOwn(stages, 'claudeProfile') || ['not_started', 'not_requested'].includes(String(stages.claudeProfile))
}
export type McpStageFact = 'not_started' | 'not_requested' | 'issued' | 'saved' | 'verified' | 'blocked' | 'unknown' | 'unconfirmed'
export type McpConfigurationJournal = Record<McpConfigurationStage, McpStageFact>
export type McpConfigurationResource = Readonly<{ kind: 'mcp-gateway'; gatewayId: string }>
export type McpSourceEvidence = Readonly<{ kind: 'supplied' | 'researched'; uri: string; version?: string }>
export type McpSourceCandidate = Readonly<
  { kind: 'existing'; gatewayId: string; expectedRevision: string } |
  { kind: 'http'; name: string; url: string; savedKeyRef?: string; evidence: McpSourceEvidence } |
  { kind: 'stdio'; name: string; command: string; args: readonly string[]; allowedLocations: readonly string[];
    cwdPolicy: 'none' | 'project' | 'fixed'; cwdValue?: string; envRefs: readonly Readonly<{ envVar: string; savedKeyRef: string }>[];
    startupTimeoutMs: number; toolCallTimeoutMs: number; evidence: McpSourceEvidence & { version: string } } |
  { kind: 'docker'; gatewayId: string; expectedRevision: string; profile?: string }
>
export type McpGatewayDisclosure = Readonly<{
  id: string; slug: string; name: string; type: 'custom' | 'stdio' | 'docker-catalog' | 'n8n-mcp-trigger' | 'n8n-instance-mcp'; enabled: boolean
  url?: string; savedKeyRef?: string; dockerProfile?: string
  stdio?: Readonly<{ command: string; args: readonly string[]; allowedLocations: readonly string[]; cwdPolicy: 'none' | 'project' | 'fixed'; cwdValue?: string
    envRefs: readonly Readonly<{ envVar: string; savedKeyRef: string }>[]; startupTimeoutMs: number; toolCallTimeoutMs: number }>
  evidence?: McpSourceEvidence
}>
export type McpGatewaySaveReview = Readonly<{
  variant?: never
  kind: 'mcp-configuration'; planId: string; candidateId: string; mode: 'create' | 'update'; resource: McpConfigurationResource
  before: McpGatewayDisclosure | null; after: McpGatewayDisclosure
  stages: readonly McpConfigurationStage[]
}>
export type McpPrimarySubject = Readonly<{ kind: 'primary'; id: string }>
export type McpToolZipIntent = Readonly<{
  toolName: string
  mode?: 'normal' | 'auto' | 'off' | 'inherit'
  bufferSize?: number | null; zipThreshold?: number | null
  autoZip?: boolean | null; zipDisabled?: boolean | null
}>
export type McpPrerequisiteTarget = Readonly<{
  subject: McpPrimarySubject; gatewayId: string; membership: 'enable' | 'disable'; zip?: McpToolZipIntent
}>
export type McpTargetReview = Readonly<{
  subject: McpPrimarySubject; label: string
  changes: readonly Readonly<{ field: string; label: string; before: string | number | boolean | null; after: string | number | boolean | null }>[]
  settingsIdentity?: string
  effectiveZip?: Readonly<{ before: Readonly<Record<'buffer_size' | 'zip_threshold', number | 'unlimited'> & Record<'auto_zip' | 'zip_disabled', boolean>>;
    after: Readonly<Record<'buffer_size' | 'zip_threshold', number | 'unlimited'> & Record<'auto_zip' | 'zip_disabled', boolean>> }>
}>
export type McpPrerequisiteReview = Readonly<{
  kind: 'mcp-configuration'; variant: 'prerequisite'; planId: string; candidateId: string
  mode: 'configure' | 'remove'; resource: McpConfigurationResource
  sourceAction: 'save' | 'unchanged' | 'absent'
  before: McpGatewayDisclosure | null; after: McpGatewayDisclosure | null
  intent: McpPrerequisiteTarget; target: McpTargetReview
  stages: readonly McpConfigurationStage[]
}>
export type McpConfigurationReview = McpGatewaySaveReview | McpPrerequisiteReview
export const MCP_PREREQUISITE_EFFECTS = Object.freeze([
  'Uses only this exact reviewed custom HTTP source, with fresh connection and tool-list verification and known client close.',
  'Changes only the named owned Primary source membership and explicitly requested tool Zip fields; all sibling settings remain.',
  'Setup consent grants no tool effect. Only verified actor-target configuration and its canonical saved reply may supply one fresh original-task scope.'
])
export const MCP_REMOVAL_EFFECTS = Object.freeze([
  'Removes only the named Primary source selection and explicitly requested existing tool Zip overrides, without contacting or configuring the source.',
  'Preserves every other source, tool row and setting. A fresh original-task scope can only remove this source; removal grants no tool effect.'
])
export function mcpConfigurationEffects(review: McpConfigurationReview): readonly string[] {
  if (review.variant === 'prerequisite' && review.mode === 'configure' && review.after?.type === 'stdio') return [
    review.sourceAction === 'save' ? 'Enables only this saved STDIO source; its command, arguments, cwd and saved env-reference mappings remain unchanged.' : 'Keeps this already-enabled saved STDIO launch unchanged; no source write is requested.',
    'Starts only that installed executable/local entry, verifies its actual tool list and observes its direct SDK child close. No package/server installation or all-descendant cleanup is implied.',
    ...MCP_PREREQUISITE_EFFECTS.slice(1)
  ]
  return review.variant === 'prerequisite' ? review.mode === 'remove' ? MCP_REMOVAL_EFFECTS : MCP_PREREQUISITE_EFFECTS : MCP_CONFIGURATION_EFFECTS
}
export function mcpConfigurationTargetsMatch(review: McpConfigurationReview, targets: unknown): boolean {
  return Array.isArray(targets) && (review.variant === 'prerequisite'
    ? targets.length === 1 && sameJsonValue(targets[0], review.target)
    : targets.length === 0)
}
export type McpResourceOutcome = Readonly<{
  resource: McpConfigurationResource; status: 'applied' | 'unchanged' | 'blocked' | 'conflict' | 'unavailable' | 'unknown'
  saved: 'saved' | 'not_requested' | 'unknown'; stages: McpConfigurationJournal; reason?: string; variant?: 'prerequisite'
}>
export type McpConfigurationChanges = Readonly<{ source: Readonly<{ candidateId: string }>; target?: never }> |
  Readonly<{ source?: Readonly<{ candidateId: string }>; target: McpPrerequisiteTarget }>
const encoder = new TextEncoder()
/** Existing conservative argument rule; neither this nor a saved reference classifies arbitrary positional text. */
export function hasMcpSecretArgument(value: unknown): boolean {
  return typeof value === 'string' && /(?:^|[-_])(?:api[-_]?key|token|secret|password|authorization|cookie)(?:=|\s|$)/i.test(value)
}
const text = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.isWellFormed() && encoder.encode(value).length <= max
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function exact(value: unknown, allowed: readonly string[], required: readonly string[] = []): value is Record<string, unknown> {
  return object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
}
export function isMcpReportId(value: unknown): value is string { return typeof value === 'string' && /^asr_[a-f0-9]{24}_mcp_[a-f0-9]{32}$/.test(value) }
export function isMcpOperationId(value: unknown): value is string { return typeof value === 'string' && /^aso_[a-f0-9]{24}_mcp_config_[a-f0-9]{32}$/.test(value) }
export function isMcpConfigurationResource(value: unknown): value is McpConfigurationResource {
  return exact(value, ['kind', 'gatewayId'], ['kind', 'gatewayId']) && value.kind === 'mcp-gateway' && text(value.gatewayId)
}
function endpoint(value: unknown): value is string {
  if (!text(value, 2048)) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }
  catch { return false }
}
function evidence(value: unknown): value is McpSourceEvidence {
  return exact(value, ['kind', 'uri', 'version'], ['kind', 'uri']) && ['supplied', 'researched'].includes(String(value.kind)) && endpoint(value.uri) &&
    (value.version === undefined || text(value.version))
}
/** Shared finite data validation; the server retains infrastructure-key and owning launch-policy checks. */
export function parseMcpSourceCandidateData(value: unknown): McpSourceCandidate {
  const fail = (): never => { throw new Error('Invalid finite nonsecret MCP source candidate.') }
  const sourceText = (input: unknown, max = 128): input is string => text(input, max) && !/[\x00-\x1f\x7f]/.test(input)
  const pinned = (input: unknown): input is string => sourceText(input) && /^(?:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?|[a-f0-9]{40,64}|sha256:[a-f0-9]{64})$/.test(input)
  const location = (input: unknown): input is string => sourceText(input, 2048) && (/^\//.test(input) || /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\'))
  function sourceEvidence(input: unknown, version: true): input is McpSourceEvidence & { version: string }
  function sourceEvidence(input: unknown, version: false): input is McpSourceEvidence
  function sourceEvidence(input: unknown, version: boolean): input is McpSourceEvidence {
    return evidence(input) && (!version && input.version === undefined || pinned(input.version))
  }
  const cwdPolicy = (input: unknown): input is 'none' | 'project' | 'fixed' => ['none', 'project', 'fixed'].includes(String(input))
  const timeout = (input: unknown, max: number): input is number => Number.isSafeInteger(input) && Number(input) >= 1000 && Number(input) <= max
  if (!object(value) || !sourceText(value.kind) || encoder.encode(JSON.stringify(value)).length > MCP_CONFIGURATION_LIMITS.candidateBytes) return fail()
  if (value.kind === 'existing' || value.kind === 'docker') {
    if (!exact(value, value.kind === 'existing' ? ['kind', 'gatewayId', 'expectedRevision'] : ['kind', 'gatewayId', 'expectedRevision', 'profile'], ['kind', 'gatewayId', 'expectedRevision']) ||
      !sourceText(value.gatewayId) || typeof value.expectedRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.expectedRevision) ||
      value.profile !== undefined && (!sourceText(value.profile) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.profile))) return fail()
    return structuredClone(value) as McpSourceCandidate
  }
  if (value.kind === 'http') {
    if (!exact(value, ['kind', 'name', 'url', 'savedKeyRef', 'evidence'], ['kind', 'name', 'url', 'evidence']) || !sourceText(value.name, 200) ||
      !endpoint(value.url) || value.savedKeyRef !== undefined && !sourceText(value.savedKeyRef) || !sourceEvidence(value.evidence, false)) return fail()
    return { ...structuredClone(value), url: new URL(value.url).href } as McpSourceCandidate
  }
  if (value.kind !== 'stdio' || !exact(value, ['kind', 'name', 'command', 'args', 'allowedLocations', 'cwdPolicy', 'cwdValue', 'envRefs', 'startupTimeoutMs', 'toolCallTimeoutMs', 'evidence'],
    ['kind', 'name', 'command', 'args', 'allowedLocations', 'cwdPolicy', 'startupTimeoutMs', 'toolCallTimeoutMs', 'evidence']) ||
    !sourceText(value.name, 200) || !sourceText(value.command, 2048) || !sourceEvidence(value.evidence, true) ||
    !cwdPolicy(value.cwdPolicy) || (value.cwdPolicy === 'fixed') !== Object.hasOwn(value, 'cwdValue') ||
    value.cwdValue !== undefined && !location(value.cwdValue) || !Array.isArray(value.args) || value.args.length > 64 || value.args.some(arg => !sourceText(arg, 2048) || hasMcpSecretArgument(arg)) ||
    !Array.isArray(value.allowedLocations) || !value.allowedLocations.length || value.allowedLocations.length > 64 || value.allowedLocations.some(row => !location(row)) ||
    new Set(value.allowedLocations).size !== value.allowedLocations.length || !timeout(value.startupTimeoutMs, 120_000) || !timeout(value.toolCallTimeoutMs, 300_000)) return fail()
  const refs = value.envRefs ?? []
  if (!Array.isArray(refs) || refs.length > 64 || refs.some(row => !exact(row, ['envVar', 'savedKeyRef'], ['envVar', 'savedKeyRef']) ||
    !sourceText(row.envVar) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.envVar) || !sourceText(row.savedKeyRef)) || new Set(refs.map(row => row.envVar)).size !== refs.length) return fail()
  return { ...structuredClone(value), kind: 'stdio', name: value.name, command: value.command,
    args: structuredClone(value.args), allowedLocations: structuredClone(value.allowedLocations), cwdPolicy: value.cwdPolicy,
    envRefs: structuredClone(refs), startupTimeoutMs: value.startupTimeoutMs, toolCallTimeoutMs: value.toolCallTimeoutMs, evidence: structuredClone(value.evidence) }
}
export function isMcpGatewayDisclosure(value: unknown): value is McpGatewayDisclosure {
  if (!exact(value, ['id', 'slug', 'name', 'type', 'enabled', 'url', 'savedKeyRef', 'dockerProfile', 'stdio', 'evidence'], ['id', 'slug', 'name', 'type', 'enabled']) ||
    !text(value.id) || !text(value.slug) || !text(value.name, 200) || typeof value.enabled !== 'boolean' ||
    !['custom', 'stdio', 'docker-catalog', 'n8n-mcp-trigger', 'n8n-instance-mcp'].includes(String(value.type)) ||
    value.url !== undefined && !endpoint(value.url) || value.savedKeyRef !== undefined && !text(value.savedKeyRef) ||
    value.dockerProfile !== undefined && !text(value.dockerProfile) || value.evidence !== undefined && !evidence(value.evidence)) return false
  if (value.type !== 'stdio') return value.stdio === undefined && typeof value.url === 'string'
  const launch = value.stdio
  if (value.url !== undefined || value.savedKeyRef !== undefined || !exact(launch,
    ['command', 'args', 'allowedLocations', 'cwdPolicy', 'cwdValue', 'envRefs', 'startupTimeoutMs', 'toolCallTimeoutMs'],
    ['command', 'args', 'allowedLocations', 'cwdPolicy', 'envRefs', 'startupTimeoutMs', 'toolCallTimeoutMs']) || !text(launch.command, 2048) ||
    !['none', 'project', 'fixed'].includes(String(launch.cwdPolicy)) || (launch.cwdPolicy === 'fixed') !== (launch.cwdValue !== undefined) ||
    launch.cwdValue !== undefined && !text(launch.cwdValue, 2048)) return false
  if (![launch.args, launch.allowedLocations].every(rows => Array.isArray(rows) && rows.length <= 64 && rows.every(row => text(row, 2048))) || !Array.isArray(launch.args) || launch.args.some(hasMcpSecretArgument) ||
    !Array.isArray(launch.envRefs) || launch.envRefs.length > 64 || launch.envRefs.some(row => !exact(row, ['envVar', 'savedKeyRef'], ['envVar', 'savedKeyRef']) ||
      !text(row.envVar) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.envVar) || !text(row.savedKeyRef)) ||
    new Set(launch.envRefs.map(row => row.envVar)).size !== launch.envRefs.length) return false
  return Number.isSafeInteger(launch.startupTimeoutMs) && Number(launch.startupTimeoutMs) >= 1000 && Number(launch.startupTimeoutMs) <= 120_000 &&
    Number.isSafeInteger(launch.toolCallTimeoutMs) && Number(launch.toolCallTimeoutMs) >= 1000 && Number(launch.toolCallTimeoutMs) <= 300_000
}
export function isMcpConfigurationReview(value: unknown): value is McpConfigurationReview {
  if (object(value) && value.variant === 'prerequisite') return isMcpPrerequisiteReview(value)
  if (!exact(value, ['kind', 'planId', 'candidateId', 'mode', 'resource', 'before', 'after', 'stages'], ['kind', 'planId', 'candidateId', 'mode', 'resource', 'before', 'after', 'stages']) ||
    value.kind !== 'mcp-configuration' || !text(value.planId) || !/^mcpp_[a-f0-9]{32}$/.test(value.planId) || !['create', 'update'].includes(String(value.mode)) ||
    !text(value.candidateId) || !/^mcpc_[a-f0-9]{32}$/.test(value.candidateId) ||
    !isMcpConfigurationResource(value.resource) || !isMcpGatewayDisclosure(value.after) || value.resource.gatewayId !== value.after.id ||
    (value.mode === 'create' ? value.before !== null : !isMcpGatewayDisclosure(value.before) || value.before.id !== value.after.id) ||
    !Array.isArray(value.stages) || !isKnownStageList(value.stages)) return false
  return encoder.encode(JSON.stringify(value)).length <= MCP_CONFIGURATION_LIMITS.previewBytes
}
export function isMcpResourceOutcome(value: unknown): value is McpResourceOutcome {
  if (object(value) && value.variant === 'prerequisite') return isMcpPrerequisiteOutcome(value)
  return exact(value, ['resource', 'status', 'saved', 'stages', 'reason'], ['resource', 'status', 'saved', 'stages']) && isMcpConfigurationResource(value.resource) &&
    ['applied', 'unchanged', 'blocked', 'conflict', 'unavailable', 'unknown'].includes(String(value.status)) &&
    ['saved', 'not_requested', 'unknown'].includes(String(value.saved)) && exact(value.stages, outcomeStageKeys(value.stages), outcomeStageKeys(value.stages)) &&
    legacyStageReadable(value.stages as Record<string, unknown>) && MCP_CONFIGURATION_STAGES.every(key => ['not_started', 'not_requested', 'issued', 'saved', 'verified', 'blocked', 'unknown', 'unconfirmed'].includes(String((value.stages as Record<string, unknown>)[key]))) &&
    (value.reason === undefined || text(value.reason, 200)) &&
    MCP_CONFIGURATION_STAGES.filter(key => key !== 'registry' && key !== 'keyReference').every(key => (value.stages as Record<string, unknown>)[key] === 'not_started') &&
    ['verified', 'not_requested'].includes(String((value.stages as Record<string, unknown>).keyReference)) &&
    (value.saved === 'saved' ? (value.stages as Record<string, unknown>).registry === 'saved' && value.status === 'applied' :
      value.saved === 'unknown' ? ['issued', 'unknown', 'unconfirmed'].includes(String((value.stages as Record<string, unknown>).registry)) && value.status === 'unknown' :
        ['not_started', 'blocked'].includes(String((value.stages as Record<string, unknown>).registry)))
}
export function parseMcpConfigurationChanges(value: unknown): McpConfigurationChanges {
  if (object(value) && Object.hasOwn(value, 'target')) {
    if (!exact(value, ['source', 'target'], ['target']) || value.source !== undefined &&
      (!exact(value.source, ['candidateId'], ['candidateId']) || typeof value.source.candidateId !== 'string' || !/^mcpc_[a-f0-9]{32}$/.test(value.source.candidateId))) throw new Error('Use the exact held MCP target and source candidate.')
    return { ...(value.source ? { source: { candidateId: value.source.candidateId as string } } : {}), target: parseMcpPrerequisiteTarget(value.target) }
  }
  if (!exact(value, ['source'], ['source']) || !exact(value.source, ['candidateId'], ['candidateId']) ||
    !text(value.source.candidateId) || !/^mcpc_[a-f0-9]{32}$/.test(value.source.candidateId)) throw new Error('Use the exact held MCP candidate.')
  return { source: { candidateId: value.source.candidateId } }
}
export function parseMcpConfigurationQuery(value: unknown): Record<string, unknown> {
  if (object(value) && value.kind === 'prerequisite') {
    if (!exact(value, ['kind', 'candidate', 'target'], ['kind', 'target'])) throw new Error('Use one exact MCP prerequisite target.')
    const candidate = value.candidate !== undefined ? parseMcpSourceCandidateData(value.candidate) : undefined
    let target: McpPrerequisiteTarget | Omit<McpPrerequisiteTarget, 'gatewayId'>
    if (candidate?.kind === 'http') {
      if (!exact(value.target, ['subject', 'membership', 'zip'], ['subject', 'membership']) || value.target.membership !== 'enable') throw new Error('A new source uses its actual assigned ID, never a caller-selected ID.')
      const subject = parseMcpPrimarySubject(value.target.subject)
      target = { subject, membership: 'enable', ...(Object.hasOwn(value.target, 'zip') ? { zip: parseMcpToolZipIntent(value.target.zip) } : {}) }
    } else target = parseMcpPrerequisiteTarget(value.target)
    if (value.candidate !== undefined && target.membership === 'disable') throw new Error('Removal does not configure or contact a source.')
    return { kind: 'prerequisite', target, ...(candidate ? { candidate } : {}) }
  }
  if (!exact(value, ['kind', 'gatewayId', 'candidate'], ['kind'])) throw new Error('Use a finite MCP source query.')
  if (value.kind === 'sources' && Object.keys(value).length === 1) return { kind: 'sources' }
  if (value.kind === 'details' && Object.keys(value).length === 2 && text(value.gatewayId)) return { kind: 'details', gatewayId: value.gatewayId }
  if (value.kind === 'candidate' && Object.keys(value).length === 2) {
    return { kind: 'candidate', candidate: parseMcpSourceCandidateData(value.candidate) }
  }
  throw new Error('Invalid MCP source query.')
}

/** Complete raw intent, before any sparse or no-op projection. */
export function parseMcpToolZipIntent(value: unknown): McpToolZipIntent {
  if (!exact(value, ['toolName', 'mode', 'bufferSize', 'zipThreshold', 'autoZip', 'zipDisabled'], ['toolName']) || !text(value.toolName, 256) ||
    !['mode', 'bufferSize', 'zipThreshold', 'autoZip', 'zipDisabled'].some(key => Object.hasOwn(value, key)) ||
    Object.hasOwn(value, 'mode') && !['normal', 'auto', 'off', 'inherit'].includes(String(value.mode)) ||
    Object.hasOwn(value, 'mode') && ['autoZip', 'zipDisabled'].some(key => Object.hasOwn(value, key)) ||
    value.mode === 'inherit' && ['bufferSize', 'zipThreshold'].some(key => Object.hasOwn(value, key)) ||
    ['bufferSize', 'zipThreshold'].some(key => Object.hasOwn(value, key) && value[key] !== null && (!Number.isSafeInteger(value[key]) || Number(value[key]) < (key === 'bufferSize' ? 1 : 0))) ||
    ['autoZip', 'zipDisabled'].some(key => Object.hasOwn(value, key) && value[key] !== null && typeof value[key] !== 'boolean')) {
    throw new Error('Use one exact logical MCP tool and a nonempty unambiguous Zip edit.')
  }
  return structuredClone(value) as McpToolZipIntent
}
export function parseMcpPrerequisiteTarget(value: unknown): McpPrerequisiteTarget {
  if (!exact(value, ['subject', 'gatewayId', 'membership', 'zip'], ['subject', 'gatewayId', 'membership']) ||
    !text(value.gatewayId) || !['enable', 'disable'].includes(String(value.membership))) throw new Error('Use one exact owned Primary and source membership intent.')
  const subject = parseMcpPrimarySubject(value.subject)
  const zip = Object.hasOwn(value, 'zip') ? parseMcpToolZipIntent(value.zip) : undefined
  if (value.membership === 'disable' && zip && !isMcpZipRemoval(zip)) throw new Error('Structural removal cannot add a positive Zip override.')
  return { subject, gatewayId: value.gatewayId,
    membership: value.membership as 'enable' | 'disable', ...(zip ? { zip } : {}) }
}
function parseMcpPrimarySubject(value: unknown): McpPrimarySubject {
  if (!exact(value, ['kind', 'id'], ['kind', 'id']) || value.kind !== 'primary' || !isCanonicalAgentId(value.id)) throw new Error('Use one exact owned Primary subject.')
  return { kind: 'primary', id: value.id }
}
export function isMcpZipRemoval(zip: McpToolZipIntent): boolean {
  return zip.mode === 'inherit' || zip.mode === undefined &&
    ['bufferSize', 'zipThreshold', 'autoZip', 'zipDisabled'].filter(key => Object.hasOwn(zip, key)).every(key => zip[key as keyof McpToolZipIntent] === null)
}
export function mcpZipStoredChanges(zip: McpToolZipIntent): Readonly<Partial<Record<'buffer_size' | 'zip_threshold' | 'auto_zip' | 'zip_disabled', number | boolean | null>>> {
  if (zip.mode === 'inherit') return { buffer_size: null, zip_threshold: null, auto_zip: null, zip_disabled: null }
  const values: Record<string, number | boolean | null> = {}
  if (zip.mode) { values.auto_zip = zip.mode === 'auto'; values.zip_disabled = zip.mode === 'off' }
  for (const [name, field] of [['bufferSize', 'buffer_size'], ['zipThreshold', 'zip_threshold'], ['autoZip', 'auto_zip'], ['zipDisabled', 'zip_disabled']] as const) {
    if (Object.hasOwn(zip, name)) values[field] = zip[name]!
  }
  if (values.zip_disabled === true) values.auto_zip = false
  return values
}
export function composeMcpManagementMode(mcp: 'block' | 'ask' | 'allow', context: 'block' | 'ask' | 'allow', hasZip: boolean): 'block' | 'ask' | 'allow' {
  if (!['block', 'ask', 'allow'].includes(mcp) || !['block', 'ask', 'allow'].includes(context)) throw new Error('The current saved MCP/Context modes are unavailable.')
  const applicable = hasZip ? [mcp, context] : [mcp]
  return applicable.includes('block') ? 'block' : applicable.includes('ask') ? 'ask' : 'allow'
}
export function isMcpPrerequisiteReview(value: unknown): value is McpPrerequisiteReview {
  try {
    if (!exact(value, ['kind', 'variant', 'planId', 'candidateId', 'mode', 'resource', 'sourceAction', 'before', 'after', 'intent', 'target', 'stages'],
      ['kind', 'variant', 'planId', 'candidateId', 'mode', 'resource', 'sourceAction', 'before', 'after', 'intent', 'target', 'stages']) || value.kind !== 'mcp-configuration' ||
      value.variant !== 'prerequisite' || typeof value.planId !== 'string' || !/^mcpp_[a-f0-9]{32}$/.test(value.planId) ||
      typeof value.candidateId !== 'string' || !/^mcpc_[a-f0-9]{32}$/.test(value.candidateId) || !isMcpConfigurationResource(value.resource) ||
      !isKnownStageList(value.stages)) return false
    const intent = parseMcpPrerequisiteTarget(value.intent)
    if (intent.gatewayId !== value.resource.gatewayId || !exact(value.target, ['subject', 'label', 'changes', 'settingsIdentity', 'effectiveZip'], ['subject', 'label', 'changes']) ||
      JSON.stringify(value.target.subject) !== JSON.stringify(intent.subject) || !text(value.target.label, 200) || !Array.isArray(value.target.changes) ||
      value.target.changes.length !== 1 + (intent.zip ? Object.keys(mcpZipStoredChanges(intent.zip)).length : 0) ||
      new Set(value.target.changes.map(row => row.field)).size !== value.target.changes.length) return false
    if (intent.zip) {
      if ((!text(value.target.settingsIdentity, 256) || !/^[A-Za-z0-9_-]{1,256}$/.test(value.target.settingsIdentity)) || !exact(value.target.effectiveZip, ['before', 'after'], ['before', 'after'])) return false
      for (const facts of [value.target.effectiveZip.before, value.target.effectiveZip.after]) {
        if (!exact(facts, ['buffer_size', 'zip_threshold', 'auto_zip', 'zip_disabled'], ['buffer_size', 'zip_threshold', 'auto_zip', 'zip_disabled']) ||
          ['buffer_size', 'zip_threshold'].some(field => facts[field] !== 'unlimited' && (typeof facts[field] !== 'number' || !Number.isFinite(facts[field]) || Number(facts[field]) < 0)) ||
          typeof facts.auto_zip !== 'boolean' || typeof facts.zip_disabled !== 'boolean') return false
      }
    } else if (value.target.settingsIdentity !== undefined || value.target.effectiveZip !== undefined) return false
    const edits = intent.zip ? mcpZipStoredChanges(intent.zip) : {}
    if (value.target.changes.some(row => !exact(row, ['field', 'label', 'before', 'after'], ['field', 'label', 'before', 'after']) || !text(row.label, 200) ||
      (row.field === 'membership' ? typeof row.before !== 'boolean' || row.after !== (intent.membership === 'enable') :
        typeof row.field !== 'string' || !row.field.startsWith('zip.') || !Object.hasOwn(edits, row.field.slice(4)) ||
        ![null, 'string', 'number', 'boolean'].includes(row.before === null ? null : typeof row.before) ||
        row.after !== edits[row.field.slice(4) as keyof typeof edits]))) return false
    if (intent.membership === 'disable') return value.mode === 'remove' && value.sourceAction === 'absent' && value.before === null && value.after === null &&
      encoder.encode(JSON.stringify(value)).length <= MCP_CONFIGURATION_LIMITS.previewBytes
    return value.mode === 'configure' && ['save', 'unchanged'].includes(String(value.sourceAction)) && isMcpGatewayDisclosure(value.after) &&
      value.after.id === intent.gatewayId && value.after.enabled === true &&
      (value.after.type === 'custom' ? value.before === null || isMcpGatewayDisclosure(value.before) && value.before.id === intent.gatewayId :
        value.after.type === 'stdio' && isMcpGatewayDisclosure(value.before) && value.before.type === 'stdio' &&
        sameJsonValue({ ...value.before, enabled: true }, value.after) &&
        value.sourceAction === (value.before.enabled ? 'unchanged' : 'save')) &&
      encoder.encode(JSON.stringify(value)).length <= MCP_CONFIGURATION_LIMITS.previewBytes
  } catch { return false }
}
function isMcpPrerequisiteOutcome(value: Record<string, unknown>): value is McpResourceOutcome {
  if (!exact(value, ['resource', 'status', 'saved', 'stages', 'reason', 'variant'], ['resource', 'status', 'saved', 'stages', 'variant']) ||
    !isMcpConfigurationResource(value.resource) || !['applied', 'unchanged', 'blocked', 'conflict', 'unavailable', 'unknown'].includes(String(value.status)) ||
    !['saved', 'not_requested', 'unknown'].includes(String(value.saved)) || !exact(value.stages, outcomeStageKeys(value.stages), outcomeStageKeys(value.stages)) ||
    !legacyStageReadable(value.stages as Record<string, unknown>) ||
    value.reason !== undefined && !text(value.reason, 200) || MCP_CONFIGURATION_STAGES.some(key =>
      !['not_started', 'not_requested', 'issued', 'saved', 'verified', 'blocked', 'unknown', 'unconfirmed'].includes(String((value.stages as Record<string, unknown>)[key])))) return false
  const stages = value.stages
  if (!['installation', 'dockerFile'].every(key => stages[key] === 'not_requested') || stages.originalTaskUse !== 'not_started') return false
  if (value.status === 'applied' || value.status === 'unchanged') return ['saved', 'not_requested'].includes(String(stages.registry)) &&
    ['verified', 'not_requested'].includes(String(stages.keyReference)) && ['verified', 'not_requested'].includes(String(stages.verification)) &&
    ['saved', 'verified'].includes(String(stages.discoverability)) && ['saved', 'verified', 'not_requested'].includes(String(stages.zip)) && value.saved !== 'unknown'
  return true
}
