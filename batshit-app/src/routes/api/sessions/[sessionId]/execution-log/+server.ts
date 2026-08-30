import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { executionViewerService } from '$lib/server/services/executionViewerService'

// SA-106: the POST and PATCH handlers retired with the n8n Primary lane. POST existed
// only for the browser send path, which recorded its own snapshot over HTTP (managed
// sends call `executionViewerService.recordSnapshot` directly from send-routed), and
// PATCH was the n8n execution-hydration lane that rebuilt per-call token stats from the
// n8n API. Both had zero non-n8n consumers, and their ~1,070 lines took a pile of
// zip-reference and token-estimate helpers with them. GET and DELETE serve the
// Execution Viewer for every surviving lane.

export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionId = params.sessionId
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found' }, { status: 404 })
  }

  const entries = await executionViewerService.getSnapshots(sessionId)
  return json({ entries })
}

// SA-106: the POST and PATCH handlers retired with the n8n Primary lane. POST existed
// only for the browser send path, which recorded its own snapshot over HTTP (managed
// sends call `executionViewerService.recordSnapshot` directly from send-routed), and
// PATCH was the n8n execution-hydration lane that reconstructed per-call token stats
// from the n8n API. Both had zero non-n8n consumers. GET and DELETE serve the
// Execution Viewer for every surviving lane and stay.

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionId = params.sessionId
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found' }, { status: 404 })
  }

  await executionViewerService.clearSnapshots(sessionId)
  return json({ success: true })
}
