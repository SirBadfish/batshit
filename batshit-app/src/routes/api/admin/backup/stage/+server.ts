import { json, type RequestHandler } from '@sveltejs/kit'

import { apiError } from '$lib/server/services/apiResponses'
import {
  getInternalBatshitServerApiUrl,
  getInternalBatshitServerAuthHeaders,
  getPublicBatshitServerUrl
} from '$lib/server/services/batshitServerUrls'

function parsePositiveSafeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export const POST: RequestHandler = async ({ locals, request, fetch }) => {
  if (!locals.user) return apiError('Unauthorized', 401)
  if (!locals.user.is_admin) return apiError('Forbidden', 403)

  const body = await request.json().catch(() => null)
  const expectedBytes = parsePositiveSafeInteger(body?.bytes)
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
  if (!expectedBytes || !filename.toLowerCase().endsWith('.zip')) {
    return apiError('Choose a Batshit backup zip file.', 400)
  }

  try {
    const response = await fetch(`${getInternalBatshitServerApiUrl()}/backup-restore/stages`, {
      method: 'POST',
      headers: {
        ...getInternalBatshitServerAuthHeaders(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userId: locals.user.id,
        filename,
        expectedBytes
      })
    })
    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.stageId || !result?.ticket) {
      return apiError(result?.error || 'Could not prepare backup staging.', response.status || 502)
    }

    return json({
      stageId: result.stageId,
      ticket: result.ticket,
      expiresAt: result.expiresAt,
      uploadUrl: `${getPublicBatshitServerUrl()}/api/v1/backup-restore/stages/${result.stageId}/content`
    })
  } catch (error) {
    console.error('[backup-stage] failed', error)
    return apiError(error instanceof Error ? error.message : 'Could not prepare backup staging.', 502)
  }
}
