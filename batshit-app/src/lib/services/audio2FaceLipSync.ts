import { normalizeAudio2FaceBridgeResponse } from '$lib/goons/audio2FaceTimeline'
import type { AudioLedGoonLipSyncResult } from '$lib/utils/goonLipSync'

type LipSyncEngineModule = typeof import('lip-sync-engine')

const TARGET_SAMPLE_RATE = 16_000

function resolveAudioExtension(mediaType?: string | null) {
  const normalized = mediaType?.toLowerCase() ?? ''
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3'
  if (normalized.includes('ogg')) return 'ogg'
  if (normalized.includes('wav')) return 'wav'
  if (normalized.includes('webm')) return 'webm'
  if (normalized.includes('flac')) return 'flac'
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a'
  if (normalized.includes('aac')) return 'aac'
  return 'bin'
}

function describeRouteError(payload: unknown, status: number) {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error
    const code = (payload as Record<string, unknown>).code
    if (typeof error === 'string' && error.trim()) {
      return typeof code === 'string' && code.trim() ? `${code}: ${error}` : error
    }
  }
  return `Audio2Face analysis failed with HTTP ${status}.`
}

export async function analyzeGoonLipSyncWithAudio2Face(options: {
  audioBuffer: ArrayBuffer
  mediaType: string
  text?: string | null
}): Promise<AudioLedGoonLipSyncResult> {
  if (typeof window === 'undefined' || typeof File === 'undefined') {
    throw new Error('Audio2Face lip sync audio normalization must run in the browser.')
  }

  const startedAt = performance.now()
  const module: LipSyncEngineModule = await import('lip-sync-engine')
  const audioFile = new File(
    [options.audioBuffer.slice(0)],
    `speech.${resolveAudioExtension(options.mediaType)}`,
    { type: options.mediaType || 'application/octet-stream' }
  )

  const normalizeStartedAt = performance.now()
  const { pcm16 } = await module.loadAudio(audioFile, TARGET_SAMPLE_RATE)
  const normalizeMs = Math.round(performance.now() - normalizeStartedAt)
  const pcmBytes = new Uint8Array(pcm16.byteLength)
  pcmBytes.set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength))

  const networkStartedAt = performance.now()
  const response = await fetch('/api/voice/lip-sync/audio2face', {
    method: 'POST',
    headers: {
      'content-type': 'audio/L16',
      'x-batshit-audio-sample-rate': String(TARGET_SAMPLE_RATE)
    },
    body: pcmBytes.buffer
  })
  const payload = await response.json().catch(() => null)
  const networkMs = Math.round(performance.now() - networkStartedAt)
  if (!response.ok) throw new Error(describeRouteError(payload, response.status))

  const result = normalizeAudio2FaceBridgeResponse(payload, options.text?.trim() ?? '')
  return {
    ...result,
    metrics: {
      ...result.metrics!,
      totalMs: Math.round(performance.now() - startedAt),
      normalizeMs,
      networkMs,
      analyzeMs: networkMs
    }
  }
}
