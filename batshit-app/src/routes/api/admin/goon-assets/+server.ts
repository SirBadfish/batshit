import { json, type RequestHandler } from '@sveltejs/kit'
import {
  auditGoonUploadAssets,
  cleanupOrphanGoonUploadAssets
} from '$lib/server/services/goonAssetCleanupService'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    const audit = await auditGoonUploadAssets(admin.value.id)
    return json({ audit })
  } catch (error) {
    console.error('[goon-assets] audit failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to audit Goon assets' },
      { status: 500 }
    )
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    const body = await request.json().catch(() => ({}))
    if (body?.confirmDeleteOrphans !== true) {
      return json({ error: 'confirmDeleteOrphans is required' }, { status: 400 })
    }

    const cleanup = await cleanupOrphanGoonUploadAssets(admin.value.id)
    if (cleanup.failed.length > 0) {
      return json(
        {
          error: 'Some orphaned Goon assets could not be deleted',
          cleanup
        },
        { status: 500 }
      )
    }

    return json({ cleanup })
  } catch (error) {
    console.error('[goon-assets] cleanup failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to clean up Goon assets' },
      { status: 500 }
    )
  }
}
