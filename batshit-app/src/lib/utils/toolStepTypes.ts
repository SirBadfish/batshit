export type ToolProvider =
  | 'batshit-server'
  | 'n8n-workflow'
  | 'mcp'
  | 'subagent'
  | 'llm-native'
  | 'codex'
  | 'unknown'

export type ToolSource =
  | 'direct-attachment'
  | 'mcp-gateway'
  | 'workflow'
  | 'workflow-webhook'
  | 'mode3-workflow'
  | 'native-tool'
  | 'provider-native'
  | 'codex'
  | 'unknown'

export interface ToolSourceDetectionResult {
  toolProvider: ToolProvider
  toolSource: ToolSource
  isSubagent: boolean
}

export interface IntermediateStep {
  type: 'tool' | 'tool_error' | 'error'
  toolName: string
  originalToolName?: string
  toolArgs?: any
  toolResult?: any
  toolOutput?: any
  error?: string
  timestamp?: string

  toolProvider?: ToolProvider
  toolSource?: ToolSource

  gatewayId?: string
  gatewayName?: string
  gatewayType?: 'docker' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'custom' | 'stdio'
  mcpServerName?: string

  isSubagent?: boolean
  subagentName?: string
  agentName?: string

  executionTime?: number
  success?: boolean
}
