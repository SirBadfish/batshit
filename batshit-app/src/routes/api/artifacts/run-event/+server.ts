import { error, json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import {
  isOpaqueArtifactRuntimeRequest,
  requireArtifactRuntimeClaims,
  resolveArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { recordArtifactClientRunEvent } from '$lib/server/artifacts/artifactRunLogs'

export const POST: RequestHandler = async ({ request, locals }) => {
  const body = (await request.json()) as {
    artifactId?: string
    runId?: string
    eventType?: string
    message?: string | null
    details?: Record<string, any> | null
    userId?: string | null
  }

  const artifactId = typeof body.artifactId === 'string' ? body.artifactId.trim() : ''
  const runId = typeof body.runId === 'string' ? body.runId.trim() : ''
  const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : ''

  if (!artifactId || !runId || !eventType) {
    throw error(400, 'artifactId, runId, and eventType are required')
  }

  const runtimeClaims = isOpaqueArtifactRuntimeRequest(request)
    ? await requireArtifactRuntimeClaims(request, artifactId)
    : await resolveArtifactRuntimeClaims(request, artifactId)
  const auth = runtimeClaims
    ? { userId: runtimeClaims.userId }
    : await resolveNativeToolUser({
        request,
        localsUserId: locals.user?.id ?? null,
        claimedUserId: body.userId ?? null
      })

  const userId = auth?.userId
  if (!userId) {
    return apiError('Unauthorized', 401)
  }

  await recordArtifactClientRunEvent({
    userId,
    artifactId,
    runId,
    eventType,
    message: typeof body.message === 'string' ? body.message : null,
    details: body.details && typeof body.details === 'object' && !Array.isArray(body.details) ? body.details : null
  })

  return json({ success: true })
}
