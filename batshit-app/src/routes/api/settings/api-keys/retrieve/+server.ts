import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'

// POST: Retrieve decrypted API key for the current user
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const userId = locals.user?.id
    if (!userId) return json({ error: 'Unauthorized' }, { status: 401 })

    const { service } = await request.json()
    if (!service) return json({ error: 'Service is required' }, { status: 400 })

    const runtimeManagedToken = service === 'batshit_token'

    if (runtimeManagedToken) {
      const runtimeToken = (env.BATSHIT_TOKEN || '').trim()
      if (!runtimeToken) {
        const runtimeName =
          env.BATSHIT_RUNTIME_OWNER === 'mac-app'
            ? 'Mac runtime'
            : env.BATSHIT_CONTAINERIZED === '1'
              ? 'Docker runtime environment'
              : 'source runtime environment'
        return json(
          {
            error: `BATSHIT_TOKEN is not configured in the ${runtimeName}.`
          },
          { status: 404 }
        )
      }

      return json({ success: true, apiKey: runtimeToken, managedByRuntime: true })
    }

    const apiKey = await apiKeyService.retrieve(service, userId)
    if (!apiKey) return json({ error: 'No key found' }, { status: 404 })

    return json({ success: true, apiKey })
  } catch (error) {
    console.error('Failed to retrieve API key:', error)
    return json({ error: 'Failed to retrieve API key' }, { status: 500 })
  }
}
