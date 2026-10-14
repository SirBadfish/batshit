import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { validateGroupAgentSettingsInput } from '$lib/types/groupChat'
import {
  AgentAvatarDeletionError,
  checkBatshitServerCanDeleteAvatars,
  deleteOwnerAvatars,
  isAvatarOwnerId
} from '$lib/server/services/agentAvatarDeletion'

// BL-723: each of the Group's chats loses only its `metadata.group_chat`, written by path. The
// chats are read once, before the loop; writing back each copy's whole metadata erased a Compact
// event or any other block written since.
//
// BL-736: the read above is a snapshot, so a chat moved to a DIFFERENT Group in the gap between it
// and this chat's own write must keep its new Group. The check here is only the fast skip for
// chats the snapshot already shows in another Group; `clearGroupChatIfMatches` re-checks the LIVE
// value and writes conditionally, closing the gap the snapshot cannot.
async function clearDeletedGroupFromSessions(userId: string, groupId: string) {
  const sessions = await redis.getSessions(userId, true)
  const clearedSessionIds: string[] = []

  for (const session of sessions) {
    const metadata = session.metadata && typeof session.metadata === 'object'
      ? (session.metadata as Record<string, any>)
      : {}
    const sessionGroupId = metadata.group_chat?.group_id
    if (sessionGroupId !== groupId) continue

    if (await redis.clearGroupChatIfMatches(session.id, groupId)) clearedSessionIds.push(session.id)
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

    // SA-120 P3: a speaking preset must be one Batshit knows; a typo is refused, never read as something else.
    const agentSettingsError = Object.prototype.hasOwnProperty.call(updates ?? {}, 'agent_settings')
      ? validateGroupAgentSettingsInput(updates.agent_settings)
      : null
    if (agentSettingsError) {
      return json({ error: agentSettingsError }, { status: 400 })
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

// DELETE /api/groups/[id] - Delete a group, and its avatar pictures (BL-140, 2026-09-25).
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

    // BL-140: batshit-server deletes the Group's avatar pictures, so make sure it can BEFORE
    // anything is deleted, then ask for the sweep BEFORE the record goes (the agent delete's
    // order, BL-41): when it cannot, the Group stays and a retry finishes the job. The sweep
    // lives here, not in `redis.deleteGroup`, like the agent's. An id outside the owner id rule
    // can have no picture stored for it (the upload refuses such ids), so it skips the sweep.
    try {
      await checkBatshitServerCanDeleteAvatars()
    } catch (error) {
      if (error instanceof AgentAvatarDeletionError) {
        const retryNote = error.status === 503 ? ' Try again once batshit-server is running.' : ''
        return json(
          {
            error: `${error.message} It deletes the Group's avatar pictures, so nothing was deleted: the Group is still there.${retryNote}`,
            code: error.code
          },
          { status: error.status }
        )
      }
      throw error
    }
    if (isAvatarOwnerId(params.id)) {
      try {
        await deleteOwnerAvatars(locals.user.id, {
          type: 'group',
          id: params.id,
          avatar_url: group.avatar_url
        })
      } catch (error) {
        if (error instanceof AgentAvatarDeletionError) {
          const retryNote = error.status === 503 ? ' Try again once batshit-server is running.' : ''
          return json(
            { error: `${error.message} The Group was not deleted.${retryNote}`, code: error.code },
            { status: error.status }
          )
        }
        throw error
      }
    } else {
      console.warn(
        `[groups] ${params.id} is outside the avatar owner id rule, so no avatar picture can be named for it; skipped the avatar sweep`
      )
    }

    await redis.deleteGroup(params.id)
    const clearedSessionIds = await clearDeletedGroupFromSessions(locals.user.id, params.id)
    return json({ success: true, clearedSessionIds })
  } catch (error) {
    console.error('Error deleting group:', error)
    return json({ error: 'Failed to delete group' }, { status: 500 })
  }
}
