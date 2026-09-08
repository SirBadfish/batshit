import { json, type RequestHandler } from '@sveltejs/kit'
import {
  DmStoreError,
  deleteDmForUser,
  getDm,
  reopenDm,
  userCloseDm
} from '$lib/server/services/dm/dmStore'

/**
 * SA-113 P4 (DL-113-10a) — one DM, for the drawer's expanded row.
 *
 * `GET` is where the body and the result text live; the list route returns neither, so a
 * drawer full of long assignments costs one subject line each until the user opens one.
 *
 * `PATCH` and `DELETE` are the USER acting, and are the reason the store has a separate
 * user-side lane: an agent may never reopen a terminal DM, and the user may.
 */

function ownedOr404(record: Awaited<ReturnType<typeof getDm>>, userId: string) {
  return record && record.userId === userId ? record : null
}

function errorStatus(error: unknown): number {
  if (error instanceof DmStoreError) return error.code === 'not_found' ? 404 : 400
  return 500
}

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const record = ownedOr404(await getDm(params.id ?? ''), locals.user.id)
  if (!record) {
    return json({ success: false, error: 'That DM was not found.' }, { status: 404 })
  }
  return json({ success: true, dm: record })
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const action = typeof body?.action === 'string' ? body.action : ''
  if (action !== 'done' && action !== 'reopen') {
    return json({ success: false, error: '"action" must be "done" or "reopen".' }, { status: 400 })
  }

  try {
    const dm =
      action === 'done'
        ? await userCloseDm(locals.user.id, params.id ?? '')
        : await reopenDm(locals.user.id, params.id ?? '')
    return json({ success: true, dm })
  } catch (error) {
    if (!(error instanceof DmStoreError)) {
      console.error('[Agent DMs] Could not update a DM:', error)
    }
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Could not update that DM.'
      },
      { status: errorStatus(error) }
    )
  }
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  try {
    await deleteDmForUser(locals.user.id, params.id ?? '')
    return json({ success: true })
  } catch (error) {
    if (!(error instanceof DmStoreError)) {
      console.error('[Agent DMs] Could not delete a DM:', error)
    }
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Could not delete that DM.'
      },
      { status: errorStatus(error) }
    )
  }
}
