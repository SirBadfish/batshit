import { redis } from '$lib/server/redis'

const agentsBeingDeleted = new Map<string, number>()

export function markAgentBeingDeleted(agentId: string): () => void {
  agentsBeingDeleted.set(agentId, (agentsBeingDeleted.get(agentId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (agentsBeingDeleted.get(agentId) ?? 1) - 1
    if (left > 0) agentsBeingDeleted.set(agentId, left)
    else agentsBeingDeleted.delete(agentId)
  }
}

/** Read under the chat zip lock, like the deletion sweep. */
export async function agentMayWriteZipState(agentId: string): Promise<boolean> {
  return !agentsBeingDeleted.has(agentId) && await redis.exists(`agent:${agentId}`)
}
