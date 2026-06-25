import type { MCPGateway } from '$lib/types/database'
import { apiKeyService } from '$lib/services/apiKey.server'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'

export async function migrateLegacyN8nInstanceMcpTokens(params: {
  userId: string
  gateways: MCPGateway[]
  logPrefix: string
}): Promise<string | null> {
  const { userId, gateways, logPrefix } = params

  for (const gateway of gateways) {
    if (gateway.type !== 'n8n-instance-mcp') continue
    const legacyToken = typeof gateway.metadata?.authToken === 'string' ? gateway.metadata.authToken.trim() : ''
    if (!legacyToken) continue
    try {
      await apiKeyService.store('n8n_instance_mcp_token', legacyToken, userId)
      const nextMeta = { ...(gateway.metadata ?? {}) }
      delete (nextMeta as Record<string, any>).authToken
      await mcpGatewayService.update(userId, gateway.id, { metadata: nextMeta })
      gateway.metadata = nextMeta
    } catch (error) {
      console.warn(`[${logPrefix}] Failed to migrate n8n instance MCP token`, error)
    }
  }

  try {
    return await apiKeyService.retrieve('n8n_instance_mcp_token', userId)
  } catch (error) {
    console.warn(`[${logPrefix}] Failed to load n8n instance MCP token`, error)
    return null
  }
}
