import type { Tool } from 'ai'

// Runtime tools carry a name field, but the AI SDK Tool type does not include it.
export type ToolWithName = Tool & {
  name: string
}

export interface GatewayMetadata {
  gatewayId: string
  gatewayName: string
  gatewayType: 'docker' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'n8n-mcp-client' | 'custom' | 'stdio'
  mcpServerName: string
  originalToolName: string
}

export interface ToolMetadataMap {
  tools: Record<string, Tool>
  metadata: Map<string, GatewayMetadata>
}
