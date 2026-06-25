import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { fetchCompatibilityMatrix } from '$lib/server/services/compatibilityMatrix'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const matrix = await fetchCompatibilityMatrix()
    return json({
      data: matrix,
      success: true
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load compatibility matrix'
    return json({ error: message, success: false }, { status: 500 })
  }
}
