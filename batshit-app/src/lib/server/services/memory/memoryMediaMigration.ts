import { commitMemoryMutation, readMemoryMutationSnapshot, memoryMutationUnknown } from './memoryMutation'
import { redis } from '$lib/server/redis'
import type { MemoryMediaRecord, MemoryRecord } from './memoryTypes'
import { MEMORY_KEY_PREFIX, MEMORY_MEDIA_MIGRATION_KEY } from './memoryKeys'
import { copyClipToMemoryMedia, deleteMemoryMedia, MemoryMediaError } from './memoryMedia'

type LegacyMemoryRecord = MemoryRecord & { clip_ids?: string[] }

export interface MemoryMediaMigrationResult {
  status: 'already-complete' | 'migrated'
  records: number
  media: number
  unresolved: number
}

/**
 * One-shot clean-break migration from Clip references to memory-owned images.
 * Each record is atomic: a failed source copy removes any partial assets, records
 * an honest provenance note, writes media: [], and retires clip_ids permanently.
 */
export async function ensureMemoryMediaMigration(): Promise<MemoryMediaMigrationResult> {
  // A failed read is not an absent marker or an absent memory. These reads must
  // retain the raw client's errors instead of the generic get facade's null.
  const { present, receipt } = await redis.execute(async (client) => {
    const kind = await client.type(MEMORY_MEDIA_MIGRATION_KEY)
    if (kind === 'none') return { present: false, receipt: null }
    if (kind !== 'ReJSON-RL') throw new Error('The memory-media migration receipt is unreadable or unsupported.')
    return { present: true, receipt: await client.json.get(MEMORY_MEDIA_MIGRATION_KEY) }
  })
  // JSON null is a present unsupported receipt, not permission to run the migration again.
  if (present) {
    const stored = receipt as Partial<MemoryMediaMigrationResult>
    if (
      !stored || typeof stored !== 'object' || stored.status !== 'migrated' ||
      ![stored.records, stored.media, stored.unresolved].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
    ) {
      throw new Error('The memory-media migration receipt is unreadable or unsupported.')
    }
    return {
      status: 'already-complete',
      records: stored.records!,
      media: stored.media!,
      unresolved: stored.unresolved!
    }
  }

  const keys = await redis.keys(`${MEMORY_KEY_PREFIX}*`)
  let records = 0
  let mediaCount = 0
  let unresolved = 0

  for (const key of keys) {
    const stored = (await redis.execute((client) => client.json.get(key))) as LegacyMemoryRecord | null
    if (!stored || !Array.isArray(stored.clip_ids)) continue
    const mutation = await readMemoryMutationSnapshot(stored.agent_id, { targetIds: [stored.id] })
    const original = mutation.records.find(record => record.id === stored.id) as LegacyMemoryRecord | undefined
    if (!original || JSON.stringify(original) !== JSON.stringify(stored)) throw new Error('Memory changed before media migration.')
    const clipIds = Array.from(new Set(stored.clip_ids.filter((value) => typeof value === 'string' && value.trim())))
    const copied: MemoryMediaRecord[] = []
    let failure: string | null = null
    try {
      for (const clipId of clipIds) {
        copied.push(
          await copyClipToMemoryMedia({
            userId: stored.user_id,
            agentId: stored.agent_id,
            memoryId: stored.id,
            clipId,
            source: 'migration',
            lifecycle: mutation.lifecycle
          })
        )
      }
    } catch (error) {
      if (memoryMutationUnknown(error)) throw error
      for (const media of copied) await deleteMemoryMedia(media).catch(() => {})
      failure = error instanceof MemoryMediaError ? error.message : String(error)
    }

    const next = { ...stored } as LegacyMemoryRecord
    delete next.clip_ids
    next.media = failure ? [] : copied
    if (copied.length > 0) next.media_mode = 'on_recall'
    if (failure) {
      next.provenance = [...(next.provenance ?? [])]
      if (next.provenance.length > 0) {
        next.provenance[0] = {
          ...next.provenance[0],
          note: `Memory-media migration could not copy ${clipIds.join(', ')}: ${failure}`
        }
      }
      unresolved += clipIds.length
    }
    try { await commitMemoryMutation(mutation, new Map([[key, next]])) }
    catch (error) {
      if (!memoryMutationUnknown(error)) for (const media of copied) await deleteMemoryMedia(media).catch(() => {})
      throw error
    }
    records += 1
    mediaCount += failure ? 0 : copied.length
  }

  const result: MemoryMediaMigrationResult = {
    status: 'migrated',
    records,
    media: mediaCount,
    unresolved
  }
  await redis.set(MEMORY_MEDIA_MIGRATION_KEY, {
    ...result,
    completed_at: new Date().toISOString()
  })
  return result
}
