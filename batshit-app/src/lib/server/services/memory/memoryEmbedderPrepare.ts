/**
 * SA-104 P5 — builtin embedding-model preparation with visible progress.
 *
 * The first builtin-lane embed on a fresh instance downloads ~325MB of weights; doing
 * that inside a save call is the "slow first save" surprise P3 recorded. The Agent
 * Settings enable flow calls `startMemoryEmbedderPreparation` and polls
 * `getMemoryEmbedderPreparationStatus` until `ready`, and only then saves
 * `memory_enabled: true`. Preparation is idempotent: a second start joins the
 * in-flight run, and an already-cached model reports ready almost immediately.
 *
 * Status is process-local (module state) — fine for the single-instance app; a
 * restart simply reports idle again and the next prepare re-checks the cache.
 */

import {
  createMemoryEmbedderAsync,
  ensureBuiltinModelReady,
  type BuiltinModelProgress
} from './memoryEmbedder'
import { getMemoryConfig } from './memoryIndex'

export interface MemoryEmbedderPreparationStatus {
  state: 'idle' | 'preparing' | 'ready' | 'error'
  lane: string | null
  modelId: string | null
  /** 0-100 for the file currently downloading (transformers.js per-file progress). */
  progressPercent: number | null
  currentFile: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

let status: MemoryEmbedderPreparationStatus = {
  state: 'idle',
  lane: null,
  modelId: null,
  progressPercent: null,
  currentFile: null,
  error: null,
  startedAt: null,
  finishedAt: null
}

let inFlight: Promise<void> | null = null

export function getMemoryEmbedderPreparationStatus(): MemoryEmbedderPreparationStatus {
  return { ...status }
}

const progressCallback: BuiltinModelProgress = (progress) => {
  if (status.state !== 'preparing') return
  if (typeof progress?.file === 'string' && progress.file) {
    status.currentFile = progress.file
  }
  if (typeof progress?.progress === 'number' && Number.isFinite(progress.progress)) {
    status.progressPercent = Math.max(0, Math.min(100, Math.round(progress.progress)))
  }
}

/**
 * Starts (or joins) preparation for the CONFIGURED embedding lane. Non-builtin lanes
 * have nothing to download — they validate config construction and report ready
 * (their runtime failures stay loud at use time, per DL-104-10).
 */
export async function startMemoryEmbedderPreparation(): Promise<MemoryEmbedderPreparationStatus> {
  if (inFlight) return getMemoryEmbedderPreparationStatus()

  const config = (await getMemoryConfig()).embedding

  status = {
    state: 'preparing',
    lane: config.lane,
    modelId: config.modelId,
    progressPercent: null,
    currentFile: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  }

  inFlight = (async () => {
    try {
      if (config.lane === 'builtin') {
        await ensureBuiltinModelReady(config.modelId, progressCallback)
      } else {
        // Validates the stored config shape loudly (missing fields throw here).
        await createMemoryEmbedderAsync(config)
      }
      status = {
        ...status,
        state: 'ready',
        progressPercent: 100,
        finishedAt: new Date().toISOString()
      }
    } catch (error) {
      status = {
        ...status,
        state: 'error',
        error: error instanceof Error ? error.message : 'Embedding model preparation failed.',
        finishedAt: new Date().toISOString()
      }
    } finally {
      inFlight = null
    }
  })()

  return getMemoryEmbedderPreparationStatus()
}
