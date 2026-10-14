import { redis } from '$lib/server/redis'
import { normalizeId } from '$lib/utils/idNormalizer'

export type ResolvedSessionZipForHold =
  | { status: 'found'; rawZipId: string; stateZipId: string; zipData: any }
  | { status: 'missing' }
  | { status: 'ambiguous' }

/**
 * Hold state uses the ID normalized once from a raw zip ID, while zip storage keeps the raw ID.
 * An older Hold may therefore name a state ID that Redis cannot load as a zip. Resolve that ID
 * only through this chat's owned zip index; never guess between two raw IDs with the same state ID.
 */
export async function resolveSessionZipForHold(
  sessionId: string,
  suppliedZipId: string
): Promise<ResolvedSessionZipForHold> {
  const exact = await redis.getZip(suppliedZipId)
  if (exact) {
    const stateZipId = normalizeId(suppliedZipId)
    const siblings = ((await redis.sMembers(`session:${sessionId}:zips`)) ?? []).filter((rawZipId) => normalizeId(rawZipId) === stateZipId)
    // Even an exact raw ID cannot own a shared state key without affecting its sibling.
    if (siblings.some((rawZipId) => rawZipId !== suppliedZipId)) return { status: 'ambiguous' }
    return { status: 'found', rawZipId: suppliedZipId, stateZipId, zipData: exact }
  }

  const matches = ((await redis.sMembers(`session:${sessionId}:zips`)) ?? []).filter((rawZipId) => normalizeId(rawZipId) === suppliedZipId)
  if (matches.length === 0) return { status: 'missing' }
  if (matches.length > 1) return { status: 'ambiguous' }

  const rawZipId = matches[0]
  const zipData = await redis.getZip(rawZipId)
  if (!zipData) return { status: 'missing' }
  return { status: 'found', rawZipId, stateZipId: suppliedZipId, zipData }
}
