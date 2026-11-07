import type { AdapterContext, SettingsManagementAdmission } from '../managementTypes'
import type { ApprovedMcpScopeDelta, ActualMcpScopeSnapshot } from './scopeTransition'

/** Finite P5 bindings only. Importing this leaf registers no controls or grants. */
export const MCP_WORKFLOW_CONTROL_REFS = Object.freeze({
  native: Object.freeze({ report: 'fabric:sys.app_settings.native.report', change: 'fabric:sys.app_settings.native.change' }),
  portable: Object.freeze({ report: 'fabric:sys.app_settings.portable.report', change: 'fabric:sys.app_settings.portable.change' })
})
export const MCP_WORKFLOW_SETTING_IDS = Object.freeze([
  'mcp.workflow.configure', 'agent.mcp.discoverability', 'agent.mcp.zip-results', 'mcp.tool.invoke'
] as const)
export type McpWorkflowSettingId = typeof MCP_WORKFLOW_SETTING_IDS[number]
export const MCP_NATIVE_HELPER_WAIT_MS = Object.freeze({
  'sys.app_settings.native.report': 150_000, 'sys.app_settings.native.change': 210_000
})
export const MCP_CONFIGURE_BUDGET_MS = 180_000
export type McpJournalStage = 'installation' | 'registry' | 'credential-reference' | 'docker-profile' |
  'claude-profile' | 'verification' | 'selections-zip' | 'continuation'
export type McpStageState = 'not_requested' | 'not_started' | 'issued' | 'confirmed' | 'unknown' | 'blocked'
export type McpOperationJournal = Readonly<Record<McpJournalStage, Readonly<{
  state: McpStageState
  /** Server-owned nonsecret receipt reference; never a caller's claimed installation. */
  receiptId?: string
}>>>
export type NativeMcpOriginalRequest = Readonly<{
  bootId: string; userId: string; sessionId: string; primaryAgentId: string; originalRequestId: string
  originalScope: ActualMcpScopeSnapshot
}>
/** Stored within the existing operation/request custody, never a new durable registry. */
export type McpPendingManagementTransition = Readonly<{
  original: NativeMcpOriginalRequest; replyId: string; operationId: string; deltaDigest: string
  delta: ApprovedMcpScopeDelta; previousActualScope: ActualMcpScopeSnapshot
  phase: 'reserved' | 'verified' | 'result-observed' | 'canonical-saved' | 'consumed' | 'unknown'
}>
/**
 * Required next wiring seam at the canonical API/CLI result owner. No transport
 * implements this interface yet: booleans supplied by a model are not evidence.
 */
export interface McpCanonicalContinuationOwner {
  reserveBeforeSelfScopeEffect(input: { original: NativeMcpOriginalRequest; replyId: string; operationId: string; delta: ApprovedMcpScopeDelta }): void
  observeSameOperationResult(operationId: string, canonicalToolCallId: string): void
  persistManagementReply(operationId: string): Promise<void>
  consumeOnceAtOuterSend(operationId: string): Promise<{
    scope: ActualMcpScopeSnapshot; consumeSessionClips: false; refileUndeliveredSteersOnce: true
  }>
}
export type McpPositiveVerification = Readonly<{
  kind: 'positive'; operationId: string; gatewayId: string; configurationRevision: string
  /** Private proof of exact constructor inputs and actual listed schema, not raw secrets. */
  resolvedInputsDigest: string; listedToolsDigest: string; receiptId: string
}>
export type McpRemovalVerification = Readonly<{
  kind: 'removal-only'; operationId: string; beforeRevision: string; committedPostimageRevision: string
  authorityRevision: string; removedGatewayIds: readonly string[]
}>
export type McpSetupOwnerContext = Readonly<{
  adapter: AdapterContext; admission: SettingsManagementAdmission
  operationId: string; assignedGatewayId: string; originalRequestId: string
  /** Fixed once at first accepted execution, <=180s and captured grant/reply deadline. */
  executionDeadlineAt: number
  beforeIssue(stage: McpJournalStage): void
  confirm(stage: McpJournalStage, receiptId: string): void
  unknown(stage: McpJournalStage): void
}>
/** Existing SDK owner must consume EXACTLY these resolved inputs, with no re-resolution. */
export interface McpExactClientAdmission<ResolvedInputs, ListedTool, Arguments, Result> {
  resolvedInputs: Readonly<ResolvedInputs>
  assertBeforeStartup(): void
  observeActualListedTool(tool: ListedTool): void
  /** After all startup/list awaits: current key/config/authority, schema+args and Stop. */
  admitBeforeExecute(tool: ListedTool, args: Arguments): void
  issueOnce(tool: ListedTool, args: Arguments): Promise<Result>
}
