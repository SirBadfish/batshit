import type { MCPGateway } from '$lib/types/database'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  moveLegacyN8nInstanceToken,
  N8N_INSTANCE_TOKEN_SERVICE,
  type LegacyN8nTokenOutcome
} from '$lib/server/services/n8nInstanceCredential'

/** What the log says for an outcome that left the copy in place or wrote only part. Never a value. */
const KEPT_OUTCOME_NOTES: Partial<Record<LegacyN8nTokenOutcome, string>> = {
  kept_unreadable_key: 'kept: the saved n8n Instance MCP token cannot be read; replace or delete it in Settings → API Keys',
  kept_invalid_copy: 'kept: the old token fails the key format check; save a token in Settings → API Keys to replace it',
  conflict: 'not moved: the gateways kept changing; the next profile sync tries again',
  partial_key_written: 'moved into the saved key, but the old copy could not be removed; the next profile sync removes it',
  failed: 'not moved: a write did not happen; the next profile sync tries again'
}

/**
 * BL-1397: the legacy `metadata.authToken` copies of n8n Instance gateways, by the rules of
 * `n8nInstanceCredential.ts`: a copy moves only into an absent saved key, a saved key always wins,
 * and an unreadable one is kept. The caller's copies take the metadata as stored after the step.
 */
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
      const result = await moveLegacyN8nInstanceToken(userId, gateway.id)
      if (result.metadata) gateway.metadata = result.metadata as MCPGateway['metadata']
      const note = KEPT_OUTCOME_NOTES[result.outcome]
      if (note) console.warn(`[${logPrefix}] n8n Instance MCP token of gateway ${gateway.id} ${note}`)
    } catch (error) {
      console.warn(`[${logPrefix}] Failed to migrate n8n instance MCP token`, error)
    }
  }

  try {
    return await apiKeyService.retrieve(N8N_INSTANCE_TOKEN_SERVICE, userId)
  } catch (error) {
    console.warn(`[${logPrefix}] Failed to load n8n instance MCP token`, error)
    return null
  }
}
