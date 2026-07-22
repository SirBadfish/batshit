import { json, type RequestHandler } from '@sveltejs/kit'
import {
  analyzeAudio2FacePcm,
  Audio2FaceBridgeError
} from '$lib/server/services/audio2FaceBridge.server'

const MAX_PCM_BYTES = 64 * 1024 * 1024
const MIN_SAMPLE_RATE = 8_000
const MAX_SAMPLE_RATE = 96_000

function errorResponse(error: string, code: string, status: number) {
  return json(
    { error, code },
    {
      status,
      headers: { 'cache-control': 'no-store' }
    }
  )
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401)

  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'audio/l16' && contentType !== 'application/octet-stream') {
    return errorResponse(
      'Audio2Face analysis requires raw mono PCM16 audio.',
      'AUDIO2FACE_INVALID_CONTENT_TYPE',
      415
    )
  }

  const sampleRate = Number(request.headers.get('x-batshit-audio-sample-rate'))
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    return errorResponse(
      `Audio2Face sample rate must be an integer from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz.`,
      'AUDIO2FACE_INVALID_SAMPLE_RATE',
      400
    )
  }

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PCM_BYTES) {
    return errorResponse(
      'Audio2Face PCM payload exceeds the 64 MB limit.',
      'AUDIO2FACE_PAYLOAD_TOO_LARGE',
      413
    )
  }

  const buffer = await request.arrayBuffer().catch(() => null)
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength % 2 !== 0) {
    return errorResponse(
      'Audio2Face PCM payload must contain complete 16-bit samples.',
      'AUDIO2FACE_INVALID_PCM',
      400
    )
  }
  if (buffer.byteLength > MAX_PCM_BYTES) {
    return errorResponse(
      'Audio2Face PCM payload exceeds the 64 MB limit.',
      'AUDIO2FACE_PAYLOAD_TOO_LARGE',
      413
    )
  }

  try {
    const result = await analyzeAudio2FacePcm({
      pcm: new Uint8Array(buffer),
      sampleRate
    })
    return json(result, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (error instanceof Audio2FaceBridgeError) {
      console.warn(`[voice/lip-sync/audio2face] ${error.code}: ${error.message}`)
      return errorResponse(error.message, error.code, error.status)
    }
    console.error('[voice/lip-sync/audio2face] Unexpected analysis failure:', error)
    return errorResponse(
      'Audio2Face analysis failed unexpectedly.',
      'AUDIO2FACE_ANALYSIS_FAILED',
      500
    )
  }
}
