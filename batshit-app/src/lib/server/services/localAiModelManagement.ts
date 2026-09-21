/**
 * SA-124 P8: managing a local AI program's models from Batshit.
 *
 * SA-102 shipped seven programs as connect-only and deferred management as "a
 * new product surface, not a correctness fix". Josh unparked it on 2026-09-20.
 *
 * **Ask the program, never the disk (DL-124-13).** It is tempting to let a user
 * point Batshit at a models folder and list the `.gguf` files in it. Three of the
 * eight programs — llama.cpp, vLLM and SGLang — load exactly one model per
 * process, chosen by a launch flag, and expose no way to load another. Reading a
 * folder would render a library of entries Batshit cannot load. So a program is
 * manageable only where it offers an API that actually loads a model, and the
 * list always comes from that API.
 *
 * **Server-side, not browser-side (DL-124-12).** The existing Ollama manager
 * (`$lib/services/ollamaModels.ts`) runs in the browser and calls the program
 * directly. These three cannot copy it: local programs may carry an API key that
 * is stored encrypted and must never reach the browser (SA-102 DL-102-09), and
 * Docker loopback rewriting lives server-side.
 *
 * Every contract below was measured against a running program on 2026-09-20, not
 * read from documentation. Details and evidence live in SA-124.
 */

import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import type { LocalAiServerId, LocalAiServerSummary } from '$lib/types/localAi'
import { listLocalAiServers, resolveLocalAiRuntimeBaseUrl } from './localAiServers'
import { readLocalProgramApiKey } from './localProgramApiKeys'
import { logger } from '$lib/utils/logger'

export type ManagedLocalModel = {
  /** The id handed back to load/unload. Opaque; shapes differ per program. */
  id: string
  label: string
  loaded: boolean
  sizeBytes?: number | null
  contextLength?: number | null
  format?: string | null
  path?: string | null
}

export type LocalAiManagementState = {
  programId: LocalAiServerId
  label: string
  /** Whether Batshit can manage models on this program right now. */
  manageable: boolean
  /**
   * Plain-English reason when `manageable` is false. Shown to the user, so it
   * names the program and the exact thing to do — never "runtime", never a
   * bare error code.
   */
  reason?: string
  canLoad: boolean
  canUnload: boolean
  canDownload: boolean
  /**
   * KoboldCpp restarts its whole server to switch models. Measured at 4.1 s of
   * downtime. The UI must expect the connection to drop and wait for it rather
   * than reporting a failure.
   */
  restartsOnSwitch: boolean
  models: ManagedLocalModel[]
}

const MANAGEABLE_PROGRAMS = ['koboldcpp', 'lmstudio', 'omlx'] as const
export type ManageableProgramId = (typeof MANAGEABLE_PROGRAMS)[number]

export function isManageableProgram(id: string | null | undefined): id is ManageableProgramId {
  return Boolean(id && (MANAGEABLE_PROGRAMS as readonly string[]).includes(id))
}

const PROBE_TIMEOUT_MS = 6_000
/** Loading a model reads gigabytes off disk; LM Studio took 24 s for 84 MB. */
const ACTION_TIMEOUT_MS = 300_000

type Ctx = {
  baseUrl: string
  apiKey: string | null
}

async function request(
  ctx: Ctx,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${ctx.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {})
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal
    })
    const text = await response.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: response.ok, status: response.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

function offline(programId: LocalAiServerId, label: string): LocalAiManagementState {
  return {
    programId,
    label,
    manageable: false,
    reason: `Batshit could not reach ${label}. Start it, then refresh.`,
    canLoad: false,
    canUnload: false,
    canDownload: false,
    restartsOnSwitch: false,
    models: []
  }
}

/**
 * KoboldCpp.
 *
 * `admin: 1` in `/api/extra/version` is the only honest capability probe:
 * `list_options` answers `[]` both when admin mode is off and when the folder is
 * empty, so the flag is what separates "you did not turn this on" from "your
 * folder has nothing in it".
 */
async function readKoboldCpp(ctx: Ctx, label: string): Promise<LocalAiManagementState> {
  const version = await request(ctx, '/api/extra/version')
  if (!version.ok) return offline('koboldcpp', label)

  if (!version.json?.admin) {
    return {
      programId: 'koboldcpp',
      label,
      manageable: false,
      reason:
        `${label} is running, but it was not started with its admin options, so it cannot ` +
        `switch models. Restart it with --admin --admindir followed by the folder your .gguf ` +
        `models are in.`,
      canLoad: false,
      canUnload: false,
      canDownload: false,
      restartsOnSwitch: true,
      models: []
    }
  }

  const listed = await request(ctx, '/api/admin/list_options')
  const entries: string[] = Array.isArray(listed.json) ? listed.json : []
  // `initial_model` and `unload_model` are KoboldCpp's own control words, not
  // files. Unload is surfaced as an action instead of a fake library entry.
  const files = entries.filter((entry) => entry !== 'initial_model' && entry !== 'unload_model')

  return {
    programId: 'koboldcpp',
    label,
    manageable: true,
    reason: files.length
      ? undefined
      : `${label}'s admin folder has no model files in it yet.`,
    canLoad: true,
    canUnload: entries.includes('unload_model'),
    canDownload: false,
    restartsOnSwitch: true,
    models: files.map((file) => ({
      id: file,
      label: file.replace(/\.(gguf|kcpps|kcppt)$/i, ''),
      // KoboldCpp serves one model and does not say which folder entry it is,
      // so "loaded" is deliberately unknown rather than guessed.
      loaded: false,
      format: file.toLowerCase().endsWith('.gguf') ? 'gguf' : 'config'
    }))
  }
}

/** LM Studio. The list key is `models`, not `data`. */
async function readLmStudio(ctx: Ctx, label: string): Promise<LocalAiManagementState> {
  const listed = await request(ctx, '/api/v1/models')
  if (!listed.ok) return offline('lmstudio', label)
  const models: any[] = Array.isArray(listed.json?.models) ? listed.json.models : []

  return {
    programId: 'lmstudio',
    label,
    manageable: true,
    reason: models.length ? undefined : `${label} has no models downloaded yet.`,
    canLoad: true,
    canUnload: true,
    // Downloads are the `lms` command-line tool's job; there is no HTTP endpoint
    // for them, so Batshit must not offer a button that cannot work.
    canDownload: false,
    restartsOnSwitch: false,
    models: models.map((model) => ({
      id: String(model?.key ?? ''),
      label: String(model?.display_name ?? model?.key ?? 'Unknown'),
      loaded: Array.isArray(model?.loaded_instances) && model.loaded_instances.length > 0,
      sizeBytes: typeof model?.size_bytes === 'number' ? model.size_bytes : null,
      contextLength:
        model?.loaded_instances?.[0]?.config?.context_length ??
        (typeof model?.max_context_length === 'number' ? model.max_context_length : null),
      format: typeof model?.format === 'string' ? model.format : null
    }))
  }
}

/** oMLX. Its admin surface can be password-protected, so 401 is its own state. */
async function readOmlx(ctx: Ctx, label: string): Promise<LocalAiManagementState> {
  const listed = await request(ctx, '/admin/api/models')
  if (listed.status === 401 || listed.status === 403) {
    return {
      programId: 'omlx',
      label,
      manageable: false,
      reason: `${label} is asking for a key before it will show its models. Add one for ${label} in Settings → Local AI.`,
      canLoad: false,
      canUnload: false,
      canDownload: false,
      restartsOnSwitch: false,
      models: []
    }
  }
  if (!listed.ok) return offline('omlx', label)
  const models: any[] = Array.isArray(listed.json?.models) ? listed.json.models : []

  return {
    programId: 'omlx',
    label,
    manageable: true,
    reason: models.length ? undefined : `${label} has no models downloaded yet.`,
    canLoad: true,
    canUnload: true,
    canDownload: true,
    restartsOnSwitch: false,
    models: models.map((model) => ({
      id: String(model?.id ?? ''),
      label: String(model?.display_name ?? model?.id ?? 'Unknown'),
      loaded: model?.loaded === true,
      path: typeof model?.model_path === 'string' ? model.model_path : null
    }))
  }
}

async function buildContext(
  userId: string,
  programId: ManageableProgramId
): Promise<{ ctx: Ctx; summary: LocalAiServerSummary } | null> {
  const servers = await listLocalAiServers(userId)
  const summary = servers.find((server) => server.id === programId)
  if (!summary) return null
  const baseUrl = resolveLocalAiRuntimeBaseUrl(summary.baseUrl) ?? summary.baseUrl
  const apiKey = await readLocalProgramApiKey(programId, userId)
  return { ctx: { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey }, summary }
}

export async function readLocalAiManagement(
  userId: string,
  programId: ManageableProgramId
): Promise<LocalAiManagementState> {
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === programId)
  const label = definition?.label ?? programId
  const built = await buildContext(userId, programId)
  if (!built) return offline(programId, label)

  if (!built.summary.enabled) {
    return {
      programId,
      label,
      manageable: false,
      reason: `${label} is switched off in Settings → Local AI. Turn it on to manage its models.`,
      canLoad: false,
      canUnload: false,
      canDownload: false,
      restartsOnSwitch: programId === 'koboldcpp',
      models: []
    }
  }

  try {
    if (programId === 'koboldcpp') return await readKoboldCpp(built.ctx, label)
    if (programId === 'lmstudio') return await readLmStudio(built.ctx, label)
    return await readOmlx(built.ctx, label)
  } catch (error) {
    logger.debug('[local-ai-manage] read failed', { programId, error })
    return offline(programId, label)
  }
}

export type ManagementActionResult = {
  success: boolean
  /** Plain-English message for the user; never a bare status code. */
  message: string
  /** True when the program restarted and callers should wait before using it. */
  restarted?: boolean
}

export async function loadLocalAiModel(
  userId: string,
  programId: ManageableProgramId,
  modelId: string
): Promise<ManagementActionResult> {
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === programId)
  const label = definition?.label ?? programId
  const built = await buildContext(userId, programId)
  if (!built) return { success: false, message: `${label} is not configured.` }
  const { ctx } = built

  if (programId === 'koboldcpp') {
    const result = await request(ctx, '/api/admin/reload_config', {
      method: 'POST',
      body: { filename: modelId },
      timeoutMs: ACTION_TIMEOUT_MS
    })
    // KoboldCpp jails the filename to its admin folder and answers
    // { success: false } for anything outside it, so a false here is a refusal,
    // not a transport error.
    const ok = result.ok && result.json?.success === true
    return {
      success: ok,
      restarted: ok,
      message: ok
        ? `${label} is switching to ${modelId}. It restarts to do this and takes a few seconds.`
        : `${label} refused to switch to ${modelId}. Check the file is still in its admin folder.`
    }
  }

  if (programId === 'lmstudio') {
    const result = await request(ctx, '/api/v1/models/load', {
      method: 'POST',
      body: { model: modelId },
      timeoutMs: ACTION_TIMEOUT_MS
    })
    const ok = result.ok && typeof result.json?.instance_id === 'string'
    const seconds = result.json?.load_time_seconds
    return {
      success: ok,
      message: ok
        ? `${label} loaded ${modelId}${typeof seconds === 'number' ? ` in ${seconds.toFixed(1)} seconds` : ''}.`
        : `${label} could not load ${modelId}. ${result.json?.error?.message ?? ''}`.trim()
    }
  }

  const result = await request(ctx, `/admin/api/models/${encodeURIComponent(modelId)}/load`, {
    method: 'POST',
    body: {},
    timeoutMs: ACTION_TIMEOUT_MS
  })
  const ok = result.ok && result.json?.status === 'ok'
  return {
    success: ok,
    message: ok ? `${label} loaded ${modelId}.` : `${label} could not load ${modelId}.`
  }
}

export async function unloadLocalAiModel(
  userId: string,
  programId: ManageableProgramId,
  modelId: string
): Promise<ManagementActionResult> {
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === programId)
  const label = definition?.label ?? programId
  const built = await buildContext(userId, programId)
  if (!built) return { success: false, message: `${label} is not configured.` }
  const { ctx } = built

  if (programId === 'koboldcpp') {
    // `unload_model` is one of KoboldCpp's own control words, sent through the
    // same endpoint as a model switch.
    const result = await request(ctx, '/api/admin/reload_config', {
      method: 'POST',
      body: { filename: 'unload_model' },
      timeoutMs: ACTION_TIMEOUT_MS
    })
    const ok = result.ok && result.json?.success === true
    return {
      success: ok,
      restarted: ok,
      message: ok ? `${label} is unloading its model.` : `${label} refused to unload.`
    }
  }

  if (programId === 'lmstudio') {
    // Unload is keyed by the INSTANCE id, not the model key. They happen to
    // match on a single-instance load, which is exactly the kind of coincidence
    // that hides a bug until someone loads the same model twice.
    const result = await request(ctx, '/api/v1/models/unload', {
      method: 'POST',
      body: { instance_id: modelId },
      timeoutMs: ACTION_TIMEOUT_MS
    })
    const ok = result.ok && typeof result.json?.instance_id === 'string'
    return {
      success: ok,
      message: ok ? `${label} unloaded ${modelId}.` : `${label} could not unload ${modelId}.`
    }
  }

  const result = await request(ctx, `/admin/api/models/${encodeURIComponent(modelId)}/unload`, {
    method: 'POST',
    body: {},
    timeoutMs: ACTION_TIMEOUT_MS
  })
  const ok = result.ok && result.json?.status === 'ok'
  return {
    success: ok,
    message: ok ? `${label} unloaded ${modelId}.` : `${label} could not unload ${modelId}.`
  }
}
