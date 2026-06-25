import type { Mode4Style } from '$lib/constants/mode4'

export type CodexPermissionMode = 'chat' | 'agent' | 'agent_full'
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApproval = 'never' | 'on-request' | 'on-failure' | 'untrusted'
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'
export type CodexModelVerbosity = 'low' | 'medium' | 'high'
export type CodexServiceTier = 'standard' | 'fast'

export interface CodexConfigOverride {
  key: string
  value: string
}

export type CodexConfigScope = 'managed' | 'global'

export type CodexHistoryPersistence = 'save-all' | 'none'

export interface CodexRuntimeSettings {
  mode4Style?: Mode4Style
  permissionMode: CodexPermissionMode
  includeProjectInstructions?: boolean
  model?: string | null
  sandbox: CodexSandbox
  approval: CodexApproval
  configScope: CodexConfigScope
  permissionOverridden?: boolean
  fullAuto: boolean
  streamingEffect: boolean
  search: boolean
  addDirs: string[]
  enableFeatures: string[]
  disableFeatures: string[]
  configOverrides: CodexConfigOverride[]
  workingDirectoryMode: 'project' | 'custom'
  customWorkingDirectory?: string
  reasoningEffort?: CodexReasoningEffort
  reasoningSummary?: CodexReasoningSummary
  modelSupportsReasoningSummaries?: boolean
  modelVerbosity?: CodexModelVerbosity
  serviceTier: CodexServiceTier
  profileId?: string
  unifiedExec: boolean
  historyPersistence: CodexHistoryPersistence
}

export interface CodexAgentSettings {
  mode4Style?: Mode4Style
  permissionMode: CodexPermissionMode
  includeProjectInstructions?: boolean
  model: string
  profileId?: string
  reasoningEffort?: CodexReasoningEffort | 'default'
  modelVerbosity?: CodexModelVerbosity
  serviceTier?: CodexServiceTier
  streamingEffect: boolean
  search: boolean
  sandbox: CodexSandbox
  approval: CodexApproval
  addDirs: string[]
  enableFeatures: string[]
  disableFeatures: string[]
  configOverrides: CodexConfigOverride[]
  workingDirectoryMode: 'project' | 'custom'
  customWorkingDirectory?: string
  configScope?: CodexConfigScope
  unifiedExec?: boolean
  historyPersistence?: CodexHistoryPersistence
}
