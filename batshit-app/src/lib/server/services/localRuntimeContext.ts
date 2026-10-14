/**
 * SA-102 P4 (DL-102-04) — what a local AI program is ACTUALLY running a model
 * with, as opposed to the model's ceiling.
 *
 * Batshit's `contextWindow` on a preset is never transmitted. It feeds the
 * prompt budget, the auto-compact trigger, the output reserve, and the Token
 * Panel. Programs differ: some allocate context at load time, while Ollama
 * can honor a context size on the request. Batshit must use the applicable
 * request or loaded size instead of quietly assuming the preset ceiling:
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

import { createHash } from 'node:crypto'
import type { LocalContextReading } from '$lib/types/modelCatalog'
import { resolveLocalAiRuntimeBaseUrl } from '$lib/server/services/localAiServers'
import { logger } from '$lib/utils/logger'

/** How long a reading stays fresh. A model's loaded context does not move often. */
const READING_TTL_MS = 30_000
/** A stopped program must not hold up a send. */
const PROBE_TIMEOUT_MS = 1_500

type CacheEntry = {
  checkedAt: number
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

async function fetchJson(url: string, apiKey?: string | null): Promise<any | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined })
    if (!response.ok) return null
    return await response.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function readLmStudio(baseUrl: string, apiKey?: string | null): Promise<Map<string, LocalContextReading>> {
  const readings = new Map<string, LocalContextReading>()
  const payload = await fetchJson(`${baseUrl}/api/v1/models`, apiKey)
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

async function readOllama(baseUrl: string, apiKey?: string | null): Promise<Map<string, LocalContextReading>> {
  const readings = new Map<string, LocalContextReading>()
  // `/api/ps` is the ONLY honest read of Ollama's effective context, and it
  // exists only while the model is loaded (verified live: llama3.2 at 131072).
  const payload = await fetchJson(`${baseUrl}/api/ps`, apiKey)
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
 * A reading keyed here applies to every model id a request could name. Used by
 * a program that serves one model and answers every request with it.
 */
const ANY_MODEL = '*'

/**
 * The name KoboldCpp lists while no model is loaded (SA-124 P8 measured it).
 * It is a placeholder, never a model that answers.
 */
const KOBOLDCPP_NO_MODEL = 'koboldcpp/inactive'

/** What KoboldCpp says about the one model it serves. */
export interface KoboldCppServing {
  /** The size it runs that model at: what a prompt is really measured against. */
  context: LocalContextReading | null
  /**
   * BL-104: the model KoboldCpp answers EVERY request with, exactly as
   * `/v1/models` names it (`koboldcpp/<name>`), whatever `model` the request
   * sends. Measured 2026-09-22: any model value got Qwen3.5-9B. Null when that
   * is not known to be true.
   */
  servedModelId: string | null
}

/**
 * BL-101 / SA-124 P4 / BL-104: what KoboldCpp serves, from its side doors.
 *
 * `/api/extra/true_max_context_length` is the size KoboldCpp was started, or
 * last restarted, with: the number a prompt is really measured against. A
 * request cannot enlarge this allocation. A request-specific smaller buffer
 * does not change this allocated ceiling; a model switch can. One click in Batshit's model
 * manager took it from 32768 to 12288 on 2026-09-22, while the preset still
 * said 32768.
 *
 * KoboldCpp serves ONE model and answers every request with it, whatever id the
 * request names, so both readings apply to any model id. The served model is
 * the one `/v1/models` lists; the caller passes the ids it already fetched from
 * there, so this adds no request. Three cases report nothing instead of a
 * reading that may be wrong: router mode, which swaps models per request; no
 * text model loaded at all; and a version door that does not answer.
 */
export async function readKoboldCppServing(
  baseUrl: string,
  listedModelIds: readonly string[],
  apiKey?: string | null
): Promise<KoboldCppServing> {
  const [version, context] = await Promise.all([
    fetchJson(`${baseUrl}/api/extra/version`, apiKey),
    fetchJson(`${baseUrl}/api/extra/true_max_context_length`, apiKey)
  ])
  if (!version || version.router === true || version.llm === false) {
    return { context: null, servedModelId: null }
  }
  const loaded = coerceFiniteNumber(context?.value)
  const listed = listedModelIds.length === 1 ? listedModelIds[0] : null
  return {
    context:
      loaded === null || loaded <= 0
        ? null
        : {
            source: 'loaded',
            loadedContextWindow: loaded,
            maxContextWindow: null,
            remainingTtlSeconds: null
          },
    servedModelId: listed && listed !== KOBOLDCPP_NO_MODEL ? listed : null
  }
}

async function readKoboldCpp(baseUrl: string, apiKey?: string | null): Promise<Map<string, LocalContextReading>> {
  const readings = new Map<string, LocalContextReading>()
  // The send path needs only the size, which applies to any model id.
  const { context } = await readKoboldCppServing(baseUrl, [], apiKey)
  if (context) readings.set(ANY_MODEL, context)
  return readings
}

/**
 * Which programs can answer "what is this model loaded with?" at all. A program
 * that is not here reports nothing, and the UI must say so rather than guess.
 */
const CONTEXT_READERS: Record<string, (baseUrl: string, apiKey?: string | null) => Promise<Map<string, LocalContextReading>>> = {
  lmstudio: readLmStudio,
  ollama: readOllama,
  koboldcpp: readKoboldCpp
}

function pickReading(
  readings: Map<string, LocalContextReading>,
  modelId: string
): LocalContextReading | null {
  return readings.get(modelId) ?? readings.get(ANY_MODEL) ?? null
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
type LocalContextArgs = {
  providerId: string | null | undefined
  modelId: string | null | undefined
  baseUrl: string | null | undefined
  userId?: string
  apiKey?: string | null
}

export async function readLocalRuntimeContextEvidence(args: LocalContextArgs): Promise<{
  reading: LocalContextReading | null; checkedAt: number; expiresAt: number
} | null> {
  const providerId = args.providerId?.trim().toLowerCase()
  const modelId = args.modelId?.trim()
  if (!providerId || !modelId) return null

  const reader = CONTEXT_READERS[providerId]
  if (!reader) return null

  const resolvedBase = (resolveLocalAiRuntimeBaseUrl(args.baseUrl ?? undefined) ?? args.baseUrl ?? '')
    .replace(/\/+$/, '')
  if (!resolvedBase) return null

  const cacheKey = `${args.userId ?? ''}|${providerId}|${resolvedBase}|${createHash('sha256').update(args.apiKey ?? '').digest('hex')}`
  const now = Date.now()
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return { reading: pickReading(cached.readings, modelId), checkedAt: cached.checkedAt, expiresAt: cached.expiresAt }
  }

  let readings: Map<string, LocalContextReading>
  try {
    readings = await reader(resolvedBase, args.apiKey)
  } catch (error) {
    logger.debug('[local-context] probe failed', { providerId, error })
    return null
  }

  const checkedAt = Date.now()
  const entry = { checkedAt, expiresAt: checkedAt + READING_TTL_MS, readings }
  cache.set(cacheKey, entry)
  return { reading: pickReading(readings, modelId), checkedAt, expiresAt: entry.expiresAt }
}

export async function readLocalRuntimeContext(args: LocalContextArgs): Promise<LocalContextReading | null> {
  return (await readLocalRuntimeContextEvidence(args))?.reading ?? null
}

/**
 * The number Batshit should budget against, and whether it disagrees with the
 * preset.
 *
 * A reported or explicitly requested allocation bounds the prompt budget.
 * A smaller positive preset is also a planning cap, without changing that
 * allocation. A supported reader that cannot report keeps the limit unknown;
 * programs without a reader can use a clearly labelled preset estimate.
 */
export function resolveEffectiveContextLimit(args: {
  presetContextWindow: number | null | undefined
  reading: LocalContextReading | null
  /**
   * SA-125 (DL-125-03): the context size THIS request will set, when Batshit is
   * the one setting it. Ollama's native `/api/chat` takes `options.num_ctx` and
   * reloads the model at that size — measured 2026-09-20, `/api/ps` went
   * 131072 -> 8192 -> 2048 -> 131072 as requests asked for it.
   *
   * That makes Batshit both the reader and the setter, and the reader is stale
   * the moment the setter disagrees: the currently loaded 131072 is about to
   * become 8192 because of this very request. Planning the prompt budget
   * against the old number would overflow the new window on the first send.
   * So a requested size outranks a loaded reading.
   */
  requestedContextWindow?: number | null
}): {
  contextLimit: number | null
  source: LocalContextReading['source'] | 'preset' | 'requested'
  presetContextWindow: number | null
  loadedContextWindow: number | null
  /** True only when both numbers are known AND differ. */
  mismatch: boolean
} {
  const planningCap = typeof args.presetContextWindow === 'number' &&
    Number.isFinite(args.presetContextWindow) && args.presetContextWindow > 0
      ? args.presetContextWindow : null
  const requested =
    typeof args.requestedContextWindow === 'number' &&
    Number.isFinite(args.requestedContextWindow) &&
    args.requestedContextWindow > 0
      ? args.requestedContextWindow
      : null
  if (requested !== null) {
    const loadedNow =
      args.reading?.source === 'loaded' &&
      typeof args.reading.loadedContextWindow === 'number'
        ? args.reading.loadedContextWindow
        : null
    return {
      contextLimit: planningCap !== null ? Math.min(planningCap, requested) : requested,
      source: 'requested',
      presetContextWindow:
        typeof args.presetContextWindow === 'number' && Number.isFinite(args.presetContextWindow)
          ? args.presetContextWindow
          : null,
      loadedContextWindow: loadedNow,
      // Not a mismatch to warn about: Batshit asked for this, and Ollama is
      // about to reload to it. Surfacing it as a conflict would be noise.
      mismatch: false
    }
  }
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
      contextLimit: planningCap !== null ? Math.min(planningCap, loaded) : loaded,
      source: 'loaded',
      presetContextWindow: preset,
      loadedContextWindow: loaded,
      mismatch: preset !== null && preset !== loaded
    }
  }

  return {
    contextLimit: args.reading?.source === 'unknown-until-loaded' ? null : preset,
    source: args.reading?.source ?? 'preset',
    presetContextWindow: preset,
    loadedContextWindow: null,
    mismatch: false
  }
}
