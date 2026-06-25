import { error, json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import { parseOnlineIconProviders, searchOnlineIcons } from '$lib/server/icons/onlineIconProviders'

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  const query = url.searchParams.get('q') ?? ''
  if (!query.trim()) {
    return json({ icons: [] })
  }

  try {
    const icons = await searchOnlineIcons({
      query,
      providers: parseOnlineIconProviders(url.searchParams.get('providers')),
      limit: Number(url.searchParams.get('limit')) || undefined
    })
    return json({ icons })
  } catch (err) {
    console.error('Failed to search online icons:', err)
    throw error(500, 'Failed to search online icons')
  }
}
