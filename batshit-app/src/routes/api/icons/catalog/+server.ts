import { json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import { getIconCatalogEntries } from '$lib/icons/iconCatalog'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  return json({
    icons: getIconCatalogEntries()
  })
}
