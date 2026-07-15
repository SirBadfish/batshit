import { redis } from '$lib/server/redis'
import { removeClipFromSessionState } from '$lib/server/services/clipDeletion'

// System Clips retired from the product. Startup removes their records and
// detaches them from any session that still references them, so instances
// created before the retirement converge on the current System Clip set.
// SA-092: the Batshit Guide clip became the /batshit-guide system skill.
const RETIRED_SYSTEM_CLIP_IDS = ['batshit_guide']

const SYSTEM_CLIPS_SET_KEY = 'user:system:clips'

export async function removeRetiredSystemClips(): Promise<void> {
  for (const clipId of RETIRED_SYSTEM_CLIP_IDS) {
    const recordKey = `clip:system:${clipId}`
    const [recordExists, systemClipIds] = await Promise.all([
      redis.exists(recordKey),
      redis.sMembers(SYSTEM_CLIPS_SET_KEY)
    ])
    const isListed = systemClipIds.includes(clipId)
    if (!recordExists && !isListed) continue

    // Retired clips can still be attached to sessions. Sweep every user's
    // sessions with the same detach path normal clip deletion uses, so no
    // session keeps a live reference to a clip that no longer exists.
    const userSessionKeys = await redis.keys('user:*:sessions')
    for (const userSessionKey of userSessionKeys) {
      const sessionIds = await redis.sMembers(userSessionKey)
      await Promise.all(
        sessionIds.map((sessionId) => removeClipFromSessionState(sessionId, clipId))
      )
    }

    await redis.sRem(SYSTEM_CLIPS_SET_KEY, clipId)
    await redis.del(recordKey)
    console.log(`[Startup] Removed retired system clip: ${clipId}`)
  }
}
