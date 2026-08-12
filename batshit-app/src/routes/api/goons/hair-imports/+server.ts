import { json, type RequestHandler } from '@sveltejs/kit'

import { HairImportJobError } from '$lib/server/services/hairImportJobRepository.server'
import { beginHairImport } from '$lib/server/services/hairImportLifecycle.server'
import { requireUser } from '$lib/server/services/routeSecurity'

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const form = await request.formData()
    const file = form.get('file')
    const calibrationFile = form.get('calibrationFile')
    const goonId = form.get('goonId')
    if (!(file instanceof File) || typeof goonId !== 'string' || !goonId.trim()) {
      return json({ error: 'Hair import requires one OBJ or GLB file and a Goon id.' }, { status: 400 })
    }
    if (/\.ahs$/i.test(file.name)) {
      return json(
        {
          error:
            'An .ahs project is calibration data, not Hair geometry. Choose the exported OBJ and optional .ahs file together.'
        },
        { status: 400 }
      )
    }
    if (calibrationFile !== null && !(calibrationFile instanceof File)) {
      return json({ error: 'Anime Hair Studio calibration must be one .ahs file.' }, { status: 400 })
    }
    if (calibrationFile instanceof File && (!/\.ahs$/i.test(calibrationFile.name) || calibrationFile.size === 0)) {
      return json({ error: 'Anime Hair Studio calibration must be one non-empty .ahs file.' }, { status: 400 })
    }
    const result = await beginHairImport({
      userId: user.value.id,
      goonId: goonId.trim(),
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      bytes: new Uint8Array(await file.arrayBuffer()),
      ...(calibrationFile instanceof File
        ? {
            calibrationFileName: calibrationFile.name,
            calibrationBytes: new Uint8Array(await calibrationFile.arrayBuffer())
          }
        : {})
    })
    return json(result, { status: 201 })
  } catch (error) {
    console.error('[hair-imports] inspection failed:', error)
    if (error instanceof HairImportJobError) {
      return json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status }
      )
    }
    return json(
      { error: error instanceof Error ? error.message : 'Hair import inspection failed.' },
      { status: 400 }
    )
  }
}
