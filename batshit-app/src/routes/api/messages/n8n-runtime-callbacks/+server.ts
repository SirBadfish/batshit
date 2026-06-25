import { json, type RequestHandler } from '@sveltejs/kit'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  resolveRuntimeN8nBaseUrl,
  rewriteBatshitCallbackUrlsForN8nRuntime
} from '$lib/server/services/runtimeUrlRewrites'

const CALLBACK_URL_KEYS = [
  'batshit_frontend_url',
  'batshitFrontendUrl',
  'batshit_sse_endpoint',
  'batshitSseEndpoint',
  'batshit_artifact_complete_url',
  'batshitArtifactCompleteUrl'
] as const

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Callback URL payload must be an object.' }, { status: 400 })
  }

  const callbackUrls: Record<string, string> = {}
  for (const key of CALLBACK_URL_KEYS) {
    const value = (body as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) {
      callbackUrls[key] = value
    }
  }

  let savedN8nApiUrl: string | null = null
  try {
    savedN8nApiUrl = await apiKeyService.retrieve('n8n_api_url', userId)
  } catch (error) {
    console.warn('[n8n-runtime-callbacks] Failed to load saved n8n API URL:', error)
  }

  const runtimeN8nBaseUrl = resolveRuntimeN8nBaseUrl(savedN8nApiUrl)
  const rewritten = rewriteBatshitCallbackUrlsForN8nRuntime(
    callbackUrls,
    runtimeN8nBaseUrl
  )

  return json({
    callbackUrls: rewritten ?? callbackUrls
  })
}
