import { error, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import { getStoredCustomIcon, renderStoredIcon } from '$lib/server/icons/iconLibrary'

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }
  if (!params.id) {
    throw error(400, 'Custom icon id is required')
  }

  const icon = await getStoredCustomIcon(locals.user.id, params.id)
  if (!icon) {
    throw error(404, 'Custom icon not found')
  }

  return renderStoredIcon(icon)
}
