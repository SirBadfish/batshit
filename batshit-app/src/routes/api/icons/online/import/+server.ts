import { error, json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import { IconLibraryError } from '$lib/server/icons/iconLibrary'
import { importOnlineIcon } from '$lib/server/icons/onlineIconProviders'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  try {
    const body = await request.json()
    if (body?.provider !== 'lobe-icons' && body?.provider !== 'simple-icons') {
      throw new IconLibraryError('Unsupported online icon provider')
    }
    if (typeof body?.slug !== 'string' || !body.slug.trim()) {
      throw new IconLibraryError('Online icon import requires a provider slug')
    }

    const icon = await importOnlineIcon(locals.user.id, {
      provider: body.provider,
      slug: body.slug.trim()
    })

    return json({ icon }, { status: 201 })
  } catch (err) {
    if (err instanceof IconLibraryError) {
      throw error(err.status, err.message)
    }

    console.error('Failed to import online icon:', err)
    throw error(500, 'Failed to import online icon')
  }
}
