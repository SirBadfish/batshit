import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  getInternalBatshitServerUrl,
  getInternalBatshitServerAuthHeaders,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'
import {
  AgentAvatarDeletionError,
  isAvatarOwnerId,
  isOwnAvatarFilename,
  tidyOwnerAvatars,
  type AvatarTidyOwnerType
} from '$lib/server/services/agentAvatarDeletion'

// Every owner a picture can be uploaded for, and so every owner a save can tidy (BL-281).
const AVATAR_ENTITY_TYPES = new Set<string>(['user', 'group', 'agent', 'subagent'])

type OwnerCheck =
  | { ok: true; record: Record<string, unknown> | null }
  | { ok: false; response: Response }

/**
 * BL-143 (2026-09-25): the owner of an avatar, checked before batshit-server names a picture
 * after it. The id must meet the owner id rule (batshit-server matches pictures to their owner
 * by name, so an id with glob, dot, or path characters could never be swept), and the owner
 * must exist and be the signed-in user's own. A user may only name themself.
 */
async function checkOwner(entityType: string, entityId: unknown, userId: string): Promise<OwnerCheck> {
  if (!isAvatarOwnerId(entityId)) {
    return {
      ok: false,
      response: json(
        { error: 'entityId must be letters, digits, "_" or "-" (the owner id every avatar is named after).' },
        { status: 400 }
      )
    }
  }
  if (entityType === 'user') {
    if (entityId !== userId) {
      return { ok: false, response: json({ error: 'You can only change your own avatar.' }, { status: 403 }) }
    }
    // The user's settings are the user's record (BL-281: a tidy keeps the picture they show).
    return { ok: true, record: ((await redis.getUserSettings(userId)) as Record<string, unknown> | null) ?? null }
  }
  const record = (await redis.json.get(`${entityType}:${entityId}`)) as Record<string, unknown> | null
  if (!record) {
    return { ok: false, response: json({ error: `No ${entityType} "${entityId}" was found.` }, { status: 404 }) }
  }
  if (record.user_id !== userId) {
    return { ok: false, response: json({ error: 'Unauthorized' }, { status: 403 }) }
  }
  return { ok: true, record }
}

// POST /api/uploads/avatar — session-authed proxy for browser avatar uploads
// (user, group, and agent settings panels). batshit-server's upload routes are
// service-token-gated, so the browser can no longer call them directly.
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let incoming: FormData
  try {
    incoming = await request.formData()
  } catch {
    return json({ error: 'Expected multipart form data' }, { status: 400 })
  }

  const entityType = incoming.get('entityType')
  if (typeof entityType !== 'string' || !AVATAR_ENTITY_TYPES.has(entityType)) {
    return json({ error: 'Unsupported avatar entityType' }, { status: 400 })
  }
  const entityId = incoming.get('entityId')
  const owner = await checkOwner(entityType, entityId, user.value.id)
  if (!owner.ok) return owner.response

  const file = incoming.get('file')
  if (!(file instanceof File)) {
    return json({ error: 'No file uploaded' }, { status: 400 })
  }

  // Only the fields checked above go on, never the browser's form as it came. No old picture
  // goes with them (BL-281): an upload deletes nothing, and every panel tidies after its save
  // (BL-145), so a refused save never points at a deleted picture.
  const forwarded = new FormData()
  forwarded.append('file', file, file.name)
  forwarded.append('entityType', entityType)
  forwarded.append('entityId', entityId as string)

  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/avatar`, {
    method: 'POST',
    headers: getInternalBatshitServerAuthHeaders(),
    body: forwarded
  })

  const payloadText = await response.text()
  try {
    return json(resolveUploadUrlsForBrowserInPayload(JSON.parse(payloadText)), {
      status: response.status
    })
  } catch {
    // Preserve non-JSON batshit-server errors exactly for troubleshooting.
  }

  return new Response(payloadText, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' }
  })
}

// DELETE /api/uploads/avatar — BL-142 (2026-09-25): after an agent, Subagent, Group, or user
// (BL-281) settings save changed its picture, delete every picture of that owner except the one
// its SAVED record shows. The browser names only the owner; the stored record decides what
// stays, and batshit-server leaves any picture still on its way to a save (BL-288).
export const DELETE: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { entityType?: unknown; entityId?: unknown; replaced?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Expected a JSON body' }, { status: 400 })
  }
  const entityType = body?.entityType
  if (typeof entityType !== 'string' || !AVATAR_ENTITY_TYPES.has(entityType)) {
    return json({ error: 'entityType must be "user", "agent", "subagent", or "group".' }, { status: 400 })
  }
  const owner = await checkOwner(entityType, body?.entityId, user.value.id)
  if (!owner.ok) return owner.response
  const record = owner.record ?? {}
  // BL-288: the picture this save replaced, which lets a cleared picture go at once. Only the
  // owner's own picture passes; anything else is dropped. Like every tidy, it can reach only
  // the owner's own pictures.
  const replacedFilename =
    typeof body?.replaced === 'string' &&
    isOwnAvatarFilename(entityType as AvatarTidyOwnerType, body.entityId as string, body.replaced)
      ? body.replaced
      : null

  try {
    const result = await tidyOwnerAvatars({
      type: entityType as AvatarTidyOwnerType,
      id: body.entityId as string,
      avatar: record.avatar,
      avatar_url: record.avatar_url,
      replacedFilename
    })
    return json({ success: true, ...result })
  } catch (error) {
    if (error instanceof AgentAvatarDeletionError) {
      return json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
