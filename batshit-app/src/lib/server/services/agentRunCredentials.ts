/** Cleanup for transient credentials left by the retired CLI run lane.
 * Nothing mints or authenticates these records. The startup and agent-delete sweeps
 * retain their existing ownership; the records are excluded from backup/restore.
 */
import { redis } from '$lib/server/redis'

export const AGENT_RUN_CREDENTIAL_KEY_PREFIX = 'agent_run_credential:'
export const AGENT_RUN_CREDENTIALS_INDEX_PREFIX = 'agent_run_credentials:'
export const AGENT_RUN_CREDENTIAL_HEADER = 'x-batshit-agent-token'
export const AGENT_RUN_CREDENTIAL_ENV_VAR = 'BATSHIT_AGENT_TOKEN'
export const agentRunCredentialKey = (id: string): string => `${AGENT_RUN_CREDENTIAL_KEY_PREFIX}${id}`
export const agentRunCredentialsIndexKey = (id: string): string => `${AGENT_RUN_CREDENTIALS_INDEX_PREFIX}${id}`

async function getRunCredential(id: string): Promise<Record<string, unknown> | null> {
  if (!/^arc_[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  const record = await redis.json.get(agentRunCredentialKey(id))
  return record && typeof record === 'object' ? record as Record<string, unknown> : null
}

export async function sweepAgentRunCredentials(agentId: string): Promise<number> {
  const normalized = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalized) return 0

  const indexKey = agentRunCredentialsIndexKey(normalized)
  const ids = await redis.execute(async (client) => {
    const members = await client.sMembers(indexKey)
    return Array.isArray(members) ? (members as string[]) : []
  })

  let deleted = 0
  for (const id of ids) {
    const record = await getRunCredential(id)
    await redis.del(agentRunCredentialKey(id))
    await redis.execute(async (client) => client.sRem(indexKey, [id]))
    if (record) deleted += 1
  }
  await redis.del(indexKey)
  return deleted
}

/** The index sets of the delegated credentials the removed CLI Subagent and Worker runs minted. */
export const RETIRED_CLI_CREDENTIAL_INDEX_PATTERN = `${AGENT_RUN_CREDENTIALS_INDEX_PREFIX}subagent_cli*`

/**
 * SA-139 R5 startup step: the CLI Subagent and Worker runs were the only minters of delegated
 * credentials, indexed by their runtime id (`subagent_cli_<slug>`, `subagent_cli-<slot>`), which
 * no stored record names, so no delete ever swept those sets. Nothing mints one after R5. This
 * removes each such SET and the credential records it still lists (each would expire within
 * 24 hours anyway). A key of another type under the pattern is left alone. Idempotent. A Primary
 * Agent's own set is matched only for an id older than BL-285 (which refuses a new id starting
 * with `subagent_cli`); that set too lists only credentials the removed CLI lanes minted, since
 * nothing else mints one. Removing a credential record only ever makes a credential invalid.
 */
export async function removeRetiredCliCredentialIndexSets(): Promise<{ sets: number; records: number }> {
  const keys = await redis.execute(async (client) => {
    const found = new Set<string>()
    for await (const batch of client.scanIterator({ MATCH: RETIRED_CLI_CREDENTIAL_INDEX_PATTERN, COUNT: 500 })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) found.add(String(key))
    }
    return [...found]
  })
  let sets = 0
  let records = 0
  for (const indexKey of keys) {
    const removed = await redis.execute(async (client) => {
      if (await client.type(indexKey) !== 'set') return null
      const members = (await client.sMembers(indexKey)) as string[]
      let gone = 0
      for (const id of members) gone += await client.del(agentRunCredentialKey(id))
      await client.del(indexKey)
      return gone
    })
    if (removed === null) continue
    sets += 1
    records += removed
  }
  if (sets > 0) {
    console.info(`[Startup] Removed ${sets} retired CLI credential index set(s) and ${records} credential record(s) (SA-139 R5).`)
  }
  return { sets, records }
}
