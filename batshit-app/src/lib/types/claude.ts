import type { Mode4Style } from '$lib/constants/mode4'

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export type ClaudeConfigScope = 'managed' | 'global'
export type ClaudeSystemPromptMode = 'default' | 'append' | 'replace' | 'replace_file'
export type ClaudeSettingSource = 'user' | 'project' | 'local'

export interface ClaudeConfigOverride {
  key: string
  value: string
}

export interface ClaudeRuntimeSettings {
  mode4Style?: Mode4Style
  permissionMode: ClaudePermissionMode
  profileId?: string
  includeCoreSystemPrompt?: boolean
  includeProjectInstructions?: boolean
  model?: string | null
  alwaysThinkingEnabled?: boolean
  maxThinkingTokens?: number
  configScope: ClaudeConfigScope
  systemPromptMode?: ClaudeSystemPromptMode
  systemPrompt?: string
  systemPromptFile?: string
  settingSources?: ClaudeSettingSource[]
  chrome?: boolean
  addDirs: string[]
  allowedTools: string[]
  disallowedTools: string[]
  configOverrides: ClaudeConfigOverride[]
  workingDirectoryMode: 'project' | 'custom'
  customWorkingDirectory?: string
}

export interface ClaudeAgentSettings {
  mode4Style?: Mode4Style
  permissionMode: ClaudePermissionMode
  profileId?: string
  includeCoreSystemPrompt?: boolean
  includeProjectInstructions?: boolean
  model?: string | null
  alwaysThinkingEnabled?: boolean
  maxThinkingTokens?: number
  configScope?: ClaudeConfigScope
  systemPromptMode?: ClaudeSystemPromptMode
  systemPrompt?: string
  systemPromptFile?: string
  chrome?: boolean
  addDirs: string[]
  allowedTools: string[]
  disallowedTools: string[]
  configOverrides: ClaudeConfigOverride[]
  workingDirectoryMode?: 'project' | 'custom'
  customWorkingDirectory?: string
}
