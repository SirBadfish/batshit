import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import {
  deleteLocalAiServer,
  listLocalAiServers,
  saveLocalAiServers
} from '$lib/server/services/localAiServers'
import type { LocalAiServerUpdate, LocalAiServerId } from '$lib/types/localAi'

export const GET: RequestHandler = async ({ locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const servers = await listLocalAiServers(userId)
    return json({ success: true, servers })
  } catch (error) {
    console.error('[Local AI] Failed to list servers:', error)
    return json({ success: false, error: 'Failed to load local AI servers' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const payload = (await request.json()) as { servers?: LocalAiServerUpdate[] }
    const servers = await saveLocalAiServers(userId, payload?.servers ?? [])
    return json({ success: true, servers })
  } catch (error: any) {
    console.error('[Local AI] Failed to save servers:', error)
    return json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save local AI settings'
    }, { status: 400 })
  }
}

export const DELETE: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const payload = await request.json()
    const id = payload?.id as LocalAiServerId | undefined
    if (!id) {
      return json({ success: false, error: 'Server id is required' }, { status: 400 })
    }
    await deleteLocalAiServer(userId, id)
    return json({ success: true, id })
  } catch (error) {
    console.error('[Local AI] Failed to delete server:', error)
    return json({ success: false, error: 'Failed to delete local AI server' }, { status: 500 })
  }
}
