import { json, error, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  requireArtifactRuntimeClaims,
  updateArtifactRuntimeStorage
} from '$lib/server/services/artifactRuntimeAuth'

interface ArtifactStorageRequest {
  artifactId?: string
  operation?: 'set' | 'remove' | 'clear'
  key?: unknown
  value?: unknown
}

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as ArtifactStorageRequest
  const artifactId = typeof body.artifactId === 'string' ? body.artifactId.trim() : ''
  if (!artifactId) {
    throw error(400, 'artifactId is required')
  }

  const claims = await requireArtifactRuntimeClaims(request, artifactId)
  const artifact = await redis.json.get(`artifact:${artifactId}`)
  if (!artifact || typeof artifact !== 'object') {
    throw error(404, 'Artifact not found')
  }

  const artifactRecord = artifact as Record<string, any>
  if (artifactRecord.user_id !== claims.userId && artifactRecord.mode !== 'published') {
    throw error(403, 'Artifact access denied')
  }

  if (body.operation !== 'set' && body.operation !== 'remove' && body.operation !== 'clear') {
    throw error(400, 'Unsupported artifact storage operation')
  }

  const storage = await updateArtifactRuntimeStorage({
    userId: claims.userId,
    artifactId,
    operation: body.operation,
    key: body.key,
    value: body.value
  })

  return json({ storage })
}
