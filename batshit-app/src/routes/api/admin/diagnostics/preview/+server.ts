import { json, type RequestHandler } from '@sveltejs/kit'

import { createDiagnosticsPreview } from '$lib/server/services/diagnosticsExportService'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    const preview = await createDiagnosticsPreview()
    return json({ ok: true, preview })
  } catch (error) {
    console.error('[diagnostics-preview] failed', error)
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to preview diagnostics'
      },
      { status: 500 }
    )
  }
}
