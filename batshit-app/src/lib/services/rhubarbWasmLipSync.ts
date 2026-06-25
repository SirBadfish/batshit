import rhubarbDataUrl from 'lip-sync-engine/dist/wasm/lip-sync-engine.data?url'
import rhubarbJsUrl from 'lip-sync-engine/dist/wasm/lip-sync-engine.js?url'
import rhubarbWasmUrl from 'lip-sync-engine/dist/wasm/lip-sync-engine.wasm?url'
import rhubarbWorkerUrl from 'lip-sync-engine/dist/worker.js?url'
import { convertRhubarbJsonToTimeline } from '$lib/goons/rhubarbTimeline'
import type { AudioLedGoonLipSyncResult } from '$lib/utils/goonLipSync'

type LipSyncEngineModule = typeof import('lip-sync-engine')
type LipSyncWorkerPool = ReturnType<LipSyncEngineModule['WorkerPool']['getInstance']>

const TARGET_SAMPLE_RATE = 16000

const RHUBARB_WASM_ASSET_URLS = {
  wasmPath: rhubarbWasmUrl,
  dataPath: rhubarbDataUrl,
  jsPath: rhubarbJsUrl
}

let workerPoolInitPromise: Promise<LipSyncWorkerPool> | null = null

function resolveSameOriginWorkerScriptUrl(assetUrl: string): string {
  if (typeof window === 'undefined') return assetUrl

  const resolved = new URL(assetUrl, window.location.href)
  if (resolved.origin === window.location.origin) {
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  }

  return resolved.href
}

function resolveRhubarbWasmAssetUrls() {
  return {
    ...RHUBARB_WASM_ASSET_URLS,
    workerScriptUrl: resolveSameOriginWorkerScriptUrl(rhubarbWorkerUrl)
  }
}

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

function resolveRhubarbWasmWorkerPool(module: LipSyncEngineModule): Promise<LipSyncWorkerPool> {
  if (!workerPoolInitPromise) {
    workerPoolInitPromise = (async () => {
      const assetUrls = resolveRhubarbWasmAssetUrls()
      const pool = module.WorkerPool.getInstance(1, assetUrls.workerScriptUrl)
      await pool.init(assetUrls)
      return pool
    })().catch((error) => {
      workerPoolInitPromise = null
      throw error
    })
  }

  return workerPoolInitPromise
}

export async function analyzeGoonLipSyncWithRhubarbWasm(options: {
  audioBuffer: ArrayBuffer
  mediaType: string
  text?: string | null
}): Promise<AudioLedGoonLipSyncResult> {
  if (typeof window === 'undefined' || typeof File === 'undefined') {
    throw new Error('Rhubarb WASM lip sync must run in the browser.')
  }

  const startedAt = performance.now()
  const module = await import('lip-sync-engine')
  const audioFile = new File(
    [options.audioBuffer.slice(0)],
    `speech.${resolveAudioExtension(options.mediaType)}`,
    { type: options.mediaType || 'application/octet-stream' }
  )

  const normalizeStartedAt = performance.now()
  const { pcm16 } = await module.loadAudio(audioFile, TARGET_SAMPLE_RATE)
  const normalizeMs = Math.round(performance.now() - normalizeStartedAt)

  const pool = await resolveRhubarbWasmWorkerPool(module)
  const analyzeStartedAt = performance.now()
  const dialogText = options.text?.trim() || undefined
  const payload = await pool.analyze(pcm16, {
    dialogText,
    sampleRate: TARGET_SAMPLE_RATE
  })
  const analyzeMs = Math.round(performance.now() - analyzeStartedAt)

  return {
    timeline: convertRhubarbJsonToTimeline(payload, dialogText ?? '', 'rhubarb-wasm'),
    metrics: {
      analyzerId: 'rhubarb-wasm',
      runtimeMode: 'precomputed',
      totalMs: Math.round(performance.now() - startedAt),
      normalizeMs,
      analyzeMs,
      notes: ['Rhubarb WASM runs in a browser worker, using Batshit-hosted WASM assets.']
    }
  }
}
