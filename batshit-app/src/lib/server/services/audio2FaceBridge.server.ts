const DEFAULT_AUDIO2FACE_BRIDGE_TIMEOUT_MS = 190_000
const MIN_AUDIO2FACE_BRIDGE_TIMEOUT_MS = 1_000
const MAX_AUDIO2FACE_BRIDGE_TIMEOUT_MS = 600_000

export class Audio2FaceBridgeError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, options: { code: string; status: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'Audio2FaceBridgeError'
    this.code = options.code
    this.status = options.status
  }
}

function resolveBridgeConfiguration() {
  const configuredUrl = process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL?.trim()
  const token = process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN?.trim()

  if (!configuredUrl || !token) {
    throw new Audio2FaceBridgeError(
      'NVIDIA Audio2Face is not configured. Configure the Docker Audio2Face bridge before selecting this analyzer.',
      { code: 'AUDIO2FACE_NOT_CONFIGURED', status: 412 }
    )
  }

  let url: URL
  try {
    url = new URL(configuredUrl)
  } catch (cause) {
    throw new Audio2FaceBridgeError('BATSHIT_AUDIO2FACE_BRIDGE_URL is not a valid URL.', {
      code: 'AUDIO2FACE_INVALID_CONFIGURATION',
      status: 500,
      cause
    })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Audio2FaceBridgeError(
      'BATSHIT_AUDIO2FACE_BRIDGE_URL must use HTTP or HTTPS.',
      { code: 'AUDIO2FACE_INVALID_CONFIGURATION', status: 500 }
    )
  }

  const configuredTimeout = Number(process.env.BATSHIT_AUDIO2FACE_BRIDGE_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(
        MAX_AUDIO2FACE_BRIDGE_TIMEOUT_MS,
        Math.max(MIN_AUDIO2FACE_BRIDGE_TIMEOUT_MS, Math.round(configuredTimeout))
      )
    : DEFAULT_AUDIO2FACE_BRIDGE_TIMEOUT_MS

  return {
    analyzeUrl: `${url.toString().replace(/\/+$/, '')}/v1/analyze`,
    token,
    timeoutMs
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBridgeError(payload: unknown, fallbackStatus: number) {
  if (!isRecord(payload)) {
    return {
      code: 'AUDIO2FACE_BRIDGE_ERROR',
      message: `Audio2Face bridge request failed with HTTP ${fallbackStatus}.`
    }
  }
  return {
    code:
      typeof payload.code === 'string' && payload.code.trim()
        ? payload.code.trim()
        : 'AUDIO2FACE_BRIDGE_ERROR',
    message:
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `Audio2Face bridge request failed with HTTP ${fallbackStatus}.`
  }
}

export async function analyzeAudio2FacePcm(options: {
  pcm: Uint8Array
  sampleRate: number
}): Promise<unknown> {
  const config = resolveBridgeConfiguration()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  const pcm = new Uint8Array(options.pcm.byteLength)
  pcm.set(options.pcm)

  try {
    const response = await fetch(config.analyzeUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'audio/L16',
        'x-batshit-audio-sample-rate': String(options.sampleRate)
      },
      body: pcm.buffer,
      signal: controller.signal
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const bridgeError = readBridgeError(payload, response.status)
      throw new Audio2FaceBridgeError(bridgeError.message, {
        code: bridgeError.code,
        status: response.status
      })
    }
    if (!isRecord(payload)) {
      throw new Audio2FaceBridgeError('Audio2Face bridge returned invalid JSON.', {
        code: 'AUDIO2FACE_INVALID_BRIDGE_RESPONSE',
        status: 502
      })
    }
    return payload
  } catch (error) {
    if (error instanceof Audio2FaceBridgeError) throw error
    if (controller.signal.aborted) {
      throw new Audio2FaceBridgeError(
        `Audio2Face analysis timed out after ${config.timeoutMs}ms.`,
        { code: 'AUDIO2FACE_TIMEOUT', status: 504, cause: error }
      )
    }
    throw new Audio2FaceBridgeError('Batshit could not reach the Audio2Face bridge.', {
      code: 'AUDIO2FACE_BRIDGE_UNAVAILABLE',
      status: 502,
      cause: error
    })
  } finally {
    clearTimeout(timeout)
  }
}
