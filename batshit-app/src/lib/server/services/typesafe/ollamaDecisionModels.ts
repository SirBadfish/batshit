/**
 * SA-120 P10a (DL-120-18) — what an Ollama server says about its decision models.
 *
 * Two plain reads of Ollama's own API, nothing else: `GET /api/tags` lists the models (Ollama 0.40.3 already puts
 * each model's `capabilities` there), and `POST /api/show` answers for one model (its `capabilities`, and its
 * `parameters` text, where a `num_ctx` line is the context Ollama will give it). A model is a judge when its
 * capabilities include `decision`. No body of a chat or a judgment ever goes through here.
 *
 * Used by the Admin card's model list (`POST /api/settings/typesafe/ollama-models`) and by the fit check, which
 * believes Ollama's reported `num_ctx` over Batshit's profile (Faye, 2026-10-12: a user who raised `num_ctx` is not
 * held to our number). Server only.
 */

import { OLLAMA_DECISION_CAPABILITY } from '$lib/utils/judgeProviders'
import type { TypesafeFetch } from './typesafeClient'

const OLLAMA_READ_TIMEOUT_MS = 4_000
/** How long the fit check trusts a reported context before it asks Ollama again. */
const CONTEXT_CACHE_TTL_MS = 60_000
const MAX_LISTED_MODELS = 200

export interface OllamaDecisionModel {
  name: string
  /** Ollama's `num_ctx` for this model, when it reports one; `null` when it does not. */
  contextTokens: number | null
}

export type OllamaDecisionModelList =
  | { ok: true; models: OllamaDecisionModel[]; otherModelCount: number }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function capabilitiesOf(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.capabilities)) return null
  return value.capabilities.filter((entry): entry is string => typeof entry === 'string')
}

/** `num_ctx` from `/api/show`'s `parameters` text (`"num_ctx                        16384"`), else `null`. */
export function readOllamaNumCtx(show: unknown): number | null {
  if (!isRecord(show) || typeof show.parameters !== 'string') return null
  const match = show.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:\n|$)/)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isInteger(value) && value > 0 ? value : null
}

async function readJson(fetchImpl: TypesafeFetch, url: string, init: RequestInit): Promise<unknown> {
  // A redirect is an error, never followed: a 307/308 would re-send the body to another host (review round 1, S1).
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(OLLAMA_READ_TIMEOUT_MS) })
  if (!response.ok) {
    await response.text().catch(() => '')
    throw new Error(`Ollama answered ${response.status}`)
  }
  return response.json()
}

async function showModel(fetchImpl: TypesafeFetch, baseUrl: string, model: string): Promise<unknown> {
  return readJson(fetchImpl, `${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model })
  })
}

const defaultFetch: TypesafeFetch = (input, init) => fetch(input, init as RequestInit)

/**
 * The models on this Ollama server that report the `decision` capability. A model `/api/tags` lists without
 * capabilities (an older Ollama) is asked about through `/api/show`. A failure is a sentence, never a throw.
 */
export async function listOllamaDecisionModels(
  baseUrl: string,
  options: { fetch?: TypesafeFetch } = {}
): Promise<OllamaDecisionModelList> {
  const fetchImpl = options.fetch ?? defaultFetch
  let tags: unknown
  try {
    tags = await readJson(fetchImpl, `${baseUrl}/api/tags`, { method: 'GET', headers: { Accept: 'application/json' } })
  } catch (error) {
    return { ok: false, error: `Batshit could not read Ollama's model list at ${baseUrl} (${error instanceof Error ? error.message : 'unknown error'}).` }
  }
  if (!isRecord(tags) || !Array.isArray(tags.models)) {
    return { ok: false, error: `${baseUrl} did not answer like Ollama (no model list).` }
  }
  const models: OllamaDecisionModel[] = []
  let otherModelCount = 0
  for (const entry of tags.models.slice(0, MAX_LISTED_MODELS)) {
    if (!isRecord(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : ''
    if (!name) continue
    let capabilities = capabilitiesOf(entry)
    let show: unknown = null
    if (capabilities === null || capabilities.includes(OLLAMA_DECISION_CAPABILITY)) {
      try {
        show = await showModel(fetchImpl, baseUrl, name)
      } catch {
        show = null
      }
      capabilities = capabilities ?? capabilitiesOf(show) ?? []
    }
    if (capabilities.includes(OLLAMA_DECISION_CAPABILITY)) {
      models.push({ name, contextTokens: readOllamaNumCtx(show) })
    } else {
      otherModelCount += 1
    }
  }
  return { ok: true, models, otherModelCount }
}

const contextCache = new Map<string, { at: number; contextTokens: number | null }>()
/** One read on its way per server and model, shared by every lane that asks meanwhile (review round 1, M1). */
const inFlightReads = new Map<string, Promise<number | null>>()

/** Test seam. */
export function __resetOllamaContextCacheForTests(): void {
  contextCache.clear()
  inFlightReads.clear()
}

export type OllamaContextRead =
  | { status: 'read'; contextTokens: number | null }
  /** The caller's own budget ran out first; the shared read goes on and fills the cache for the next call. */
  | { status: 'deadline' }
  /** The caller's signal fired (Stop); same: the shared read goes on. */
  | { status: 'aborted' }

/**
 * Ollama's `num_ctx` for one model, for the fit check: cached a minute per server and model, and `null` when Ollama
 * does not say (or cannot be read), in which case the fit check uses Batshit's profile. Never throws.
 *
 * Review round 1, M1: the read runs before the judge call, so it answers to the CALLER's budget. One shared read per
 * server and model (its own ceiling, `OLLAMA_READ_TIMEOUT_MS`), and each caller waits for it only until its own
 * `deadlineMs` or `signal`: a sleeping LAN computer can never hold an in-chat send past its In-Chat Wait Limit, and
 * Stop ends the wait at once. The caller counts the time spent here against the same deadline as the judge call.
 */
export async function readOllamaContextTokens(
  baseUrl: string,
  model: string,
  options: { fetch?: TypesafeFetch; now?: () => number; deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<OllamaContextRead> {
  const now = options.now ?? Date.now
  const key = `${baseUrl}\u0000${model}`
  const cached = contextCache.get(key)
  if (cached && now() - cached.at < CONTEXT_CACHE_TTL_MS) return { status: 'read', contextTokens: cached.contextTokens }
  if (options.signal?.aborted) return { status: 'aborted' }
  if (options.deadlineMs !== undefined && options.deadlineMs <= 0) return { status: 'deadline' }

  let shared = inFlightReads.get(key)
  if (!shared) {
    shared = (async () => {
      let contextTokens: number | null = null
      try {
        contextTokens = readOllamaNumCtx(await showModel(options.fetch ?? defaultFetch, baseUrl, model))
      } catch {
        contextTokens = null
      }
      contextCache.set(key, { at: now(), contextTokens })
      return contextTokens
    })().finally(() => inFlightReads.delete(key))
    inFlightReads.set(key, shared)
  }

  const waits: Array<Promise<OllamaContextRead>> = [shared.then((contextTokens) => ({ status: 'read' as const, contextTokens }))]
  let timer: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null
  if (options.deadlineMs !== undefined) {
    waits.push(new Promise((resolve) => (timer = setTimeout(() => resolve({ status: 'deadline' }), options.deadlineMs))))
  }
  if (options.signal) {
    const signal = options.signal
    waits.push(
      new Promise((resolve) => {
        onAbort = () => resolve({ status: 'aborted' })
        signal.addEventListener('abort', onAbort, { once: true })
      })
    )
  }
  try {
    return await Promise.race(waits)
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort)
  }
}
