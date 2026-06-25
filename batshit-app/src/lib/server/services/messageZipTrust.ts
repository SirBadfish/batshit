import { redis } from '$lib/server/redis'
import type { ChatMemoryRow } from '$lib/types/database'
import {
  collectTrustedZipIdsFromMetadata,
  extractTrustedZipIdsFromContent
} from '$lib/utils/zipReferenceSafety'

type ZipReference = {
  id: string
  reference: string
}

function extractZipReferences(content: string): ZipReference[] {
  if (!content || !content.includes('{{batshit-zip:')) return []

  const refs: ZipReference[] = []
  const regex = /\{\{batshit-zip:([^:}\s]+)(?::::[^}]*)?\}\}/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(content)) !== null) {
    if (match[1] && match[0]) {
      refs.push({ id: match[1], reference: match[0] })
    }
  }
  return refs
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function zipBelongsToMessage(zipData: any, userId: string, sessionId: string): boolean {
  if (!zipData || typeof zipData !== 'object') return false

  const zipUserId = readString(
    zipData?.metadata?.userId ?? zipData?.metadata?.user_id ?? zipData?.userId ?? zipData?.user_id
  )
  if (zipUserId && zipUserId !== userId) return false

  const zipSessionId = readString(
    zipData?.metadata?.sessionId ??
      zipData?.metadata?.session_id ??
      zipData?.sessionId ??
      zipData?.session_id
  )
  if (zipSessionId) return zipSessionId === sessionId

  return Boolean(zipUserId)
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export async function enrichMessagesWithTrustedZipMetadata(
  messages: ChatMemoryRow[],
  userId: string
): Promise<ChatMemoryRow[]> {
  const candidatesByMessage = new Map<string, ZipReference[]>()
  const allCandidateIds = new Set<string>()

  for (const message of messages) {
    if (typeof message?.content !== 'string' || !message.content.includes('{{batshit-zip:')) continue

    const existingTrustedIds = new Set(collectTrustedZipIdsFromMetadata(message.metadata))
    const contentIds = extractTrustedZipIdsFromContent(message.content, {
      allowConcreteWithoutTrustedSet: true
    })
    const refs = extractZipReferences(message.content).filter(
      (ref) => contentIds.includes(ref.id) && !existingTrustedIds.has(ref.id)
    )
    if (refs.length === 0) continue

    candidatesByMessage.set(message.id, refs)
    refs.forEach((ref) => allCandidateIds.add(ref.id))
  }

  if (allCandidateIds.size === 0) return messages

  const zipMap = await redis.getZips(Array.from(allCandidateIds))

  return messages.map((message) => {
    const refs = candidatesByMessage.get(message.id)
    if (!refs?.length) return message

    const trustedRefs = refs.filter((ref) => {
      const zipData = zipMap.get(ref.id)
      return zipData && zipBelongsToMessage(zipData, userId, message.session_id)
    })
    if (trustedRefs.length === 0) return message

    const metadata =
      message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? { ...(message.metadata as Record<string, any>) }
        : {}
    const existingIds = collectTrustedZipIdsFromMetadata(metadata)
    const zipIds = unique([...existingIds, ...trustedRefs.map((ref) => ref.id)])
    const existingReferences = Array.isArray(metadata.zipReferences) ? metadata.zipReferences : []
    const existingReferenceStrings = new Set(
      existingReferences
        .map((entry: any) => (typeof entry === 'string' ? entry : entry?.reference))
        .filter((entry: unknown): entry is string => typeof entry === 'string')
    )
    const zipReferences = [
      ...existingReferences,
      ...trustedRefs
        .filter((ref) => !existingReferenceStrings.has(ref.reference))
        .map((ref) => ({ reference: ref.reference }))
    ]

    return {
      ...message,
      metadata: {
        ...metadata,
        zipIds,
        zipReferences
      }
    }
  })
}
