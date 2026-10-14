import { redis } from '$lib/server/redis'
import {
  resolveCompiledMessageAgentId,
  type CompiledSpeakerView
} from '$lib/utils/compiledChatTags'

/**
 * BL-224: the speaker view a Compact or graduation transcript needs, read the way the compiler's
 * `buildSpeakerView` reads it (SA-128 DL-02), so the summarizer sees who said what exactly as the
 * agent does. Every other agent with a reply in `messages` is named from its `agent:` record
 * (`displayName`, then `name`), then the name its reply was stored with, then its id. Each record
 * is read once; the view's own agent is never read. A failed read is logged and falls back to the
 * stored name, as the compiler does.
 *
 * `selfAgentId` is the agent the summary is for, or `null` when it is for no one agent (a group
 * chat's shared summary), which names every agent.
 */
export async function resolveCompiledSpeakerView(options: {
  messages: ReadonlyArray<{ role?: unknown; metadata?: unknown }>
  selfAgentId: string | null
}): Promise<CompiledSpeakerView> {
  const idOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const selfAgentId = idOf(options.selfAgentId)
  const storedNames = new Map<string, string>()
  const unnamed: string[] = []
  for (const message of options.messages) {
    if (message.role !== 'assistant') continue
    const agentId = resolveCompiledMessageAgentId(message)
    if (!agentId || agentId === selfAgentId) continue
    const metadata = (message.metadata ?? {}) as Record<string, unknown>
    const stored = metadata.agentDisplayName ?? metadata.agentName
    if (typeof stored === 'string' && stored.trim()) storedNames.set(agentId, stored.trim())
    if (!unnamed.includes(agentId)) unnamed.push(agentId)
  }

  const agentNames = new Map<string, string>()
  await Promise.all(
    unnamed.map(async (agentId) => {
      let name: string | null = null
      try {
        const record = (await redis.get(`agent:${agentId}`)) as Record<string, unknown> | null
        name = idOf(record?.displayName) ?? idOf(record?.name)
      } catch (error) {
        console.warn(`[compiledSpeakerView] Could not read agent ${agentId} for its display name:`, error)
      }
      agentNames.set(agentId, name ?? storedNames.get(agentId) ?? agentId)
    })
  )

  return { selfAgentId, agentNames }
}
