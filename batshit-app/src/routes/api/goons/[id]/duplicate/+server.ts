import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonRecord } from '$lib/types/goons'
import { GOON_RECIPE_OWNER_V2_CONTRACT } from '$lib/goons/recipe'
import {
  duplicateRecipeGoon,
  GoonRecipeDuplicationError
} from '$lib/server/services/goonRecipeDuplicationService.server'
import { GoonRecipeLifecycleError } from '$lib/server/services/goonRecipeLifecycleService.server'

function generateGoonId() {
  return `goon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!params.id) {
    return json({ error: 'Goon id is required' }, { status: 400 })
  }

  const goonId = params.id

  try {
    const source = await redis.execute(async (client) =>
      client.json.get(`goon:${goonId}`) as Promise<GoonRecord | null>
    )
    if (!source || source.user_id !== locals.user.id) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }
    if (source.recipe?.contract === GOON_RECIPE_OWNER_V2_CONTRACT) {
      const now = new Date().toISOString()
      const newGoonId = generateGoonId()
      const baseName = source.name?.trim() || 'New Goon'
      const result = await duplicateRecipeGoon({
        userId: locals.user.id,
        sourceGoonId: goonId,
        targetGoonId: newGoonId,
        name: `${baseName} Copy`,
        now
      })
      return json({ goon: resolveUploadUrlsForBrowserInPayload(result) })
    }

    const result = await redis.execute(async (client) => {
      const existing = (await client.json.get(`goon:${goonId}`)) as GoonRecord | null
      if (!existing) return null
      if (existing.user_id !== locals.user!.id) return null

      const now = new Date().toISOString()
      const newGoonId = generateGoonId()
      const baseName = existing.name?.trim() || 'New Goon'
      const name = `${baseName} Copy`

      const clone = normalizeUploadUrlsForStorageInPayload<GoonRecord>({
        ...JSON.parse(JSON.stringify(existing)),
        id: newGoonId,
        user_id: locals.user!.id,
        name,
        created_at: now,
        updated_at: now,
        vrmUpdate: null
      })
      if (clone.files) {
        delete clone.files.vrmPending
      }
      if (clone.customAvatar?.pending) {
        delete clone.customAvatar.pending
      }

      await client.json.set(`goon:${newGoonId}`, '$', clone as any)
      await client.sAdd(`user:${locals.user!.id}:goons`, newGoonId)
      return clone
    })

    if (!result) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }

    return json({ goon: resolveUploadUrlsForBrowserInPayload(result) })
  } catch (error) {
    if (error instanceof GoonRecipeDuplicationError || error instanceof GoonRecipeLifecycleError) {
      return json({ error: error.message }, { status: error.status })
    }
    console.error('Error duplicating goon:', error)
    return json({ error: 'Failed to duplicate goon' }, { status: 500 })
  }
}
