import { json, type RequestHandler } from '@sveltejs/kit'
import { buildSkillSessionContextLines } from '$lib/server/services/skillSessionContext'

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const currentUserMessage =
    typeof body?.currentUserMessage === 'string' ? body.currentUserMessage : ''

  try {
    const lines = await buildSkillSessionContextLines({
      userId: locals.user.id,
      currentUserMessage
    })
    return json({ lines })
  } catch (error) {
    console.error('[skills/session-context] Failed to build skill session context', error)
    return json({ error: 'Failed to build skill session context' }, { status: 500 })
  }
}
