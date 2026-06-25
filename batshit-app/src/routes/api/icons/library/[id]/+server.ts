import { error, json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import { deleteCustomIcon, IconLibraryError, updateCustomIcon } from '$lib/server/icons/iconLibrary'

function handleIconLibraryError(err: unknown, action: string): never {
  if (err instanceof IconLibraryError) {
    throw error(err.status, err.message)
  }

  console.error(`Failed to ${action} custom icon:`, err)
  throw error(500, `Failed to ${action} custom icon`)
}

export const PUT: RequestHandler = async ({ request, locals, params }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }
  if (!params.id) {
    throw error(400, 'Custom icon id is required')
  }

  try {
    const body = await request.json()
    const icon = await updateCustomIcon(locals.user.id, params.id, {
      name: body?.name,
      tags: body?.tags,
      display: body?.display
    })

    return json({ icon })
  } catch (err) {
    handleIconLibraryError(err, 'update')
  }
}

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }
  if (!params.id) {
    throw error(400, 'Custom icon id is required')
  }

  try {
    await deleteCustomIcon(locals.user.id, params.id)
    return json({ ok: true })
  } catch (err) {
    handleIconLibraryError(err, 'delete')
  }
}
