import { error, json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import {
  createCustomIcon,
  IconLibraryError,
  listIconLibrary,
  updateIconLibraryPrefs
} from '$lib/server/icons/iconLibrary'

function handleIconLibraryError(err: unknown, action: string): never {
  if (err instanceof IconLibraryError) {
    throw error(err.status, err.message)
  }

  console.error(`Failed to ${action} icon library:`, err)
  throw error(500, `Failed to ${action} icon library`)
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  try {
    return json(await listIconLibrary(locals.user.id))
  } catch (err) {
    console.error('Failed to list icon library:', err)
    throw error(500, 'Failed to list icon library')
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      throw new IconLibraryError('Icon upload requires a file field')
    }

    const icon = await createCustomIcon(locals.user.id, file, {
      name: form.get('name'),
      tags: form.get('tags')
    })

    return json({ icon }, { status: 201 })
  } catch (err) {
    handleIconLibraryError(err, 'create custom icon in')
  }
}

export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  try {
    const body = await request.json()
    const prefs = await updateIconLibraryPrefs(locals.user.id, body?.prefs ?? body)
    return json({ prefs })
  } catch (err) {
    handleIconLibraryError(err, 'update prefs for')
  }
}
