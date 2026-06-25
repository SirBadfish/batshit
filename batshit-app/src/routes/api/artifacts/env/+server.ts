import { json, error, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { redis } from '$lib/server/redis'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  isOpaqueArtifactRuntimeRequest,
  requireArtifactRuntimeClaims,
  resolveArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'

// SA-044: Secure API key retrieval for artifact iframes
// Artifacts can request user API keys via window.batshit.env(keyName)
// Infrastructure keys are blocked to prevent leaking internal credentials

const RATE_LIMIT_WINDOW_SECONDS = 60
const MAX_REQUESTS = 30

/**
 * Infrastructure-only keys that must NEVER be exposed to artifacts.
 * These are internal tokens, URLs, and credentials used by the platform itself.
 */
const BLOCKED_KEYS = new Set([
  'batshit_token',
  'n8n_internal_key',
  'n8n_api_key',
  'n8n_api_url',
  'batshit_artifact_complete_url',
  'n8n_instance_mcp_token',
  'ai_gateway'
])

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = await request.json()
    const { artifactId, keyName } = body

    if (!artifactId || typeof artifactId !== 'string') {
      throw error(400, 'artifactId is required and must be a string')
    }

    if (!keyName || typeof keyName !== 'string') {
      throw error(400, 'keyName is required and must be a string')
    }

    const runtimeClaims = isOpaqueArtifactRuntimeRequest(request)
      ? await requireArtifactRuntimeClaims(request, artifactId)
      : await resolveArtifactRuntimeClaims(request, artifactId)
    const userId = runtimeClaims?.userId ?? locals.user?.id
    if (!userId) {
      return apiError('Unauthorized', 401)
    }

    // Rate limit: 30 requests per minute per user
    const rateLimitKey = `ratelimit:artifact-env:${userId}`
    const client = redis
    const count = await client.incr(rateLimitKey)
    if (count === 1) await client.expire(rateLimitKey, RATE_LIMIT_WINDOW_SECONDS)
    if (count > MAX_REQUESTS) {
      throw error(429, 'Rate limit exceeded')
    }

    // Normalize to lowercase for consistent matching
    const normalizedKey = keyName.trim().toLowerCase()

    const artifact = await redis.json.get(`artifact:${artifactId}`)
    if (!artifact || typeof artifact !== 'object') {
      throw error(404, 'Artifact not found')
    }

    const artifactRecord = artifact as any
    if (artifactRecord.user_id !== userId && artifactRecord.mode !== 'published') {
      throw error(403, 'Artifact access denied')
    }

    const allowedKeys = Array.isArray(artifactRecord.metadata?.allowed_env_keys)
      ? artifactRecord.metadata.allowed_env_keys
      : Array.isArray(artifactRecord.allowed_env_keys)
        ? artifactRecord.allowed_env_keys
        : []
    const normalizedAllowedKeys = new Set(
      allowedKeys
        .filter((key: unknown) => typeof key === 'string')
        .map((key: string) => key.trim().toLowerCase())
        .filter(Boolean)
    )

    if (!normalizedAllowedKeys.has(normalizedKey)) {
      throw error(403, 'Key is not allowed for this artifact')
    }

    // Block infrastructure keys
    if (BLOCKED_KEYS.has(normalizedKey)) {
      throw error(403, 'Key not accessible from artifacts')
    }

    // Retrieve the decrypted key value
    const value = await apiKeyService.retrieve(normalizedKey, userId)
    if (!value) {
      throw error(404, 'Key not found')
    }

    return json({ value })
  } catch (err: any) {
    // Re-throw SvelteKit errors (they already have status codes)
    if (err?.status) throw err
    console.error('[Artifacts/env] Failed to retrieve key:', err)
    throw error(500, 'Failed to retrieve key')
  }
}
