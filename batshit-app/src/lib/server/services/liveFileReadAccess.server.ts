import { redis } from '$lib/server/redis'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { refreshedFileReadsUnavailableReason, resolveLiveFileReadsEnabled, resolveZipAiViewModeOf } from '$lib/utils/liveFileReads'
import { readTypedFileToolsHost } from './typedFileToolsHost.server'
import { normalizeGroupChatConfig } from './groupChatUtils'
import { resolveNativeToolSettings } from './nativeTools'
import { liveReadBackendMountsHostWorkspace } from './liveFileReadSnapshot.server'
import type { LiveReadOtherReaders } from './liveFileReadTurn.server'

/**
 * SA-137 Round 2: who may use Refreshed File Reads this turn, and whose copies it may refresh. The
 * route asks these before it creates a `LiveFileReadTurn`; nothing here reads a project file.
 */

/**
 * Whether an actual turn of this agent runs Refreshed File Reads: the setting resolves on, and it is
 * available for the agent now (`refreshedFileReadsUnavailableReason`: API Primary, appended Zip view,
 * a Mac or Linux host outside the app container, a backend that mounts the host workspace).
 * Unavailable means no turn: no read, no early zip, the saved value untouched (R2-2).
 */
export function refreshedFileReadsActiveFor(
  agent: Record<string, any> | null | undefined,
  globalZipSettings: Record<string, any> | null | undefined,
  executionBackend: unknown
): boolean {
  if (!agent || !resolveLiveFileReadsEnabled(agent, globalZipSettings)) return false
  return refreshedFileReadsUnavailableReason({
    primaryType: normalizePrimaryAgentType(agent as any),
    zipViewMode: resolveZipAiViewModeOf(agent, globalZipSettings),
    backend: executionBackend,
    host: readTypedFileToolsHost()
  }) === null
}

/**
 * Round 2 (R2-4, Josh: "when you turn on sharing in a group, you're giving permission for the other
 * agent to see it ... also the refreshed version"): which other readers' Read File copies a turn of
 * this chat may refresh, read from Redis each time it is asked (before and after the turn's reads).
 * A reader qualifies while it is still one of this user's API agents with its Bash file access on a
 * backend that mounts the host workspace (its current authority; its own Refreshed File Reads setting
 * is not authority: the turn that reads belongs to the recipient), and, in a group chat, still a
 * member. The answer carries each reader's current backend (a sandboxed reader's copy refreshes only
 * where its sandbox could mount the folder) and the group's sharing as the route normalizes it
 * (`normalizeGroupChatConfig`), which the turn tests per copy with the compile's own rule. Outside a
 * group (a chat that changed agents), every result is already visible to the next agent, so there is
 * no sharing gate (`sharedTools: null`). A failure to answer allows no one: those copies stay zipped.
 */
export function liveReadOtherReaders(input: { userId: string; sessionId: string }) {
  return async (agentIds: readonly string[]): Promise<LiveReadOtherReaders> => {
    const none: LiveReadOtherReaders = { readers: new Map(), sharedTools: [] }
    if (agentIds.length === 0) return none
    try {
      const [agents, session] = await Promise.all([redis.getAgents(input.userId), redis.getSession(input.sessionId)])
      const groupMeta = (session as any)?.metadata?.group_chat
      const groupId = groupMeta && typeof groupMeta === 'object' && typeof groupMeta.group_id === 'string' ? groupMeta.group_id : null
      let members: Set<string> | null = null
      let sharedTools: string[] | null = null
      if (groupId) {
        const group = await redis.getGroup(groupId)
        if (!group || group.user_id !== input.userId) return none
        const config = normalizeGroupChatConfig({ ...group, enabled: true })
        members = new Set(config?.agent_ids ?? [])
        sharedTools = config?.shared_tools ?? []
      }
      const readers = new Map<string, { backend: string }>()
      for (const id of agentIds) {
        const agent = agents.find((row) => row.id === id)
        if (!agent || normalizePrimaryAgentType(agent as any) !== 'api') continue
        if (members && !members.has(id)) continue
        const native = resolveNativeToolSettings((agent as any).provider_specific_settings)
        if (!native.bashEnabled || !liveReadBackendMountsHostWorkspace(native.executionBackend)) continue
        readers.set(id, { backend: native.executionBackend })
      }
      return { readers, sharedTools }
    } catch (error) {
      console.warn('[SA-137] Could not confirm other readers for Refreshed File Reads; their copies stay zipped this turn:', error instanceof Error ? error.message : error)
      return none
    }
  }
}
