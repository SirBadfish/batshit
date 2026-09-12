/**
 * SA-117 P2 (DL-117-06) — the seam where a managed CLI run gets its credential.
 *
 * Before this, both bridges called `resolveCliHelperBatshitToken(userId)`, which took a user
 * id, DISCARDED it (`void userId`), and returned the instance `BATSHIT_TOKEN` — the same one
 * secret for every run of every agent of every user. The seam already had the shape of a
 * per-run mint; it just did not mint anything.
 *
 * Now it does. One call per managed run, at the point both bridges used to resolve the
 * instance token (`codexBridge.ts`, `claudeBridge.ts`), and the returned token goes straight
 * into the child process environment as `BATSHIT_AGENT_TOKEN`. The bridge revokes it in its
 * `finally`, passing the agent it minted for so the index is pruned even if the 24-hour
 * backstop already reaped the record (SA-117 P1 review, F-P1-5).
 *
 * **The `|| MCP_GATEWAY_AUTH_TOKEN` fallback is gone** (DL-117-06). One secret per boundary:
 * the Docker gateway token unlocks the user's Docker gateway and nothing else, and the app
 * boot-fails without a real `BATSHIT_TOKEN` (`hooks.server.ts`), so the fallback could never
 * have been the value that matched anyway — it was only a second name for the instance
 * secret sitting where a reader would mistake it for a real alternative.
 *
 * **Minting fails loudly.** `mintRunCredential` throws when the agent does not exist or
 * belongs to another user, and this does not catch it. A run that cannot prove who it is must
 * not start and then fall back to naming itself in a request body — that fallback is the
 * whole problem SA-117 removes.
 */

import {
  mintRunCredential,
  type AgentRunCredentialRuntime
} from '$lib/server/services/agentRunCredentials'

export type CliRunCredential = {
  credentialId: string
  /** `<credentialId>.<secret>`, returned once. It goes into the child env and nowhere else. */
  token: string
  /** The agent the run was minted for — passed back to `revokeRunCredential` at run end. */
  agentId: string
}

export async function mintCliRunCredential(options: {
  userId: string
  agentId: string
  sessionId: string
  messageId?: string | null
  runtime: AgentRunCredentialRuntime
  /**
   * SA-117 P2 (F-P2-1) — a Subagent or Worker run, whose `agentId` is the per-run runtime id
   * `subagent_cli_<slug>`. There is no `agent:` record to check it against, and the
   * credential is marked so it cannot act as an agent.
   */
  delegated?: boolean
}): Promise<CliRunCredential> {
  const minted = await mintRunCredential({
    userId: options.userId,
    agentId: options.agentId,
    sessionId: options.sessionId,
    messageId: options.messageId ?? null,
    runtime: options.runtime,
    delegated: options.delegated === true
  })

  return {
    credentialId: minted.credentialId,
    token: minted.token,
    agentId: minted.record.agentId
  }
}
