import { error, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { injectArtifactApi } from '$lib/artifacts/generateArtifactApi'
import { getArtifactIframeSandbox } from '$lib/artifacts/artifactIframeSandbox'
import {
  createArtifactRuntimeToken,
  getArtifactRuntimeStorageSnapshot
} from '$lib/server/services/artifactRuntimeAuth'

// Artifact HTML is agent-authored and only trusted inside the sandboxed
// runtime iframe. A direct top-level navigation would run it with full app
// same-origin privileges (ambient session cookie on /api calls) — refuse it
// (G-0237). `Sec-Fetch-Dest` is sent by all current browsers; the response
// CSP `sandbox` below is the backstop for clients that omit it.
function isTopLevelDocumentNavigation(request: Request): boolean {
  const dest = (request.headers.get('sec-fetch-dest') || '').toLowerCase()
  return dest === 'document' || dest === 'object' || dest === 'embed'
}

// Mirrors the runtime iframe's sandbox flags as a response CSP so a directly
// fetched copy of the HTML is held to the same opaque-origin containment the
// iframe enforces. Inside the iframe the intersection of identical flag sets
// changes nothing.
function buildArtifactResponseHeaders(artifact: unknown): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': `frame-ancestors 'self'; sandbox ${getArtifactIframeSandbox(artifact)};`
  }
}

export const GET: RequestHandler = async ({ params, locals, url, request }) => {
  const { id } = params
  const sessionIdParam = url.searchParams.get('sessionId')
  const activeSessionId = typeof sessionIdParam === 'string' && sessionIdParam.trim().length > 0
    ? sessionIdParam.trim()
    : null

  if (!id) {
    throw error(400, 'Artifact ID is required')
  }

  if (!locals.user?.id) {
    throw error(401, 'Authentication required')
  }

  if (isTopLevelDocumentNavigation(request)) {
    throw error(
      403,
      'Artifacts only run inside the Batshit app. Open this artifact from its workspace zone instead of navigating to its URL directly.'
    )
  }

  try {
    // First try to fetch from new artifact storage
    const artifactData = (await redis.json.get(`artifact:${id}`)) as any

    if (artifactData) {
      const owned = artifactData.user_id === locals.user.id
      const published = artifactData.mode === 'published'

      if (!owned && !published) {
        throw error(403, 'Access denied')
      }

      const artifact = {
        id: artifactData.id,
        name: artifactData.name || 'Untitled',
        type: artifactData.type || 'html',
        content: artifactData.content || '',
        webhook_url: artifactData.webhook_url,
        ai_enabled: artifactData.ai_enabled,
        custom_prompt: artifactData.custom_prompt,
        mode: artifactData.mode || 'edit'
      }

      const webhookUrl = artifact.webhook_url || null
      const runtimeToken = await createArtifactRuntimeToken({
        userId: locals.user.id,
        artifactId: artifact.id,
        sessionId: activeSessionId
      })
      const storageSnapshot = await getArtifactRuntimeStorageSnapshot(locals.user.id, artifact.id)
      const enhancedContent = injectArtifactApi(artifact.content, {
        artifactId: artifact.id,
        artifactName: artifact.name,
        webhookUrl,
        sessionId: activeSessionId,
        runtimeToken,
        storageSnapshot
      })

      return new Response(enhancedContent, {
        headers: buildArtifactResponseHeaders(artifactData)
      })
    }

    throw error(404, 'Artifact not found')
    
  } catch (err: any) {
    if (err?.status) throw err
    console.error('Error fetching artifact:', err);
    throw error(500, 'Failed to fetch artifact');
  }
};

// SA-011: Artifact API injection is now handled by $lib/artifacts/generateArtifactApi.ts
// - BATSHIT_THEME_CSS moved to generateArtifactApi.ts
// - injectbatshitAPI replaced with injectArtifactApi()
// - NDJSON consumer extracted to $lib/utils/ndjsonConsumer.ts
// - Share-to-chat API now includes version header for forward compatibility
