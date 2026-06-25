import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'

async function clearDeletedGroupFromSessions(userId: string, groupId: string) {
  const sessions = await redis.getSessions(userId, true)
  const clearedSessionIds: string[] = []

  for (const session of sessions) {
    const metadata = session.metadata && typeof session.metadata === 'object'
      ? { ...(session.metadata as Record<string, any>) }
      : {}
    const sessionGroupId = metadata.group_chat?.group_id
    if (sessionGroupId !== groupId) continue

    delete metadata.group_chat
    await redis.updateSession(session.id, { metadata })
    clearedSessionIds.push(session.id)
  }

  return clearedSessionIds
}

// GET /api/groups/[id] - Get a specific group
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'Group ID is required' }, { status: 400 })
  }

  try {
    const group = await redis.getGroup(params.id)
    if (!group) {
      return json({ error: 'Group not found' }, { status: 404 })
    }

    if (group.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    return json(group)
  } catch (error) {
    console.error('Error getting group:', error)
    return json({ error: 'Failed to get group' }, { status: 500 })
  }
}

// PUT /api/groups/[id] - Update a group
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'Group ID is required' }, { status: 400 })
  }

  try {
    const updates = await request.json()
    const group = await redis.getGroup(params.id)
    if (!group) {
      return json({ error: 'Group not found' }, { status: 404 })
    }

    if (group.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    const sanitizedUpdates = {
      ...(updates as Record<string, any>),
      ...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_ref')
        ? { avatar_icon_ref: normalizeOptionalIconRefInput(updates.avatar_icon_ref, 'avatar_icon_ref') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_fit')
        ? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(updates.avatar_icon_fit, 'avatar_icon_fit') }
        : {})
    }

    await redis.updateGroup(params.id, sanitizedUpdates)
    return json({ success: true })
  } catch (error) {
    console.error('Error updating group:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to update group' },
      { status: (error as any)?.status ?? 500 }
    )
  }
}

// DELETE /api/groups/[id] - Delete a group
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!params.id) {
    return json({ error: 'Group ID is required' }, { status: 400 })
  }

  try {
    const group = await redis.getGroup(params.id)
    if (!group) {
      return json({ error: 'Group not found' }, { status: 404 })
    }

    if (group.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    await redis.deleteGroup(params.id)
    const clearedSessionIds = await clearDeletedGroupFromSessions(locals.user.id, params.id)
    return json({ success: true, clearedSessionIds })
  } catch (error) {
    console.error('Error deleting group:', error)
    return json({ error: 'Failed to delete group' }, { status: 500 })
  }
}
