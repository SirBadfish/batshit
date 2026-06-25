import { json, type RequestHandler } from '@sveltejs/kit'

import { createDiagnosticsBundle } from '$lib/server/services/diagnosticsExportService'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const POST: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    const bundle = await createDiagnosticsBundle()
    const body = new ArrayBuffer(bundle.bytes.byteLength)
    new Uint8Array(body).set(bundle.bytes)
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${bundle.filename}"`,
        'X-Batshit-Diagnostics-Schema': String(bundle.preview.schemaVersion)
      }
    })
  } catch (error) {
    console.error('[diagnostics-export] failed', error)
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to export diagnostics'
      },
      { status: 500 }
    )
  }
}
