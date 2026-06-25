import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

// GET: Get unzipped items for a session
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const sessionId = url.searchParams.get('sessionId')
  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response

  try {
    // Get all unzipped items for this session
    const unzippedKey = `unzipped:${sessionId}`
    const unzippedIds = await redis.sMembers(unzippedKey)
    
    const unzipped = []
    for (const zipId of unzippedIds) {
      const itemKey = `unzipped_item:${sessionId}:${zipId}`
      const itemData = await redis.get(itemKey)
      if (itemData) {
        unzipped.push(itemData)
      }
    }

    // Rezipped markers force compression after manual rezip
    const rezippedKey = `rezipped:${sessionId}`
    const rezippedIds = await redis.sMembers(rezippedKey)
    const rezippedSources: Record<string, 'user' | 'agent'> = {}
    for (const zipId of rezippedIds || []) {
      const marker = await redis.get(`rezipped_item:${sessionId}:${zipId}`)
      const source = (marker as any)?.source
      rezippedSources[zipId] = source === 'agent' ? 'agent' : 'user'
    }

    return json({ unzipped, rezipped: rezippedIds || [], rezippedSources })
  } catch (error) {
    console.error('Failed to get unzipped items:', error)
    return new Response('Failed to get unzipped items', { status: 500 })
  }
}

// POST: Unzip an item (add to unzipped set)
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const item = await request.json()
    
    if (!item.zipId || !item.sessionId) {
      return new Response('Missing required fields', { status: 400 })
    }

    const sessionCheck = await requireOwnedSession(item.sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    if (item.source !== 'user' && item.source !== 'agent') {
      item.source = 'user'
    }

    // Add to unzipped set
    const unzippedKey = `unzipped:${item.sessionId}`
    await redis.sAdd(unzippedKey, item.zipId)

    // If it was manually rezipped before, clear that marker
    const rezippedKey = `rezipped:${item.sessionId}`
    await redis.sRem(rezippedKey, item.zipId)
    await redis.del(`rezipped_item:${item.sessionId}:${item.zipId}`)
    
    // Store item metadata
    const itemKey = `unzipped_item:${item.sessionId}:${item.zipId}`
    await redis.set(itemKey, item)
    
    // Set expiry if not permanent
    if (!item.permanent && item.duration) {
      // For simplicity, we'll handle expiry through the service's incrementMessageCount
      // In production, could use Redis TTL
    }

    return json({ success: true })
  } catch (error) {
    console.error('Failed to unzip item:', error)
    return new Response('Failed to unzip item', { status: 500 })
  }
}
