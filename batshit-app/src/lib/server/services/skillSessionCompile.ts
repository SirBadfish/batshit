import { redis } from '$lib/server/redis'
import { listCompilableZips, isToolSharedForGroup } from '$lib/services/messageCompiler'
import type { UnzippedItem } from '$lib/services/zipping'
import type { SkillSessionRecord } from '$lib/utils/skillSessions'
import { readOriginalCoolToolEvidence } from './coolToolPromptTokens'
import { resolveSkillAccessForActor } from './slashCommandCapabilities'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

/**
 * Restore only exact, previously admitted reads omitted by the incoming history window.
 * These are original saved tool refs, never a new filesystem/skill load or an invented reply.
 * The normal compiler still owns transcript expansion, layout, source spans and group gates.
 */
export async function recoverOpenSkillReadMessages<T extends { id?: string; content?: unknown; metadata?: any }>(input: {
  record: SkillSessionRecord; agentId: string; messages: T[]; unzipped: UnzippedItem[];
  replayedMessageIds?: ReadonlySet<string>
  groupToolSharing?: { currentAgentId?: string | null; sharedTools?: string[] }
}): Promise<T[]> {
  const present = new Set(input.messages.flatMap((message) => typeof message.content === 'string'
    ? listCompilableZips(message.content, message).map((zip) => zip.id) : []))
  const held = new Map(input.unzipped.map((item) => [item.zipId, item]))
  const reads = input.record.entries.filter((entry) => entry.status === 'open' &&
    (!input.groupToolSharing || entry.agentId === (input.groupToolSharing.currentAgentId ?? input.agentId) ||
      isToolSharedForGroup({ zipType: 'cool_tool', toolCandidates: ['skill_read'] }, input.groupToolSharing.sharedTools ?? [])))
    .flatMap((entry) => entry.reads.filter((read) => read.required !== false || held.has(read.zipId)).map((read) => ({ entry, read })))
  if (reads.length === 0) return input.messages
  const result = input.messages.map((message) => ({ ...message })) as T[]
  const ids = await redis.lRange(`messages:${input.record.sessionId}`, 0, -1)
  const positions = new Map(ids.map((id, index) => [id, index]))
  const originals = new Map<string, any>()
  const checkedReaders = new Set<string>()
  for (const { entry, read } of reads) {
    if (read.required !== false && !held.has(read.zipId)) throw new Error(`Open skill ${entry.skillId} lost an admitted read Hold. Close the skill or read it again before sending.`)
    if (present.has(read.rawZipId) || input.replayedMessageIds?.has(read.messageId)) continue
    const readerKey = JSON.stringify([entry.agentId, entry.skillId])
    if (!checkedReaders.has(readerKey)) {
      const reader = await redis.json.get(`agent:${entry.agentId}`) as any
      if (typeof entry.agentCreatedAt !== 'string' || !entry.agentCreatedAt.trim() ||
          !reader || reader.id !== entry.agentId || reader.user_id !== input.record.userId ||
          normalizePrimaryAgentType(reader) === 'n8n' ||
          reader.created_at !== entry.agentCreatedAt) {
        throw new Error(`The original reader of open skill ${entry.skillId} is unavailable. Close the skill before sending.`)
      }
      const access = await resolveSkillAccessForActor(input.record.userId, entry.skillId,
        { kind: 'agent', agentId: entry.agentId }, { readOnly: true })
      if (!access.ok) throw new Error(`Open skill ${entry.skillId} is unavailable to its original reader. ${access.message} Close the skill before sending.`)
      checkedReaders.add(readerKey)
    }
    const zip = await redis.json.get(`zip:${read.rawZipId}`) as any
    const admission = zip?.metadata?.skillSessionAdmission
    if (!zip || zip.type !== 'cool_tool' || zip.metadata?.sessionId !== input.record.sessionId ||
        zip.metadata?.messageId !== read.messageId || admission?.agentId !== entry.agentId || admission?.skillId !== entry.skillId ||
        admission?.generation !== entry.generation || !read.transcriptSha256 || admission?.transcriptSha256 !== read.transcriptSha256) {
      throw new Error(`The original read of open skill ${entry.skillId} cannot be verified. Close the skill or read it again before sending.`)
    }
    const evidence = await readOriginalCoolToolEvidence(zip, (id) => redis.json.get(`zip:${id}`) as Promise<any>)
    if (evidence.digest !== read.transcriptSha256) {
      throw new Error(`The original read of open skill ${entry.skillId} changed. Close the skill or read it again before sending.`)
    }
    let original = originals.get(read.messageId)
    if (!original) {
      original = await redis.json.get(`message:${input.record.sessionId}:${read.messageId}`) as any
      if (!original || original.id !== read.messageId || original.role !== 'assistant' ||
          original.session_id !== input.record.sessionId || original.user_id !== input.record.userId ||
          (original.agent_id ?? original.agentId) !== entry.agentId || !positions.has(read.messageId)) {
        throw new Error(`The original reply holding skill ${entry.skillId} is unavailable. Close the skill before sending.`)
      }
      originals.set(read.messageId, original)
    }
    const originalRef = typeof original.content === 'string' ? listCompilableZips(original.content, original).find((zip) => zip.id === read.rawZipId) : undefined
    const reference = originalRef ? original.content.slice(originalRef.index, originalRef.index + originalRef.length)
      : `{{batshit-zip:${read.rawZipId}:::${String(zip.description || `Skill ${entry.skillId}`).replace(/[{}\r\n]/g, ' ')}}}`
    const existing = result.find((message) => message.id === read.messageId)
    if (existing) {
      existing.content = [typeof existing.content === 'string' ? existing.content : '', reference].filter(Boolean).join('\n')
      existing.metadata = { ...(existing.metadata ?? {}), zipIds: [...new Set([...(Array.isArray(existing.metadata?.zipIds) ? existing.metadata.zipIds : []), read.rawZipId])] }
    } else {
      const recovered = { id: original.id, role: 'assistant', agent_id: entry.agentId, user_id: input.record.userId,
        session_id: input.record.sessionId, created_at: original.created_at, timestamp: original.timestamp,
        content: reference, metadata: { zipIds: [read.rawZipId], skillReadRecovery: true } } as unknown as T
      const index = result.findIndex((message) => positions.has(message.id!) && positions.get(message.id!)! > positions.get(read.messageId)!)
      if (index < 0) result.push(recovered)
      else result.splice(index, 0, recovered)
    }
    present.add(read.rawZipId)
  }
  return result
}
