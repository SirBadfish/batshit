/**
 * BL-1397: the n8n Instance MCP token has two owners. The saved key
 * `api_keys:{userId}:n8n_instance_mcp_token` is canonical; older data may also hold a copy in an
 * n8n Instance gateway's `metadata.authToken`. Rules:
 * - Only an explicit save (Settings → API Keys, or a token sent in a gateway PUT/POST body) writes
 *   the saved key unconditionally. A copy moves only into an ABSENT key; an existing key wins, and
 *   one that does not decrypt is present (kept, never overwritten, never guessed at).
 * - A copy leaves a gateway only with a disposition: moved into the absent key, already there, or
 *   superseded by a different readable saved key. An invalid copy with no saved key stays.
 * - An explicit delete removes the saved key and EVERY copy in one guarded step.
 * Each write compares the raw text of BOTH owners (`redis.json.moveLegacyN8nToken` /
 * `deleteN8nToken`, scripts in `$lib/server/n8nCredentialScripts.ts`). No value is ever logged
 * or answered.
 */
import { redis } from '$lib/server/redis'
import { apiKeyService } from '$lib/services/apiKey.server'

export const N8N_INSTANCE_TOKEN_SERVICE = 'n8n_instance_mcp_token'
const TRIES = 3

export type LegacyN8nTokenOutcome =
  /** The copy moved into the absent saved key and left the gateway. */
  | 'moved'
  /** The saved key already held the copy's token; the copy left the gateway. */
  | 'retired'
  /** A different, readable saved key exists; the copy left the gateway. */
  | 'superseded'
  /** The saved key does not decrypt: nothing written, the copy stays for recovery. */
  | 'kept_unreadable_key'
  /** No saved key, and the copy fails the key format checks: nothing written, the copy stays. */
  | 'kept_invalid_copy'
  /** The gateway has no copy (or is gone, or is not an n8n Instance gateway). */
  | 'no_copy'
  /** Three tries were refused because another write landed: nothing written by this step. */
  | 'conflict'
  /** The key was written and removing the copy failed: the token is in both; the next run retires. */
  | 'partial_key_written'
  /** A write did not happen: nothing written. */
  | 'failed'

export interface LegacyN8nTokenResult {
  outcome: LegacyN8nTokenOutcome
  /** The gateway's metadata as stored after this step (no token when it left), when it was read. */
  metadata?: Record<string, unknown>
}

function registryKeyOf(userId: string): string {
  return `mcp_gateways:${userId}`
}

function firstOf(raw: string): any {
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null
}

function withoutToken(metadata: Record<string, unknown>): Record<string, unknown> {
  const { authToken: _token, ...rest } = metadata
  return rest
}

/** Move, retire or keep the legacy copy of ONE gateway, by the rules above. */
export async function moveLegacyN8nInstanceToken(userId: string, gatewayId: string): Promise<LegacyN8nTokenResult> {
  const registryKey = registryKeyOf(userId)
  const keyKey = apiKeyService.storedKeyName(N8N_INSTANCE_TOKEN_SERVICE, userId)

  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const registryRaw = await redis.json.getRaw(registryKey, '$')
    if (registryRaw === null) return { outcome: 'no_copy' }
    const gateways = firstOf(registryRaw)?.gateways
    const index = Array.isArray(gateways) ? gateways.findIndex((gateway: any) => gateway?.id === gatewayId) : -1
    if (index === -1) return { outcome: 'no_copy' }

    // The element's own text, read again and id-checked: a delete can shift the list in between.
    const elementPath = `$.gateways[${index}]`
    const elementRaw = await redis.json.getRaw(registryKey, elementPath)
    const element = elementRaw === null ? null : firstOf(elementRaw)
    if (!element || element.id !== gatewayId) continue
    const metadata: Record<string, unknown> =
      element.metadata && typeof element.metadata === 'object' && !Array.isArray(element.metadata) ? element.metadata : {}
    const copy = typeof metadata.authToken === 'string' ? metadata.authToken.trim() : ''
    if (element.type !== 'n8n-instance-mcp' || !copy) return { outcome: 'no_copy', metadata }

    const saved = await apiKeyService.readStoredState(N8N_INSTANCE_TOKEN_SERVICE, userId)
    if (saved.state === 'unreadable') return { outcome: 'kept_unreadable_key', metadata }

    let outcome: LegacyN8nTokenOutcome
    let newKeyDocument: unknown | null = null
    if (saved.state === 'absent') {
      try {
        newKeyDocument = apiKeyService.buildStoredDocument(N8N_INSTANCE_TOKEN_SERVICE, copy)
      } catch (error) {
        // Only the key format and injection checks make a copy "invalid" (their messages start
        // with "Invalid" and never carry the value); anything else (encryption) is a real failure.
        if (error instanceof Error && error.message.startsWith('Invalid')) {
          return { outcome: 'kept_invalid_copy', metadata }
        }
        throw error
      }
      outcome = 'moved'
    } else {
      outcome = saved.value === copy ? 'retired' : 'superseded'
    }

    const answer = await redis.json.moveLegacyN8nToken(
      keyKey,
      registryKey,
      saved.raw,
      elementPath,
      elementRaw!,
      newKeyDocument
    )
    if (answer.kind === 'ok') return { outcome, metadata: withoutToken(metadata) }
    if (answer.kind === 'changed') continue
    if (answer.kind === 'partial_key_written') return { outcome: 'partial_key_written', metadata }
    return { outcome: 'failed', metadata }
  }
  return { outcome: 'conflict' }
}

export type N8nTokenDeleteResult =
  /** The saved key and every copy are gone. */
  | { outcome: 'deleted'; copiesCleared: number }
  /** A newer token was saved after this delete began: nothing deleted. */
  | { outcome: 'key_changed' }
  /** The gateways kept changing (three refused tries): nothing deleted. */
  | { outcome: 'conflict' }
  /** Some copies were removed, then a write failed: the saved key is still there. */
  | { outcome: 'partial'; copiesCleared: number }

/**
 * The explicit delete: the saved key and every legacy copy, in one step guarded by the saved key's
 * text as this request first read it (so a newer save is never deleted) and the WHOLE registry's
 * text (so a copy or gateway added meanwhile refuses the step instead of being missed).
 */
export async function deleteN8nInstanceToken(userId: string): Promise<N8nTokenDeleteResult> {
  const registryKey = registryKeyOf(userId)
  const keyKey = apiKeyService.storedKeyName(N8N_INSTANCE_TOKEN_SERVICE, userId)
  const keyRaw = (await redis.json.getRaw(keyKey, '$')) ?? ''

  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const registryRaw = (await redis.json.getRaw(registryKey, '$')) ?? ''
    const gateways = registryRaw ? firstOf(registryRaw)?.gateways : null
    const copyPaths: string[] = []
    if (Array.isArray(gateways)) {
      gateways.forEach((gateway: any, index: number) => {
        if (gateway?.type === 'n8n-instance-mcp' && typeof gateway?.metadata?.authToken === 'string') {
          copyPaths.push(`$.gateways[${index}].metadata.authToken`)
        }
      })
    }

    const answer = await redis.json.deleteN8nToken(keyKey, registryKey, keyRaw, registryRaw, copyPaths)
    if (answer.kind === 'ok') return { outcome: 'deleted', copiesCleared: answer.copiesCleared }
    if (answer.kind === 'key_changed') return { outcome: 'key_changed' }
    if (answer.kind === 'partial') return { outcome: 'partial', copiesCleared: answer.copiesCleared }
    if (answer.kind === 'invalid') {
      throw new Error('The n8n Instance MCP token delete planned a copy the registry did not hold; nothing was deleted.')
    }
  }
  return { outcome: 'conflict' }
}
