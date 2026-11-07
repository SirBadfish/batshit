import { json, type RequestHandler } from '@sveltejs/kit'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { closeSkillSession, readChatOpenSkillSessions } from '$lib/server/services/skillSessions'
import { isBareSkillId } from '$lib/utils/skillSessions'
import { publishUserEvent } from '$lib/server/ssePublisher'

export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const sessionId = url.searchParams.get('sessionId')
  const session = await requireOwnedSession(sessionId, user.value.id)
  if (!session.ok) return session.response
  try {
    const skills = await readChatOpenSkillSessions({ userId: user.value.id, sessionId: session.value.id })
    return json({ skills: skills.map(({ agentId, skillId, name, generation, revision, openMessages }) =>
      ({ agentId, skillId, name, generation, revision, openMessages })) })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Open skills could not be read.' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  let body: any
  try { body = await request.json() } catch { return json({ error: 'Invalid close request.' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.agentId !== 'string' || !body.agentId || typeof body.skillId !== 'string' || !isBareSkillId(body.skillId) ||
      !Number.isSafeInteger(body.generation) || body.generation < 1 || !Number.isSafeInteger(body.revision) || body.revision < 1) {
    return json({ error: 'Name the exact open skill and agent from the current list.' }, { status: 400 })
  }
  const session = await requireOwnedSession(body.sessionId, user.value.id)
  if (!session.ok) return session.response
  try {
    const result = await closeSkillSession({
      userId: user.value.id, sessionId: session.value.id, agentId: body.agentId, skillId: body.skillId,
      provenance: 'user', expectedGeneration: body.generation, expectedRevision: body.revision
    })
    if (result.status === 'refused') return json({ error: result.reason }, { status: 409 })
    if (result.status === 'closed') await publishUserEvent(user.value.id, {
      type: 'zip_state_changed', sessionId: session.value.id, source: 'user', opened: [], rezipped: result.changedZipIds
    })
    return json(result)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'The skill close could not be confirmed. Refresh the list.' }, { status: 500 })
  }
}
