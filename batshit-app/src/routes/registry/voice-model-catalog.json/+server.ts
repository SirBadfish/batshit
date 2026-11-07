import { json, type RequestHandler } from '@sveltejs/kit'
import { upstashKvGetRaw } from '$lib/server/services/upstashKv'
import { GLOBAL_VOICE_CATALOG_KEY } from '$lib/server/services/builtinVoiceCatalogStore'
import { verifyBuiltinVoiceCatalog } from '$lib/utils/builtinVoiceCatalog'

/** Held deployment candidate: this route and its hosted allowlist stay off main until approved. */
export const GET: RequestHandler = async () => {
  try {
    const raw = await upstashKvGetRaw(GLOBAL_VOICE_CATALOG_KEY, { allowWriteTokenFallback: false, required: true, timeoutMs: 5000 })
    if (raw === null) return json({ error: 'Voice catalog has not been published.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    const snapshot = await verifyBuiltinVoiceCatalog(raw, Date.now())
    return json(snapshot, { headers: { 'Cache-Control': 'public, max-age=300' } })
  } catch {
    // Upstream bodies can contain service details. Never reflect/log them on a public route.
    console.warn('[voice registry] Catalog read unavailable')
    return json({ error: 'Voice catalog is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
