import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { sanitizeId } from '$lib/utils/idSanitizer'

// GET /api/groups - List all groups for the current user
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const groups = await redis.getGroups(locals.user.id)
    return json({ groups })
  } catch (error) {
    console.error('Error getting groups:', error)
    return json({ error: 'Failed to get groups' }, { status: 500 })
  }
}

// POST /api/groups - Create a new group
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const baseId = body.id?.trim() || sanitizeId(body.name || 'group')
    let groupId = baseId

    if (await redis.exists(`group:${groupId}`)) {
      let suffix = 2
      while (suffix < 100) {
        const candidate = `${baseId}_${suffix}`
        if (!(await redis.exists(`group:${candidate}`))) {
          groupId = candidate
          break
        }
        suffix += 1
      }

      if (groupId === baseId) {
        groupId = `${baseId}_${Date.now()}`
      }
    }

    const group = await redis.createGroup({
      ...body,
      ...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_ref')
        ? { avatar_icon_ref: normalizeOptionalIconRefInput(body.avatar_icon_ref, 'avatar_icon_ref') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_fit')
        ? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(body.avatar_icon_fit, 'avatar_icon_fit') }
        : {}),
      id: groupId,
      user_id: locals.user.id
    })

    return json(group)
  } catch (error) {
    console.error('Error creating group:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to create group' },
      { status: (error as any)?.status ?? 500 }
    )
  }
}
