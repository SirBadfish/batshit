import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import type { GoonRecord } from '$lib/types/goons'

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
    const result = await redis.execute(async (client) => {
      const existing = (await client.json.get(`goon:${goonId}`)) as GoonRecord | null
      if (!existing) return null
      if (existing.user_id !== locals.user!.id) return null

      const now = new Date().toISOString()
      const newGoonId = generateGoonId()
      const baseName = existing.name?.trim() || 'New Goon'
      const name = `${baseName} Copy`

      const clone: GoonRecord = {
        ...JSON.parse(JSON.stringify(existing)),
        id: newGoonId,
        user_id: locals.user!.id,
        name,
        created_at: now,
        updated_at: now,
        vrmUpdate: null
      }
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

    return json({ goon: result })
  } catch (error) {
    console.error('Error duplicating goon:', error)
    return json({ error: 'Failed to duplicate goon' }, { status: 500 })
  }
}
