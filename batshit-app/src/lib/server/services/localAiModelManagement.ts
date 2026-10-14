/**
 * SA-124 P8: managing a local AI program's models from Batshit.
 *
 * SA-102 shipped seven programs as connect-only and deferred management as "a
 * new product surface, not a correctness fix". Josh unparked it on 2026-09-20.
 *
 * **Ask the program, never the disk (DL-124-13).** It is tempting to let a user
 * point Batshit at a models folder and list the `.gguf` files in it. Three of the
 * eight programs have different lifecycle contracts. llama.cpp requires router
 * mode for model switching; vLLM and SGLang expose whole-engine operations
 * outside this model manager. Reading a folder would render entries Batshit
 * cannot reliably load. So a program is
 * manageable only where it offers an API that actually loads a model, and the
 * list always comes from that API.
 *
 * **Server-side, not browser-side (DL-124-12).** The existing Ollama manager
 * (`$lib/services/ollamaModels.ts`) runs in the browser and calls the program
 * directly. Native management cannot copy it: local programs may carry an API key that
 * is stored encrypted and must never reach the browser (SA-102 DL-102-09), and
 * Docker loopback rewriting lives server-side.
 *
 * Initial measured contracts live in SA-124. The October 4 Local AI plan
 * records current official API verification and the native capability gates.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import type { LocalAiServerId, LocalAiServerSummary } from '$lib/types/localAi'
import { listLocalAiServers, resolveLocalAiRuntimeBaseUrl, saveKoboldManagedProfileReference } from './localAiServers'
import { managedProfileHelper, managedProfileId, type RegisteredKoboldSetup } from './localAiManagedProfiles'
import { readLocalProgramApiKey } from './localProgramApiKeys'
import { clearLocalRuntimeContextCache } from './localRuntimeContext'
import { logger } from '$lib/utils/logger'

export type ManagedLocalModel = {
  /** The id handed back to load/unload. Opaque; shapes differ per program. */
  id: string
  label: string
  loaded: boolean
  busy?: boolean
  /** A live llama.cpp child whose model and KV memory have been released. */
  sleeping?: boolean
  /** Native router explicitly reports the child stopped. */
  unloaded?: boolean
  failure?: string
  sizeBytes?: number | null
  contextLength?: number | null
  format?: string | null
  path?: string | null
}

export type LocalAiManagementState = {
  programId: LocalAiServerId
  label: string
  /** Opaque saved endpoint/credential scope; action must still match this read. */
  connectionKey?: string
  /** Whether Batshit can manage models on this program right now. */
  manageable: boolean
  /** Availability is independent of enabled state and model residency. */
  availability?: 'reachable' | 'unreachable' | 'access-required'
  /**
   * Plain-English reason when `manageable` is false. Shown to the user, so it
   * names the program and the exact thing to do — never "runtime", never a
   * bare error code.
   */
  reason?: string
  canLoad: boolean
  canUnload: boolean
  /** Protected single-model KoboldCpp can unload the reported current model without a filename identity claim. */
  canUnloadCurrent?: boolean
  canDownload: boolean
  /**
   * KoboldCpp restarts its whole server to switch models. Measured at 4.1 s of
   * downtime. The UI must expect the connection to drop and wait for it rather
   * than reporting a failure.
   */
  restartsOnSwitch: boolean
  models: ManagedLocalModel[]
  /**
   * BL-101, KoboldCpp only: the admin folder's saved-settings files (`.kcpps`,
   * `.kcppt`). KoboldCpp restarts a `.gguf` loaded on its own with its DEFAULT
   * options, dropping the context size, `--jinja` and `--enableguidance` it was
   * started with. Naming one of these as the base keeps the user's settings,
   * which is what KoboldCpp's own Lite UI offers as "Base Config".
   */
  settingsFiles?: string[]
  /** BL-101, KoboldCpp only: what the program says it is running right now. */
  running?: RunningSnapshot
  /** KoboldCpp only: it can go back to the model and options it started with. */
  canRestoreStartup?: boolean
  /** Native profile application requires protected single-model admin access. */
  canApplyProfile?: boolean
  /** Protected admin never falls back to unverified profile loading. */
  requiresVerifiedProfile?: boolean
  registeredSetup?: RegisteredKoboldSetup
  managedContextActive?: boolean
  managedContextReason?: string
}

export type RunningSnapshot = {
  /** The served model's name, without KoboldCpp's `koboldcpp/` prefix. */
  model: string | null
  contextLength: number | null
  /** Started with `--jinja`. Chat template options do nothing without it. */
  chatTemplates: boolean | null
  /** Started with `--enableguidance`. Guidance strength needs it. */
  guidance: boolean | null
}

/** KoboldCpp's control words: sent through reload_config, never files. */
export const KOBOLDCPP_STARTUP_MODEL = 'initial_model'
const KOBOLDCPP_UNLOAD = 'unload_model'

export function isKoboldCppSettingsFile(entry: string): boolean {
  return /\.(kcpps|kcppt)$/i.test(entry)
}

/**
 * The name KoboldCpp serves a `.gguf` under, without its `koboldcpp/` prefix.
 *
 * koboldcpp.py 1.121: `"koboldcpp/" + sanitize_string(splitext(basename(model)))`,
 * where sanitize_string keeps only letters, digits, dots, dashes and
 * underscores. Matching a folder entry against this is KoboldCpp's own naming
 * rule, not a guess. A `.kcpps` names its model inside the file, so it cannot be
 * matched this way and stays "not known to be loaded".
 */
export function koboldCppServedName(entry: string): string {
  const base = entry.split(/[\\/]/).pop() ?? entry
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.replace(/[^\p{L}\p{N}_.-]/gu, '')
}

const MANAGEABLE_PROGRAMS = ['koboldcpp', 'lmstudio', 'omlx', 'ollama', 'llama-cpp', 'dmr', 'vllm', 'sglang'] as const
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

// Browser freshness evidence must not offer an offline verifier for a saved
// credential. This server-process secret is never persisted or sent. A restart
// invalidates every prior model list and requires a fresh read before actions.
const connectionIdentitySecret = randomBytes(32)

function connectionKey(userId: string, programId: string, ctx: Ctx): string {
  return createHmac('sha256', connectionIdentitySecret)
    .update(JSON.stringify([userId, programId, ctx.baseUrl, ctx.apiKey])).digest('hex')
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
    if (init.method === 'POST') clearLocalRuntimeContextCache()
  }
}

function offline(programId: LocalAiServerId, label: string): LocalAiManagementState {
  return {
    programId,
    label,
    manageable: false,
    availability: 'unreachable',
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
 * `admin: 1` establishes configuration capability. The native admin list must
 * also contain both control sentinels: a wrong password can return HTTP 200
 * with an empty list, while an authorized empty folder still has sentinels.
 */
async function readKoboldCpp(ctx: Ctx, label: string, deadline?: number): Promise<LocalAiManagementState> {
  const timeoutMs = () => deadline === undefined ? PROBE_TIMEOUT_MS : Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now()))
  const version = await request(ctx, '/api/extra/version', { timeoutMs: timeoutMs() })
  if (!version.ok) return offline('koboldcpp', label)
  const running = await readKoboldCppRunning(ctx, version.json, timeoutMs())

  if (!version.json?.admin) {
    return {
      programId: 'koboldcpp',
      label,
      manageable: false,
      availability: 'reachable',
      reason:
        `${label} is running, but it was not started with its admin options, so it cannot ` +
        `switch models here. Admin access is optional; enabling it requires a deliberate ` +
        `restart with an explicit model folder and appropriate admin protection.`,
      canLoad: false,
      canUnload: false,
      canDownload: false,
      restartsOnSwitch: true,
      models: [],
      running
    }
  }

  const listed = await request(ctx, '/api/admin/list_options', { timeoutMs: timeoutMs() })
  const entries: string[] = Array.isArray(listed.json) ? listed.json : []
  if (!listed.ok || (!entries.includes(KOBOLDCPP_STARTUP_MODEL) || !entries.includes(KOBOLDCPP_UNLOAD))) {
    return { ...offline('koboldcpp', label), availability: 'access-required', running,
      reason: `${label}'s admin model list is not accessible. If admin has a password, add its key in Settings → API Keys → Local AI.` }
  }
  // `initial_model` and `unload_model` are KoboldCpp's own control words, not
  // files. Unload and "back to the startup model" are actions instead of fake
  // library entries.
  const files = entries.filter(
    (entry) => entry !== KOBOLDCPP_STARTUP_MODEL && entry !== KOBOLDCPP_UNLOAD
  )

  return {
    programId: 'koboldcpp',
    label,
    manageable: true,
    reason: files.length
      ? undefined
      : `${label}'s admin folder has no model files in it yet.`,
    canLoad: true,
    canUnload: entries.includes(KOBOLDCPP_UNLOAD),
    canUnloadCurrent: version.json?.admin === 2 && version.json?.router === false && version.json?.llm === true && running.model !== null,
    canDownload: false,
    restartsOnSwitch: true,
    settingsFiles: files.filter(isKoboldCppSettingsFile),
    running,
    canRestoreStartup: entries.includes(KOBOLDCPP_STARTUP_MODEL),
    requiresVerifiedProfile: version.json?.admin === 2,
    canApplyProfile: version.json?.admin === 2 && version.json?.router === false && version.json?.llm === true && running.model !== null && validContext(running.contextLength),
    models: files.map((file) => {
      const gguf = file.toLowerCase().endsWith('.gguf')
      return {
        id: file,
        label: file.replace(/\.(gguf|kcpps|kcppt)$/i, ''),
        loaded: gguf && running.model !== null && koboldCppServedName(file) === running.model,
        format: gguf ? 'gguf' : 'config'
      }
    })
  }
}

/**
 * BL-101: what KoboldCpp is running with, from the program itself.
 *
 * Read after every switch, because a switch to a bare `.gguf` restarts it with
 * its defaults: measured 2026-09-22, context 32768 -> 12288 and `jinja` and
 * `guidance` true -> false after one click. Each read fails on its own to
 * `null`, so a slow side door never hides the model list.
 */
async function readKoboldCppRunning(ctx: Ctx, version: any, timeoutMs = PROBE_TIMEOUT_MS): Promise<RunningSnapshot> {
  const [context, served] = await Promise.all([
    request(ctx, '/api/extra/true_max_context_length', { timeoutMs }).catch(() => null),
    request(ctx, '/v1/models', { timeoutMs }).catch(() => null)
  ])
  const contextLength = Number(context?.json?.value)
  const servedId = served?.json?.data?.[0]?.id
  const model =
    typeof servedId === 'string' ? servedId.replace(/^koboldcpp\//, '').trim() : ''
  return {
    // With no model loaded KoboldCpp keeps its placeholder name, "inactive".
    model: served?.ok && model && model !== 'inactive' ? model : null,
    contextLength: context?.ok && Number.isFinite(contextLength) && contextLength > 0 ? contextLength : null,
    chatTemplates: typeof version?.jinja === 'boolean' ? version.jinja : null,
    guidance: typeof version?.guidance === 'boolean' ? version.guidance : null
  }
}

/** LM Studio. The list key is `models`, not `data`. */
async function readLmStudio(ctx: Ctx, label: string): Promise<LocalAiManagementState> {
  const listed = await request(ctx, '/api/v1/models')
  if (!listed.ok || !Array.isArray(listed.json?.models)) return { ...offline('lmstudio', label),
    reason: `${label}'s native v1 model list is unavailable. Model controls require a compatible native API (LM Studio 0.4 or newer).` }
  const models: any[] = Array.isArray(listed.json?.models) ? listed.json.models : []

  return {
    programId: 'lmstudio',
    label,
    manageable: true,
    reason: models.length ? undefined : `${label} has no models downloaded yet.`,
    canLoad: true,
    canUnload: true,
    // Native download exists in newer versions, but this manager owns load/unload only.
    canDownload: false,
    restartsOnSwitch: false,
    models: models.flatMap((model) => {
      const instances: any[] = Array.isArray(model?.loaded_instances) ? model.loaded_instances : []
      const row = {
        label: String(model?.display_name ?? model?.key ?? 'Unknown'),
        sizeBytes: typeof model?.size_bytes === 'number' ? model.size_bytes : null,
        format: typeof model?.format === 'string' ? model.format : null
      }
      return instances.length ? instances.map((instance) => ({
        ...row, id: String(instance.id ?? instance.instance_id ?? ''), loaded: true,
        label: instances.length > 1 ? `${row.label} (${instance.id ?? instance.instance_id})` : row.label,
        contextLength: instance.config?.context_length ?? null
      })).filter((entry) => entry.id) : [{ ...row, id: String(model?.key ?? ''), loaded: false, contextLength: null }]
    })
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
      availability: 'access-required',
      reason: `${label}'s admin API is not accessible to Batshit. An inference API key does not grant admin model-list or unload access. Use ${label}'s own app to manage models.`,
      canLoad: false,
      canUnload: false,
      canDownload: false,
      restartsOnSwitch: false,
      models: []
    }
  }
  if (!listed.ok || !Array.isArray(listed.json?.models)) return offline('omlx', label)
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
      busy: model?.is_loading === true,
      id: String(model?.id ?? ''),
      label: String(model?.display_name ?? model?.id ?? 'Unknown'),
      loaded: model?.loaded === true,
      path: typeof model?.model_path === 'string' ? model.model_path : null
    }))
  }
}

async function readOllama(ctx: Ctx, label: string): Promise<LocalAiManagementState> {
  const [tags, ps] = await Promise.all([request(ctx, '/api/tags'), request(ctx, '/api/ps')])
  if (!tags.ok || !ps.ok || !Array.isArray(tags.json?.models) || !Array.isArray(ps.json?.models)) {
    return offline('ollama', label)
  }
  return { programId: 'ollama', label, manageable: true, availability: 'reachable',
    canLoad: true, canUnload: true, canDownload: false, restartsOnSwitch: false,
    models: tags.json.models.map((model: any) => {
      const id = String(model.name ?? model.model ?? '')
      const resident = ps.json.models.find((entry: any) => (entry.name ?? entry.model) === id)
      return { id, label: id, loaded: Boolean(resident), sizeBytes: model.size,
        contextLength: resident?.context_length ?? null }
    }).filter((model: ManagedLocalModel) => model.id)
  }
}

async function readLlamaCpp(ctx: Ctx, label: string): Promise<LocalAiManagementState> {
  const props = await request(ctx, '/props')
  if (!props.ok || props.json?.role !== 'router') {
    return { ...offline('llama-cpp', label), availability: props.ok ? 'reachable' : 'unreachable',
      reason: `${label} model controls require a server that reports router mode. A single-model or unrecognized server is connect-only; start and manage its model in ${label}.` }
  }
  const listed = await request(ctx, '/models')
  if (!listed.ok || !Array.isArray(listed.json?.data)) return offline('llama-cpp', label)
  return { programId: 'llama-cpp', label, manageable: true, availability: 'reachable',
    canLoad: true, canUnload: true, canDownload: false, restartsOnSwitch: false,
    models: listed.json.data.map((model: any) => ({ id: String(model.id ?? ''),
      label: String(model.id ?? ''), loaded: model.status?.value === 'loaded',
      sleeping: model.status?.value === 'sleeping',
      unloaded: model.status?.value === 'unloaded',
      busy: ['loading', 'downloading'].includes(model.status?.value),
      failure: model.status?.failed === true ? `${label} could not start ${String(model.id ?? 'the model')}${typeof model.status?.exit_code === 'number' ? ` (exit ${model.status.exit_code})` : ''}.` : undefined }))
      .filter((model: ManagedLocalModel) => model.id) }
}

function unsupported(programId: ManageableProgramId, label: string): LocalAiManagementState {
  const reason = programId === 'dmr'
    ? `${label}'s native unload can discard its per-model runtime configuration. Use Docker's own model controls; Batshit keeps download/delete separate from model residency.`
    : `${label} loads its model when you start the server. Its memory release/resume controls affect the whole engine and can interrupt work; individual model Load/Unload is not supported here.`
  return { programId, label, manageable: false, reason, canLoad: false, canUnload: false,
    canDownload: false, restartsOnSwitch: false, models: [] }
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

/** Probe the saved connection with its encrypted key. No browser credential exposure. */
export async function readLocalAiAvailability(userId: string, programId: ManageableProgramId) {
  const built = await buildContext(userId, programId)
  if (!built) return { availability: 'unreachable' as const, message: 'This program is not configured.' }
  const connection = { baseUrl: built.summary.baseUrl, openaiPath: built.summary.openaiPath }
  if (!built.summary.enabled) return { ...connection, availability: 'unreachable' as const,
    message: 'This program is switched off.' }
  try {
    const result = await request(built.ctx, `${built.summary.openaiPath.replace(/\/+$/, '')}/models`)
    if (result.status === 401 || result.status === 403) {
      return { ...connection, availability: 'access-required' as const,
        message: 'The program requires a valid key. Check Settings → API Keys → Local AI.' }
    }
    if (!result.ok || !Array.isArray(result.json?.data)) {
      return { ...connection, availability: 'unreachable' as const,
        message: 'The saved model-list endpoint did not answer with a valid model list.' }
    }
    return { ...connection, availability: 'reachable' as const, models: result.json }
  } catch {
    return { ...connection, availability: 'unreachable' as const,
      message: 'Batshit could not reach the saved connection. Start the program and check its address.' }
  }
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

  const state = await readManagementState(built.ctx, programId, label)
  if (programId === 'koboldcpp') {
    state.managedContextActive = false
    state.managedContextReason = 'Context editing needs an explicitly enrolled same-machine Mac setup. Remote and Docker connections can apply operator-prepared saved setups.'
    if (process.env.BATSHIT_RUNTIME_OWNER === 'mac-app' && process.env.BATSHIT_CONTAINERIZED !== '1' && state.canApplyProfile) {
      try {
        const { registrations, reenrollmentRequired } = await managedProfileHelper<{ registrations: RegisteredKoboldSetup[]; reenrollmentRequired: boolean }>('list', { userId, endpoint: built.ctx.baseUrl })
        const registered = registrations[0]
        const reference = built.summary.managedProfile
        if (registered && managedProfileId(registered.generationId)) {
          state.registeredSetup = registered
          state.managedContextActive = reference?.state === 'active' && reference.registrationId === registered.registrationId
          state.managedContextReason = state.managedContextActive ? undefined : 'Enable the registered local setup before editing its context.'
        } else state.managedContextReason = reenrollmentRequired || reference?.state === 'reenrollment-required' ? 'This restored connection needs a new local enrollment before context editing can be enabled.' : 'No local model setup is enrolled. Enroll the installed GGUF and its complete nonsecret settings first.'
      } catch (error) {
        state.managedContextReason = error instanceof Error ? error.message : 'The registered local setup could not be verified.'
      }
    }
    if (built.summary.managedProfile?.state === 'active' && !state.managedContextActive) {
      state.canLoad = false
      state.canApplyProfile = false
      state.managedContextReason = `${state.managedContextReason} The active registered setup must be verified before another model/context change.`
    }
  }
  return { ...state, connectionKey: connectionKey(userId, programId, built.ctx) }
}

export async function enableKoboldManagedSetup(userId: string, registrationId: string, expectedConnectionKey: string): Promise<ManagementActionResult> {
  return withManagementOperation(userId, 'koboldcpp', async () => {
    if (!managedProfileId(registrationId)) return { success: false, message: 'Choose an enrolled local setup.' }
    const built = await buildContext(userId, 'koboldcpp')
    if (!built?.summary.enabled || connectionKey(userId, 'koboldcpp', built.ctx) !== expectedConnectionKey) return { success: false, message: 'The saved connection changed. Refresh before enabling context editing.' }
    const g = await managedProfileHelper<RegisteredKoboldSetup>('validate', { userId, endpoint: built.ctx.baseUrl, registrationId })
    if (!managedProfileId(g.generationId)) return { success: false, message: 'The enrolled setup has no verified current host generation. Re-enroll locally before enabling context editing.' }
    const current = await buildContext(userId, 'koboldcpp')
    if (!current?.summary.enabled || connectionKey(userId, 'koboldcpp', current.ctx) !== expectedConnectionKey) return { success: false, message: 'The saved connection changed during registration verification.' }
    await saveKoboldManagedProfileReference(userId, { version: 1, registrationId, state: 'active' })
    return { success: true, message: 'Registered local model and context editing is enabled.' }
  })
}

async function readManagementState(ctx: Ctx, programId: ManageableProgramId, label: string): Promise<LocalAiManagementState> {
  try {
    if (programId === 'koboldcpp') return await readKoboldCpp(ctx, label)
    if (programId === 'lmstudio') return await readLmStudio(ctx, label)
    if (programId === 'omlx') return await readOmlx(ctx, label)
    if (programId === 'ollama') return await readOllama(ctx, label)
    if (programId === 'llama-cpp') return await readLlamaCpp(ctx, label)
    return unsupported(programId, label)
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
  pending?: boolean
  /** A dispatched action may have changed the program without a verified answer. */
  outcomeUnknown?: boolean
  running?: RunningSnapshot
}

async function loadLocalAiModelUnlocked(
  userId: string,
  programId: ManageableProgramId,
  modelId: string,
  options: {
    /** KoboldCpp only: a `.kcpps` / `.kcppt` in its admin folder to start from. */
    baseConfig?: string | null
    expectedConnectionKey?: string
  } = {}
): Promise<ManagementActionResult> {
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === programId)
  const label = definition?.label ?? programId
  const built = await buildContext(userId, programId)
  if (!built) return { success: false, message: `${label} is not configured.` }
  const { ctx } = built
  if (options.expectedConnectionKey && options.expectedConnectionKey !== connectionKey(userId, programId, ctx)) {
    return { success: false, message: 'The saved connection changed. Refresh before trying again.' }
  }
  if (!built.summary.enabled) return { success: false, message: `${label} is switched off. Turn it on before managing its models.` }
  if (programId === 'koboldcpp' && built.summary.managedProfile?.state === 'active' && modelId !== KOBOLDCPP_STARTUP_MODEL) {
    return { success: false, message: 'Use the registered Model and Context Tokens fields, then Apply and Restart. A direct file load could discard the registered full setup.' }
  }
  const state = await readManagementState(ctx, programId, label)
  const current = await buildContext(userId, programId)
  if (!current?.summary.enabled || current.ctx.baseUrl !== ctx.baseUrl || current.ctx.apiKey !== ctx.apiKey) {
    return { success: false, message: 'The saved connection changed during this check. Refresh before trying again.' }
  }
  if (!state.manageable || !state.canLoad) return { success: false, message: state.reason ?? `${label} does not support load here.` }
  if (!(state.models.some((entry) => entry.id === modelId && !entry.busy) || (programId === 'koboldcpp' && modelId === KOBOLDCPP_STARTUP_MODEL && state.canRestoreStartup))) {
    return { success: false, message: `${label} no longer lists that model for this action. Refresh and choose again.` }
  }
  if (state.models.find((entry) => entry.id === modelId)?.sleeping) {
    return { success: false, message: `${label} has released this model's memory while sleeping. A new chat request wakes it automatically; Load cannot wake the existing child.` }
  }
  if (programId === 'koboldcpp' && state.requiresVerifiedProfile && isKoboldCppSettingsFile(modelId)) {
    return { success: false, message: 'Use Apply saved settings and restart model with expected model/context to verify this profile.' }
  }
  clearLocalRuntimeContextCache()
  if (programId === 'ollama') {
    const result = await request(ctx, '/api/generate', { method: 'POST',
      body: { model: modelId, keep_alive: -1, stream: false }, timeoutMs: ACTION_TIMEOUT_MS })
    const ok = result.ok && result.json?.done === true
    return { success: ok, message: ok ? `${label} loaded ${modelId}.` : `${label} could not load ${modelId}.` }
  }
  if (programId === 'llama-cpp') {
    const result = await request(ctx, '/models/load', { method: 'POST',
      body: { model: modelId }, timeoutMs: ACTION_TIMEOUT_MS })
    const ok = result.ok && result.json?.success === true
    return { success: ok, pending: ok, message: ok ? `${label} is loading ${modelId}.` : `${label} could not load ${modelId}.` }
  }

  if (programId === 'koboldcpp') {
    const startup = modelId === KOBOLDCPP_STARTUP_MODEL
    const baseConfig = startup ? null : options.baseConfig?.trim() || null
    if (baseConfig) {
      // BL-101: KoboldCpp IGNORES a base config it cannot find, switches anyway
      // with its defaults, and still answers success. That is the very silent
      // reset this option exists to prevent, so check the file first and refuse
      // in plain words when it is gone.
      const listed = await request(ctx, '/api/admin/list_options')
      const entries: string[] = Array.isArray(listed.json) ? listed.json : []
      if (!isKoboldCppSettingsFile(baseConfig) || !entries.includes(baseConfig)) {
        return {
          success: false,
          message: `${label} has no settings file called ${baseConfig} in its admin folder. Refresh and pick again.`
        }
      }
    }
    const dispatched = await dispatchKoboldRestart(userId, ctx,
      baseConfig ? { filename: modelId, baseconfig: baseConfig } : { filename: modelId })
    if (dispatched.failure) return dispatched.failure
    const result = dispatched.answer
    // KoboldCpp jails the filename to its admin folder and answers
    // { success: false } for anything outside it, so a false here is a refusal,
    // not a transport error.
    const ok = result.ok && result.json?.success === true
    const restarting = 'It restarts to do this and takes a few seconds.'
    return {
      success: ok,
      restarted: ok,
      message: !ok
        ? startup
          ? `${label} refused to go back to its startup model.`
          : `${label} refused to switch to ${modelId}. Check the file is still in its admin folder.`
        : startup
          ? `${label} is going back to the model and settings it was started with. ${restarting}`
          : baseConfig
            ? `${label} is switching to ${modelId} with the settings in ${baseConfig}. ${restarting}`
            : `${label} is switching to ${modelId} without a settings file. ${restarting}`
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

async function unloadLocalAiModelUnlocked(
  userId: string,
  programId: ManageableProgramId,
  modelId: string,
  expectedConnectionKey?: string
): Promise<ManagementActionResult> {
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === programId)
  const label = definition?.label ?? programId
  const built = await buildContext(userId, programId)
  if (!built) return { success: false, message: `${label} is not configured.` }
  const { ctx } = built
  if (expectedConnectionKey && expectedConnectionKey !== connectionKey(userId, programId, ctx)) {
    return { success: false, message: 'The saved connection changed. Refresh before trying again.' }
  }
  if (!built.summary.enabled) return { success: false, message: `${label} is switched off. Turn it on before managing its models.` }
  const state = await readManagementState(ctx, programId, label)
  const current = await buildContext(userId, programId)
  if (!current?.summary.enabled || current.ctx.baseUrl !== ctx.baseUrl || current.ctx.apiKey !== ctx.apiKey) {
    return { success: false, message: 'The saved connection changed during this check. Refresh before trying again.' }
  }
  if (!state.manageable || !state.canUnload) return { success: false, message: state.reason ?? `${label} does not support unload here.` }
  const currentKobold = programId === 'koboldcpp' && modelId === KOBOLDCPP_UNLOAD && state.canUnloadCurrent
  if (!currentKobold && !(state.models.some((entry) => entry.id === modelId && (entry.loaded || entry.sleeping)))) {
    return { success: false, message: `${label} no longer lists that model for this action. Refresh and choose again.` }
  }
  clearLocalRuntimeContextCache()
  if (programId === 'ollama') {
    const result = await request(ctx, '/api/generate', { method: 'POST',
      body: { model: modelId, keep_alive: 0, stream: false }, timeoutMs: ACTION_TIMEOUT_MS })
    const ok = result.ok && result.json?.done === true
    return { success: ok, message: ok ? `${label} unloaded ${modelId}.` : `${label} could not unload ${modelId}.` }
  }
  if (programId === 'llama-cpp') {
    const result = await request(ctx, '/models/unload', { method: 'POST',
      body: { model: modelId }, timeoutMs: ACTION_TIMEOUT_MS })
    const ok = result.ok && result.json?.success === true
    return { success: ok, pending: ok, message: ok ? `${label} is unloading ${modelId}.` : `${label} could not unload ${modelId}.` }
  }

  if (programId === 'koboldcpp') {
    // `unload_model` is one of KoboldCpp's own control words, sent through the
    // same endpoint as a model switch.
    const dispatched = await dispatchKoboldRestart(userId, ctx, { filename: KOBOLDCPP_UNLOAD })
    if (dispatched.failure) return dispatched.failure
    const result = dispatched.answer
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
  const pending = result.status === 202 && result.json?.status === 'unloading'
  const ok = result.ok && (result.json?.status === 'ok' || pending)
  return {
    success: ok, pending,
    message: pending ? `${label} is unloading ${modelId} and may interrupt its active requests.`
      : ok ? `${label} unloaded ${modelId}.` : `${label} could not unload ${modelId}.`
  }
}


// Coordinates management only. It neither holds inference nor locks external
// clients, and deliberately creates no saved state or Redis key.
const koboldManagementOperations = new Set<string>()
// An HTTP acknowledgement queues a native restart; it does not complete it.
// Retain uncertain/pending actions until a read proves the old child replaced.
const pendingKoboldRestarts = new Map<string, {
  connectionKey: string
  before: NonNullable<Awaited<ReturnType<typeof koboldPerf>>>
}>()
function koboldSlot(userId: string) { return JSON.stringify([userId, 'koboldcpp']) }
function provesKoboldRestart(before: NonNullable<Awaited<ReturnType<typeof koboldPerf>>>, after: Awaited<ReturnType<typeof koboldPerf>>) {
  return Boolean(after && after.idle === 1 && after.queue === 0 &&
    after.startedAt - after.uptime * 1000 > before.finishedAt - before.uptime * 1000 + 100)
}
async function resolvePendingKoboldRestart(userId: string): Promise<boolean> {
  const slot = koboldSlot(userId)
  const pending = pendingKoboldRestarts.get(slot)
  if (!pending) return true
  try {
    const deadline = Date.now() + PROBE_TIMEOUT_MS
    const built = await withinProfileDeadline(buildContext(userId, 'koboldcpp'), deadline)
    if (!built?.summary.enabled || connectionKey(userId, 'koboldcpp', built.ctx) !== pending.connectionKey) return false
    const after = await withinProfileDeadline(koboldPerf(built.ctx), deadline)
    if (!provesKoboldRestart(pending.before, after)) return false
    const current = await withinProfileDeadline(buildContext(userId, 'koboldcpp'), deadline)
    if (!current?.summary.enabled || connectionKey(userId, 'koboldcpp', current.ctx) !== pending.connectionKey) return false
    pendingKoboldRestarts.delete(slot)
    clearLocalRuntimeContextCache()
    return true
  } catch { return false }
}
async function dispatchKoboldRestart(userId: string, ctx: Ctx, body: Record<string, string>): Promise<
  { answer: Awaited<ReturnType<typeof request>>; failure?: never } | { failure: ManagementActionResult; answer?: never }
> {
  const before = await koboldPerf(ctx).catch(() => null)
  if (!before) return { failure: { success: false, message: 'KoboldCpp cannot confirm its current process state. Refresh before another model action.' } }
  const saved = await withinProfileDeadline(buildContext(userId, 'koboldcpp'), Date.now() + PROBE_TIMEOUT_MS).catch(() => null)
  if (!saved?.summary.enabled || connectionKey(userId, 'koboldcpp', saved.ctx) !== connectionKey(userId, 'koboldcpp', ctx)) {
    return { failure: { success: false, message: 'The saved connection changed during the process check. Refresh before trying again.' } }
  }
  const slot = koboldSlot(userId)
  pendingKoboldRestarts.set(slot, { connectionKey: connectionKey(userId, 'koboldcpp', ctx), before })
  try {
    const answer = await request(ctx, '/api/admin/reload_config', { method: 'POST', body, timeoutMs: ACTION_TIMEOUT_MS })
    if (answer.ok && answer.json?.success === false) pendingKoboldRestarts.delete(slot)
    else if (!answer.ok || answer.json?.success !== true) return { failure: { success: false, outcomeUnknown: true,
      message: 'KoboldCpp did not confirm the queued restart. Check its state; another model action is blocked until replacement of the old process is confirmed.' } }
    return { answer }
  } catch {
    return { failure: { success: false, outcomeUnknown: true,
      message: 'The model action lost its answer. KoboldCpp may be restarting. Check its state; do not retry automatically.' } }
  }
}
async function withManagementOperation(
  userId: string, programId: ManageableProgramId, action: () => Promise<ManagementActionResult>
): Promise<ManagementActionResult> {
  if (programId !== 'koboldcpp') return action()
  const slot = koboldSlot(userId)
  if (koboldManagementOperations.has(slot)) {
    return { success: false, message: 'Another KoboldCpp model action is still running. Wait, then refresh its state.' }
  }
  koboldManagementOperations.add(slot)
  try {
    if (!await resolvePendingKoboldRestart(userId)) return { success: false, outcomeUnknown: true,
      message: 'A previous KoboldCpp model action is still pending or unverified. Check the original connection; another action is blocked until its old process is replaced.' }
    return await action()
  } finally { koboldManagementOperations.delete(slot) }
}

export async function loadLocalAiModel(
  userId: string, programId: ManageableProgramId, modelId: string,
  options: Parameters<typeof loadLocalAiModelUnlocked>[3] = {}
): Promise<ManagementActionResult> {
  return withManagementOperation(userId, programId, () => loadLocalAiModelUnlocked(userId, programId, modelId, options))
}
export async function unloadLocalAiModel(
  userId: string, programId: ManageableProgramId, modelId: string, expectedConnectionKey?: string
): Promise<ManagementActionResult> {
  return withManagementOperation(userId, programId, () => unloadLocalAiModelUnlocked(userId, programId, modelId, expectedConnectionKey))
}

/** Restore/deletion cannot erase custody while a dispatched restart is unresolved. */
export async function withKoboldSettingsMutation<T>(userId: string, change: () => Promise<T>): Promise<T> {
  const slot = koboldSlot(userId)
  if (koboldManagementOperations.has(slot)) throw new Error('A KoboldCpp model action is running or unresolved. The saved connection and local registration were retained. Refresh the original connection before changing saved data.')
  koboldManagementOperations.add(slot)
  try {
    if (!await resolvePendingKoboldRestart(userId)) throw new Error('A previous KoboldCpp restart remains unresolved. The connection and registration were retained.')
    return await change()
  } finally { koboldManagementOperations.delete(slot) }
}

export async function withKoboldSettingsDeletion(userId: string, remove: () => Promise<void>): Promise<void> {
  await withKoboldSettingsMutation(userId, remove)
}

export type KoboldProfileExpectation = {
  expectedConnectionKey: string
  observedModel: string
  observedContext: number
  expectedModel: string
  expectedContext: number
  quiescenceConfirmed: boolean
}

function validContext(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 256 && value <= 524288
}
function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512
}
export function validKoboldProfileExpectation(value: unknown): value is KoboldProfileExpectation {
  const v = value as Partial<KoboldProfileExpectation> | null
  return Boolean(v && /^[a-f0-9]{64}$/.test(v.expectedConnectionKey ?? '') &&
    validModel(v.observedModel) && validContext(v.observedContext) &&
    validModel(v.expectedModel) && validContext(v.expectedContext) && v.quiescenceConfirmed === true)
}

export type KoboldContextIntent = Pick<KoboldProfileExpectation, 'expectedConnectionKey' | 'observedModel' | 'observedContext' | 'quiescenceConfirmed'> & {
  registrationId: string; modelId: string; contextTokens: number
}
export function validKoboldContextIntent(value: unknown): value is KoboldContextIntent {
  const v = value as Partial<KoboldContextIntent> | null
  return Boolean(v && Object.keys(v).every(k => ['expectedConnectionKey', 'observedModel', 'observedContext', 'quiescenceConfirmed', 'registrationId', 'modelId', 'contextTokens'].includes(k)) &&
    managedProfileId(v.registrationId) && managedProfileId(v.modelId) && validContext(v.contextTokens) &&
    validKoboldProfileExpectation({ ...v, expectedModel: 'registered', expectedContext: v.contextTokens }))
}
export async function applyKoboldCppContext(userId: string, intent: KoboldContextIntent): Promise<ManagementActionResult> {
  if (!validKoboldContextIntent(intent)) return { success: false, message: 'Choose an enrolled model, enter an integer context and confirm all chats are idle.' }
  return withManagementOperation(userId, 'koboldcpp', () => applyKoboldCppProfileUnlocked(userId, '', {
    expectedConnectionKey: intent.expectedConnectionKey, observedModel: intent.observedModel, observedContext: intent.observedContext,
    expectedModel: 'registered', expectedContext: intent.contextTokens, quiescenceConfirmed: intent.quiescenceConfirmed
  }, intent))
}

async function koboldPerf(ctx: Ctx, timeoutMs = PROBE_TIMEOUT_MS) {
  const startedAt = Date.now()
  const result = await request(ctx, '/api/extra/perf', { timeoutMs })
  const finishedAt = Date.now()
  const p = result.json
  if (!result.ok || typeof p?.uptime !== 'number' || !Number.isFinite(p.uptime) || p.uptime < 0 ||
      (p?.idle !== 0 && p?.idle !== 1) || typeof p?.queue !== 'number' || !Number.isInteger(p.queue) || p.queue < 0) return null
  return { idle: p.idle, queue: p.queue, uptime: p.uptime, startedAt, finishedAt }
}

/** Keep saved-state reads as well as HTTP probes inside the verification window. */
async function withinProfileDeadline<T>(read: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Profile verification expired')), Math.max(0, deadline - Date.now()))
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Apply a native listed settings file, never a numeric context override. */
export async function applyKoboldCppProfile(
  userId: string, profile: string, expectation: KoboldProfileExpectation
): Promise<ManagementActionResult> {
  return withManagementOperation(userId, 'koboldcpp', () => applyKoboldCppProfileUnlocked(userId, profile, expectation))
}
async function applyKoboldCppProfileUnlocked(userId: string, profile: string, expectation: KoboldProfileExpectation, intent?: KoboldContextIntent): Promise<ManagementActionResult> {
    const refuse = (message: string): ManagementActionResult => ({ success: false, message })
    if ((!intent && !isKoboldCppSettingsFile(profile)) || !validKoboldProfileExpectation(expectation)) {
      return refuse('Choose a saved settings file, valid expected model/context, and confirm all KoboldCpp clients are idle.')
    }
    const built = await buildContext(userId, 'koboldcpp')
    if (!built?.summary.enabled) return refuse('KoboldCpp is switched off or not configured. Refresh its saved connection.')
    if (!intent && built.summary.managedProfile?.state === 'active') return refuse('Use the registered Model and Context Tokens fields, then Apply and Restart.')
    const { ctx } = built
    let baseConfig: string | undefined
    let registeredModel: RegisteredKoboldSetup['models'][number] | undefined
    const unchanged = async () => {
      const current = await buildContext(userId, 'koboldcpp')
      return Boolean(current?.summary.enabled && connectionKey(userId, 'koboldcpp', current.ctx) === expectation.expectedConnectionKey &&
        current.ctx.baseUrl === ctx.baseUrl && current.ctx.apiKey === ctx.apiKey)
    }
    if (connectionKey(userId, 'koboldcpp', ctx) !== expectation.expectedConnectionKey) {
      return refuse('The saved connection changed. Refresh before trying again.')
    }
    if (intent) {
      if (built.summary.managedProfile?.state !== 'active' || built.summary.managedProfile.registrationId !== intent.registrationId) return refuse('Enable this enrolled local setup before editing context.')
      const registration = await managedProfileHelper<RegisteredKoboldSetup>('validate', { userId, endpoint: ctx.baseUrl, registrationId: intent.registrationId })
      registeredModel = registration.models.find(m => m.id === intent.modelId)
      if (!registeredModel) return refuse('The selected model is no longer enrolled. Refresh its list.')
      expectation = { ...expectation, expectedModel: registeredModel.servedName }
    }
    const state = await readKoboldCpp(ctx, 'KoboldCpp')
    if (!state.manageable || !state.canApplyProfile || (intent ? !state.models.some(m => m.id === registeredModel?.nativeRef && m.format === 'gguf') || !state.settingsFiles?.includes(registeredModel!.baseConfig) : !state.settingsFiles?.includes(profile))) {
      return refuse('KoboldCpp needs protected single-model admin access and that listed settings file. Refresh its profile list.')
    }
    if (state.running?.model !== expectation.observedModel || state.running?.contextLength !== expectation.observedContext) {
      return refuse('KoboldCpp changed its loaded model or context. Refresh before applying a profile.')
    }
    const before = await koboldPerf(ctx).catch(() => null)
    if (!before || before.idle !== 1 || before.queue !== 0) {
      return refuse('KoboldCpp is busy, has queued requests, or cannot confirm it is idle. Wait for all chats to finish and refresh. Leave KoboldCpp and its Terminal running.')
    }
    if (!await unchanged()) return refuse('The saved connection changed during the check. Refresh before trying again.')
    // Upstream does not atomically combine the idle read with this action.
    // Deliberate user quiescence is required; external clients can still race.
    let attempted = false
    let acknowledged = false
    try {
      if (intent) {
        const prepared = await managedProfileHelper<{ artifactId: string; filename: string; baseConfig: string; expectedModel: string }>('prepare', {
          userId, endpoint: ctx.baseUrl, registrationId: intent.registrationId, modelId: intent.modelId, contextTokens: intent.contextTokens
        })
        profile = prepared.filename
        baseConfig = prepared.baseConfig
        if (!managedProfileId(prepared.artifactId) || profile !== `batshit-managed/context-${prepared.artifactId}.kcpps` || baseConfig !== registeredModel?.baseConfig || prepared.expectedModel !== expectation.expectedModel) return refuse('The prepared local setup did not match its registration. Managed files were retained; no restart was sent.')
        // Native silently ignores invalid bases. BOTH exact references must be
        // present in one fresh authorized list after publication, before dispatch.
        const fresh = await readKoboldCpp(ctx, 'KoboldCpp')
        const idle = await koboldPerf(ctx)
        if (!fresh.canApplyProfile || !fresh.settingsFiles?.includes(profile) || !fresh.settingsFiles.includes(baseConfig) ||
            fresh.running?.model !== expectation.observedModel || fresh.running?.contextLength !== expectation.observedContext ||
            !idle || idle.idle !== 1 || idle.queue !== 0 || !await unchanged()) return refuse('The local setup, running model or idle state changed after file preparation. Files were retained; no restart was sent.')
        await managedProfileHelper('verify', { userId, endpoint: ctx.baseUrl, registrationId: intent.registrationId, modelId: intent.modelId, contextTokens: intent.contextTokens, artifactId: prepared.artifactId })
        if (!await unchanged()) return refuse('The connection changed after final registration verification. No restart was sent.')
        await saveKoboldManagedProfileReference(userId, { version: 1, registrationId: intent.registrationId, state: 'active', desired: { modelId: intent.modelId, contextTokens: intent.contextTokens } })
        if (!await unchanged()) return refuse('The saved connection changed after recording the request. No restart was sent.')
      }
      attempted = true
      pendingKoboldRestarts.set(koboldSlot(userId), { connectionKey: expectation.expectedConnectionKey, before })
      const answer = await request(ctx, '/api/admin/reload_config', {
        method: 'POST', body: { filename: profile, ...(baseConfig ? { baseconfig: baseConfig } : {}) }, timeoutMs: ACTION_TIMEOUT_MS
      })
      if (!answer.ok || answer.json?.success !== true) {
        if (answer.ok && answer.json?.success === false) {
          pendingKoboldRestarts.delete(koboldSlot(userId))
          return refuse('KoboldCpp refused the saved profile. Nothing was confirmed applied.')
        }
        return { success: false, outcomeUnknown: true, message: 'KoboldCpp did not confirm the action. It may have restarted. Refresh before deciding what to do; do not retry automatically.' }
      }
      acknowledged = true
      const deadline = Date.now() + 180_000
      let actual: RunningSnapshot | undefined
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (!await withinProfileDeadline(unchanged(), deadline)) return { success: false, outcomeUnknown: true, message: 'The saved connection changed after the action. KoboldCpp may have changed; check that connection before another action.' }
        try {
          const perf = await koboldPerf(ctx, Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())))
          // Compare conservative birth-time intervals, not a blind delay or
          // same-model answer from the old child. Missing evidence stays unknown.
          const restarted = provesKoboldRestart(before, perf)
          if (!restarted) continue
          const current = await withinProfileDeadline(readKoboldCpp(ctx, 'KoboldCpp', deadline), deadline)
          if (Date.now() >= deadline) break
          actual = current.running
          if (!current.canApplyProfile || !actual?.model || !actual.contextLength) continue
          if (!await withinProfileDeadline(unchanged(), deadline)) return { success: false, outcomeUnknown: true, running: actual, message: 'The saved connection changed before verification. Check the program before another action.' }
          pendingKoboldRestarts.delete(koboldSlot(userId))
          if (actual.model !== expectation.expectedModel || actual.contextLength !== expectation.expectedContext) {
            return { success: false, restarted: true, running: actual, message: `KoboldCpp restarted, but is serving ${actual.model} at ${actual.contextLength.toLocaleString()} tokens. The expected model/context was not applied. Batshit made no automatic retry or rollback.` }
          }
          return { success: false, outcomeUnknown: true, restarted: true, running: actual, message: `KoboldCpp restarted and its served model/context match: ${actual.model} at ${actual.contextLength.toLocaleString()} tokens. Its API cannot confirm whether the selected settings file succeeded or startup settings recovered. Profile application remains unverified. Batshit made no automatic retry or rollback.` }
        } catch {
          // Native downtime, slow loading and failed reads cannot prove success.
        }
      }
      return { success: false, outcomeUnknown: true, running: actual, message: 'KoboldCpp has not confirmed the restart and expected model/context within three minutes. Check its state before another action. Batshit made no automatic retry or rollback.' }
    } catch (error) {
      if (!attempted) return refuse(`${error instanceof Error ? error.message : 'Local file preparation failed'}. No native restart was sent. Any prepared files were retained; do not retry automatically.`)
      return { success: false, outcomeUnknown: attempted, message: acknowledged ? 'KoboldCpp acknowledged the action, but verification did not finish. Its state may have changed. Check it before another action; do not retry automatically.' : 'The action lost its answer. KoboldCpp may have changed. Refresh its state before deciding what to do; do not retry automatically.' }
    } finally {
      // A concurrent read can cache the old child while native restart begins.
      clearLocalRuntimeContextCache()
    }
}
