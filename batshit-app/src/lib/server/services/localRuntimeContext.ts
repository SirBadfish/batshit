/**
 * SA-102 P4 (DL-102-04) — what a local AI program is ACTUALLY running a model
 * with, as opposed to the model's ceiling.
 *
 * Batshit's `contextWindow` on a preset is never transmitted. It feeds the
 * prompt budget, the auto-compact trigger, the output reserve, and the Token
 * Panel. That part is correct — context length is a load-time property
 * everywhere. The problem is that Batshit's number and the program's number can
 * differ enormously, and nothing said so:
 *
 *   - LM Studio held Josh's 27B at 208,384 under a 262,144 ceiling (live,
 *     2026-09-02). Batshit budgeted against 262,144.
 *   - Ollama picks its default from available memory and then SILENTLY drops
 *     tokens from the front of a prompt that exceeds it. No error, no warning,
 *     nothing in the response. On a 16 GiB machine that is 4k, while a preset
 *     copied from the model card might say 131k.
 *
 * Creed: no silent fallbacks. When the program will tell us, Batshit budgets
 * against the truth. When it will not — or the model is not loaded yet — that
 * is a state ("unknown until loaded"), never a quiet fall back to the ceiling.
 *
 * The readings are cached briefly because this runs on the send path. Local
 * programs answer in milliseconds over loopback, but a send should not wait on
 * a program that has just been stopped.
 */

import type { LocalContextReading } from '$lib/types/modelCatalog'
import { resolveLocalAiRuntimeBaseUrl } from '$lib/server/services/localAiServers'
import { logger } from '$lib/utils/logger'

/** How long a reading stays fresh. A model's loaded context does not move often. */
const READING_TTL_MS = 30_000
/** A stopped program must not hold up a send. */
const PROBE_TIMEOUT_MS = 1_500

type CacheEntry = {
  expiresAt: number
  readings: Map<string, LocalContextReading>
}

const cache = new Map<string, CacheEntry>()

/** Test seam: drop every cached reading. */
export function clearLocalRuntimeContextCache(): void {
  cache.clear()
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function readLmStudio(baseUrl: string): Promise<Map<string, LocalContextReading>> {
  const readings = new Map<string, LocalContextReading>()
  const payload = await fetchJson(`${baseUrl}/api/v1/models`)
  const list = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload?.data)
      ? payload.data
      : []

  for (const entry of list) {
    const id = typeof entry?.key === 'string' ? entry.key : typeof entry?.id === 'string' ? entry.id : null
    if (!id) continue
    const instance = Array.isArray(entry?.loaded_instances)
      ? entry.loaded_instances.find((candidate: any) => candidate && typeof candidate === 'object')
      : null
    const loaded = coerceFiniteNumber(instance?.config?.context_length)
    const ceiling = coerceFiniteNumber(entry?.max_context_length)

    readings.set(
      id,
      loaded !== null
        ? {
            source: 'loaded',
            loadedContextWindow: loaded,
            maxContextWindow: ceiling,
            // Absent when the model was loaded without a TTL. Optional, not
            // merely transient — verified live on a `lms load` with no --ttl.
            remainingTtlSeconds: coerceFiniteNumber(instance?.remaining_ttl_seconds)
          }
        : {
            source: 'unknown-until-loaded',
            loadedContextWindow: null,
            maxContextWindow: ceiling,
            remainingTtlSeconds: null
          }
    )
  }
  return readings
}

async function readOllama(baseUrl: string): Promise<Map<string, LocalContextReading>> {
  const readings = new Map<string, LocalContextReading>()
  // `/api/ps` is the ONLY honest read of Ollama's effective context, and it
  // exists only while the model is loaded (verified live: llama3.2 at 131072).
  const payload = await fetchJson(`${baseUrl}/api/ps`)
  const list = Array.isArray(payload?.models) ? payload.models : []
  for (const entry of list) {
    const name =
      typeof entry?.name === 'string' ? entry.name : typeof entry?.model === 'string' ? entry.model : null
    const loaded = coerceFiniteNumber(entry?.context_length)
    if (!name || loaded === null) continue
    readings.set(name, {
      source: 'loaded',
      loadedContextWindow: loaded,
      maxContextWindow: null,
      remainingTtlSeconds: null
    })
  }
  return readings
}

/**
 * Which programs can answer "what is this model loaded with?" at all. A program
 * that is not here reports nothing, and the UI must say so rather than guess.
 */
const CONTEXT_READERS: Record<string, (baseUrl: string) => Promise<Map<string, LocalContextReading>>> = {
  lmstudio: readLmStudio,
  ollama: readOllama
}

export function localRuntimeReportsLoadedContext(providerId: string | null | undefined): boolean {
  return Boolean(providerId && providerId in CONTEXT_READERS)
}

/**
 * The reading for one model, or `null` when this program cannot report at all.
 *
 * A `null` return and a `source: 'unknown-until-loaded'` reading mean different
 * things, and the difference is the whole point: the first is "this program
 * never tells us", the second is "it would, once the model is loaded".
 */
export async function readLocalRuntimeContext(args: {
  providerId: string | null | undefined
  modelId: string | null | undefined
  baseUrl: string | null | undefined
}): Promise<LocalContextReading | null> {
  const providerId = args.providerId?.trim().toLowerCase()
  const modelId = args.modelId?.trim()
  if (!providerId || !modelId) return null

  const reader = CONTEXT_READERS[providerId]
  if (!reader) return null

  const resolvedBase = (resolveLocalAiRuntimeBaseUrl(args.baseUrl ?? undefined) ?? args.baseUrl ?? '')
    .replace(/\/+$/, '')
  if (!resolvedBase) return null

  const cacheKey = `${providerId}|${resolvedBase}`
  const now = Date.now()
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.readings.get(modelId) ?? null
  }

  let readings: Map<string, LocalContextReading>
  try {
    readings = await reader(resolvedBase)
  } catch (error) {
    logger.debug('[local-context] probe failed', { providerId, error })
    return null
  }

  cache.set(cacheKey, { expiresAt: now + READING_TTL_MS, readings })
  return readings.get(modelId) ?? null
}

/**
 * The number Batshit should budget against, and whether it disagrees with the
 * preset.
 *
 * Rule: when the program reports a loaded context, that wins — including when
 * it is LARGER than the preset, because the preset is the guess. When it does
 * not report, the preset stands and `source` says why.
 */
export function resolveEffectiveContextLimit(args: {
  presetContextWindow: number | null | undefined
  reading: LocalContextReading | null
}): {
  contextLimit: number | null
  source: LocalContextReading['source'] | 'preset'
  presetContextWindow: number | null
  loadedContextWindow: number | null
  /** True only when both numbers are known AND differ. */
  mismatch: boolean
} {
  const preset =
    typeof args.presetContextWindow === 'number' && Number.isFinite(args.presetContextWindow)
      ? args.presetContextWindow
      : null
  const loaded =
    args.reading?.source === 'loaded' && typeof args.reading.loadedContextWindow === 'number'
      ? args.reading.loadedContextWindow
      : null

  if (loaded !== null) {
    return {
      contextLimit: loaded,
      source: 'loaded',
      presetContextWindow: preset,
      loadedContextWindow: loaded,
      mismatch: preset !== null && preset !== loaded
    }
  }

  return {
    contextLimit: preset,
    source: args.reading?.source ?? 'preset',
    presetContextWindow: preset,
    loadedContextWindow: null,
    mismatch: false
  }
}
