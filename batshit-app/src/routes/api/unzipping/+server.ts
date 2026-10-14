import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { canAccessZipData, requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import { tooLargeCoolToolHoldTokens } from '$lib/server/services/toolResultHoldAdmission'
import { resolveSessionZipForHold } from '$lib/server/services/resolveSessionZipForHold'
import { isZipStateSource, type ZipStateSource } from '$lib/services/zipping'

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
    const rezippedSources: Record<string, ZipStateSource> = {}
    for (const zipId of rezippedIds || []) {
      const marker = await redis.get(`rezipped_item:${sessionId}:${zipId}`)
      const source = (marker as any)?.source
      // A marker with no readable source predates sources and was always the user's.
      rezippedSources[zipId] = isZipStateSource(source) ? source : 'user'
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

    // This route is the USER's doorway: a Hold or "Hold for N messages" from the chat or the
    // Zip Manager. An agent's hold, the parked zip actions, a Judge Juice open, and every
    // countdown are written by the server alone (SA-129 P2, SA-120 P5), so a browser can never
    // write another source, name an agent, or attach a hold path.
    delete item.path
    delete item.agentId
    item.source = 'user'

    // One writer at a time per chat (SA-129 P2b, BL-352): a reply end's hold move or countdown
    // never lands between these writes, and never writes back over them.
    const refusal = await withZipStateLock(item.sessionId, async () => {
      const resolved = await resolveSessionZipForHold(item.sessionId, item.zipId)
      if (resolved.status === 'missing') return json({ error: 'Zip not found; nothing was held.' }, { status: 404 })
      if (resolved.status === 'ambiguous') return json({ error: 'Zip ID is ambiguous in this chat; nothing was held.' }, { status: 409 })
      const { zipData } = resolved
      if (!(await canAccessZipData(zipData, user.value.id))) {
        return json({ error: 'Forbidden' }, { status: 403 })
      }
      // An older zip may identify its owner by userId alone. A known different chat is never
      // eligible for this chat's Hold state, even when both chats have the same user.
      const zipSessionId = zipData.metadata?.sessionId ?? zipData.metadata?.session_id ?? zipData.sessionId ?? zipData.session_id
      if (typeof zipSessionId === 'string' && zipSessionId !== item.sessionId) {
        return json({ error: 'Zip belongs to another session; nothing was held.' }, { status: 403 })
      }
      const tooLargeTokens = await tooLargeCoolToolHoldTokens(zipData)
      if (tooLargeTokens !== null) {
        return json({
          error: `This result is about ${Math.ceil(tooLargeTokens).toLocaleString('en-US')} tokens and is too large to hold open. The agent must fetch it in parts.`
        }, { status: 413 })
      }
      item.zipId = resolved.stateZipId
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
      return null
    })
    if (refusal) return refusal


    // A temporary hold counts down on the server: one count per accepted user message and per
    // finished reply (`advanceZipCountdowns`, SA-129 P2).

    return json({ success: true })
  } catch (error) {
    console.error('Failed to unzip item:', error)
    return new Response('Failed to unzip item', { status: 500 })
  }
}
