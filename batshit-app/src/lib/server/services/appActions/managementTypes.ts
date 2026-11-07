import type { AppActionsPolicy, AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import type { SettingsSubjectRef } from '$lib/appActions/settings/subjectTypes'
import type { AppActionsAuthorityFence } from './settings/authority'
import type { McpResourceOutcome } from '$lib/appActions/settings/mcpConfiguration'

/** Plain server contracts. Domain leaves never type-import their runtime binding map. */
export type SettingsOperationActor = { userId: string; kind: 'native' | 'portable'; id: string; generation: number; label: string; sessionId?: string }
export type SettingsManagementContext = {
  userId: string; agentId?: string | null; sessionId?: string | null; messageId?: string | null
  actorType?: string; delegatedRun?: boolean; abortSignal?: AbortSignal
  /** Existing verified agent run ID, passed internally by Fabric; never input JSON. */
  p5ApiRun?: import('./mcp/originalTask').P5ApiOriginalRun
  /** Validated route state, never a model/body identity. */
  portableSettingsActor?: { tokenId: string; authorityGeneration: number }
  /** Filled only by Fabric after the exact native approval gate. */
  settingsNativeGate?: () => void
}
export type SettingsManagementAdmission = {
  actor: SettingsOperationActor; policy: AppActionsPolicy; fence: AppActionsAuthorityFence; expiresAt?: number; signal?: AbortSignal
}
export type SettingsOperationExecution = {
  signal: AbortSignal; deadlineAt: number; actor: SettingsOperationActor; nativeStop?: AbortSignal; checkNative?: () => void
  targetStarted(subject: SettingsSubjectRef): void
  recordOutcome(outcome: AppActionsTargetOutcome): void
  /** Only a captured MCP resource recipe receives this journal sink. */
  recordResourceOutcome?(outcome: McpResourceOutcome): void
}
/** Constructed by server admission/operation owners, never accepted by an input parser. */
export type AdapterContext = Readonly<{
  admission: SettingsManagementAdmission; signal?: AbortSignal; deadlineAt: number
  refreshAuthority(): Promise<void>
  assertCurrent(): void
}>
export type AdapterCommitContext = AdapterContext & Readonly<{ execution: SettingsOperationExecution }>
