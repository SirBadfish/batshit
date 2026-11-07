import { json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import {
  loadPublishedCompatibilityMatrix
} from '$lib/server/services/compatibilityMatrixAdmin'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  const published = await loadPublishedCompatibilityMatrix()

  return json({ published })
}
