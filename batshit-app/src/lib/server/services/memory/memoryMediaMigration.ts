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
  if (await redis.exists(MEMORY_MEDIA_MIGRATION_KEY)) {
    return { status: 'already-complete', records: 0, media: 0, unresolved: 0 }
  }

  const keys = await redis.keys(`${MEMORY_KEY_PREFIX}*`)
  let records = 0
  let mediaCount = 0
  let unresolved = 0

  for (const key of keys) {
    const stored = (await redis.get(key)) as LegacyMemoryRecord | null
    if (!stored || !Array.isArray(stored.clip_ids)) continue
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
            source: 'migration'
          })
        )
      }
    } catch (error) {
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
    await redis.set(key, next)
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
