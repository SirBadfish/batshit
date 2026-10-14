/**
 * SA-072 P2 (DL-04, DL-05, DL-10): runs a Pinokio app artifact on the server.
 *
 * `/api/artifacts/complete` hands a `brain_type: "pinokio_app"` artifact here instead of to a
 * model. Batshit talks to the app's OWN HTTP API (DL-04), following the recipe saved in
 * `metadata.pinokio_runtime`, so one path serves the artifact's panel (`window.batshit.complete`)
 * and agents (`use.artifact.{slug}`, unchanged, DL-05):
 *
 * - `comfyui`: fill the saved API-format workflow from the field values, `POST /prompt`, poll
 *   `/history/<id>`, and return every saved image as a generated file.
 * - `gradio`: `POST <api prefix>/call/<api_name>` with the positional arguments (files uploaded
 *   to the app first), read the event stream to `complete`, and return text and image files.
 * - `custom`: one JSON `POST` of the field values to a path on the app.
 *
 * The app's address is resolved on every run (DL-10). An app that is not running is a typed
 * `app_offline` failure whose words tell an agent to ask for `sys.pinokio.run` (the user's
 * Approve click) and the panel to show "Start with Pinokio"; nothing here starts anything.
 */

import {
  forgetPinokioAppEndpoint,
  pinokioEndpointAgentMessage,
  resolvePinokioAppEndpoint,
  type PinokioAppEndpoint,
  type PinokioAppEndpointCode
} from './pinokioAppEndpoint'
import { detectPromptShape } from '$lib/server/artifacts/comfyuiProxyRules'
import { getInternalBatshitServerUrl, getPublicBatshitServerUrl } from './batshitServerUrls'
import { loadClipRow } from './clipService'
import { resolveClipDataUrlFromStoredUpload } from './clipUploadPayload'
import {
  PINOKIO_ARTIFACT_KIND_LABELS,
  PINOKIO_CLIP_ID_PATTERN,
  pinokioArtifactProblems,
  type PinokioArtifactBinding,
  type PinokioComfyInputBinding,
  type PinokioComfyRecipe,
  type PinokioGradioRecipe
} from '$lib/artifacts/pinokioArtifact'

/** A generous ceiling, not a generation timeout: long ComfyUI workflows are normal. */
const RUN_CEILING_MS = 30 * 60_000
const COMFY_POLL_MS = 1_000
const REQUEST_TIMEOUT_MS = 60_000
const MAX_OUTPUT_FILES = 8
const MAX_OUTPUT_FILE_BYTES = 25 * 1024 * 1024
const MAX_INPUT_FILE_BYTES = 25 * 1024 * 1024
const ERROR_BODY_CHARS = 600

export type PinokioRunErrorCode =
  | PinokioAppEndpointCode
  | 'recipe_invalid'
  | 'input_invalid'
  | 'app_error'
  | 'app_unreachable'
  | 'no_output'
  | 'timed_out'

export class PinokioAppRunError extends Error {
  readonly code: PinokioRunErrorCode
  readonly details: Record<string, unknown>
  constructor(code: PinokioRunErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PinokioAppRunError'
    this.code = code
    this.details = details
  }
}

export interface PinokioRunFile {
  /** A `data:` URL, the shape every artifact `file` event carries. */
  base64: string
  mediaType: string
  metadata: Record<string, unknown>
}

export interface PinokioRunEmitter {
  chunk(text: string): Promise<void>
  file(file: PinokioRunFile, index: number): Promise<void>
}

export interface PinokioRunInput {
  artifactId: string
  binding: PinokioArtifactBinding
  metadata: Record<string, unknown>
  /** Field values: the agent's `fields`, or the panel's `context` object. */
  values: Record<string, unknown>
  /** The user the run is for (the artifact's owner); a file field's Clip id is read from their Clips. */
  userId?: string
  signal?: AbortSignal
}

export interface PinokioRunResult {
  text: string
  fileCount: number
  metadata: Record<string, unknown>
}

export interface PinokioRunnerDeps {
  fetch: typeof fetch
  resolveEndpoint(appId: string): Promise<PinokioAppEndpoint>
  sleep(ms: number): Promise<void>
  now(): number
  randomSeed(): number
  /** The batshit-server origins whose `/uploads/` URLs (Clips) the runner may read. */
  batshitUploadOrigins(): string[]
  /** A user's Clip as a data: URL (the same reader memory images copy from), or null. */
  readClip(userId: string, clipId: string): Promise<{ dataUrl: string; filename: string | null } | null>
}

const realDeps: PinokioRunnerDeps = {
  fetch: (...args) => fetch(...args),
  resolveEndpoint: resolvePinokioAppEndpoint,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  randomSeed: () => Math.floor(Math.random() * 2 ** 32),
  batshitUploadOrigins: () => {
    const origins = new Set<string>()
    for (const raw of [getInternalBatshitServerUrl(), getPublicBatshitServerUrl()]) {
      try {
        origins.add(new URL(raw).origin)
      } catch {}
    }
    return [...origins]
  },
  readClip: async (userId, clipId) => {
    const clip = await loadClipRow(userId, clipId)
    if (!clip) return null
    const dataUrl = await resolveClipDataUrlFromStoredUpload(clip)
    return dataUrl ? { dataUrl, filename: typeof clip.filename === 'string' ? clip.filename : null } : null
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function bodyExcerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > ERROR_BODY_CHARS ? `${oneLine.slice(0, ERROR_BODY_CHARS)}…` : oneLine
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new PinokioAppRunError('timed_out', 'The run was cancelled.')
}

async function appFetch(
  deps: PinokioRunnerDeps,
  title: string,
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {}
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  try {
    return await deps.fetch(url, { ...init, signal })
  } catch (error) {
    if (init.signal?.aborted) throw new PinokioAppRunError('timed_out', 'The run was cancelled.')
    throw new PinokioAppRunError(
      'app_unreachable',
      `${title} did not answer at ${new URL(url).origin}: ${error instanceof Error ? error.message : 'unknown error'}. It may have stopped; check it with fabric:sys.pinokio.app_status.`
    )
  }
}

async function readBytes(response: Response, limit: number, what: string): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) {
    throw new PinokioAppRunError('app_error', `${what} is ${length} bytes, over the ${limit}-byte limit.`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) {
    throw new PinokioAppRunError('app_error', `${what} is ${bytes.byteLength} bytes, over the ${limit}-byte limit.`)
  }
  return bytes
}

function toDataUrl(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

/* ------------------------------------------------------------------ *
 * ComfyUI
 * ------------------------------------------------------------------ */

function coerceLike(existing: unknown, value: unknown, label: string): unknown {
  if (typeof existing === 'number') {
    const parsed = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isFinite(parsed)) throw new PinokioAppRunError('input_invalid', `${label} must be a number.`)
    return parsed
  }
  if (typeof existing === 'boolean') {
    if (typeof value === 'boolean') return value
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase())
  }
  if (typeof existing === 'string') return typeof value === 'string' ? value : JSON.stringify(value)
  return value
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

/** The workflow with the field values written in. Exported for tests. */
export function fillComfyWorkflow(
  recipe: PinokioComfyRecipe,
  values: Record<string, unknown>,
  randomSeed: () => number
): { workflow: Record<string, any>; applied: string[]; seed: number | null } {
  const workflow = structuredClone(recipe.workflow) as Record<string, any>
  const applied: string[] = []
  const written = new Set<string>()
  const key = (binding: PinokioComfyInputBinding) => `${binding.node}\u0000${binding.input}`
  for (const [fabricId, binding] of Object.entries(recipe.inputs ?? {})) {
    if (!hasValue(values[fabricId])) continue
    const node = workflow[binding.node]
    node.inputs[binding.input] = coerceLike(node.inputs[binding.input], values[fabricId], `"${fabricId}"`)
    applied.push(fabricId)
    written.add(key(binding))
  }
  let seed: number | null = null
  if (recipe.randomSeed && !written.has(key(recipe.randomSeed))) {
    seed = randomSeed()
    workflow[recipe.randomSeed.node].inputs[recipe.randomSeed.input] = seed
  }
  return { workflow, applied, seed }
}

function comfyRefusalMessage(title: string, status: number, bodyText: string): string {
  let parsed: any = null
  try {
    parsed = JSON.parse(bodyText)
  } catch {}
  if (isRecord(parsed)) {
    const parts: string[] = []
    const main = isRecord(parsed.error) ? parsed.error.message : typeof parsed.error === 'string' ? parsed.error : null
    if (main) parts.push(String(main))
    if (isRecord(parsed.node_errors)) {
      for (const [nodeId, nodeError] of Object.entries(parsed.node_errors)) {
        const errors = Array.isArray((nodeError as any)?.errors) ? (nodeError as any).errors : []
        for (const entry of errors.slice(0, 3)) {
          const detail = entry?.details || entry?.message
          if (detail) parts.push(`node ${nodeId} (${(nodeError as any).class_type ?? 'unknown'}): ${detail}`)
        }
      }
    }
    if (parts.length > 0) return `${title} refused the workflow (${status}): ${parts.join('; ')}`
  }
  return `${title} refused the workflow (${status}): ${bodyExcerpt(bodyText) || 'no body'}`
}

function comfyExecutionError(entry: Record<string, any>): string | null {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : []
  for (const message of messages) {
    if (Array.isArray(message) && message[0] === 'execution_error' && isRecord(message[1])) {
      const info = message[1]
      const where = info.node_type ? `${info.node_type} (node ${info.node_id})` : `node ${info.node_id ?? '?'}`
      return `${where}: ${info.exception_message ?? info.exception_type ?? 'failed'}`.trim()
    }
  }
  return null
}

interface ComfyImageRef {
  node: string
  filename: string
  subfolder: string
  type: string
}

/** Saved images first (`type: "output"`), previews only when nothing was saved. Exported for tests. */
export function collectComfyImages(outputs: Record<string, any>): ComfyImageRef[] {
  const saved: ComfyImageRef[] = []
  const previews: ComfyImageRef[] = []
  for (const node of Object.keys(outputs).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const images = Array.isArray(outputs[node]?.images) ? outputs[node].images : []
    for (const image of images) {
      if (!isRecord(image) || typeof image.filename !== 'string') continue
      const ref = { node, filename: image.filename, subfolder: String(image.subfolder ?? ''), type: String(image.type ?? 'output') }
      ;(ref.type === 'output' ? saved : previews).push(ref)
    }
  }
  return (saved.length > 0 ? saved : previews).slice(0, MAX_OUTPUT_FILES)
}

async function runComfy(
  deps: PinokioRunnerDeps,
  input: PinokioRunInput,
  endpoint: Extract<PinokioAppEndpoint, { ok: true }>,
  emit: PinokioRunEmitter
): Promise<PinokioRunResult> {
  const recipe = input.binding.runtime as unknown as PinokioComfyRecipe
  if (detectPromptShape(recipe.workflow) !== 'api') {
    throw new PinokioAppRunError('recipe_invalid', 'The saved ComfyUI workflow is not in API format.')
  }
  const { workflow, applied, seed } = fillComfyWorkflow(recipe, input.values, deps.randomSeed)
  const title = endpoint.title
  const base = endpoint.baseUrl
  const clientId = `batshit-${input.artifactId}`

  const submitted = await appFetch(deps, title, `${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: input.signal
  })
  const submittedText = await submitted.text()
  if (!submitted.ok) throw new PinokioAppRunError('app_error', comfyRefusalMessage(title, submitted.status, submittedText))
  let promptId: string | null = null
  try {
    const parsed = JSON.parse(submittedText)
    promptId = typeof parsed?.prompt_id === 'string' ? parsed.prompt_id : null
  } catch {}
  if (!promptId) {
    throw new PinokioAppRunError('app_error', `${title} accepted the workflow but returned no prompt_id: ${bodyExcerpt(submittedText)}`)
  }

  const deadline = deps.now() + RUN_CEILING_MS
  let entry: Record<string, any> | null = null
  while (deps.now() < deadline) {
    throwIfAborted(input.signal)
    const history = await appFetch(deps, title, `${base}/history/${encodeURIComponent(promptId)}`, { signal: input.signal })
    if (history.ok) {
      const parsed = (await history.json().catch(() => null)) as Record<string, any> | null
      const candidate = isRecord(parsed) ? parsed[promptId] : null
      if (isRecord(candidate) && (candidate.status?.completed === true || candidate.status?.status_str === 'error')) {
        entry = candidate
        break
      }
    }
    await deps.sleep(COMFY_POLL_MS)
  }
  if (!entry) {
    throw new PinokioAppRunError('timed_out', `${title} was still working on prompt ${promptId} after ${RUN_CEILING_MS / 60_000} minutes.`)
  }
  if (entry.status?.status_str === 'error') {
    throw new PinokioAppRunError('app_error', `${title} failed the workflow: ${comfyExecutionError(entry) ?? 'no error message'}.`)
  }

  const images = collectComfyImages(isRecord(entry.outputs) ? entry.outputs : {})
  if (images.length === 0) {
    throw new PinokioAppRunError(
      'no_output',
      `${title} finished the workflow but saved no image. The workflow needs a SaveImage (or PreviewImage) node.`
    )
  }
  let index = 0
  for (const image of images) {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })
    const response = await appFetch(deps, title, `${base}/view?${query.toString()}`, { signal: input.signal })
    if (!response.ok) {
      throw new PinokioAppRunError('app_error', `${title} would not return image ${image.filename} (${response.status}).`)
    }
    const mediaType = (response.headers.get('content-type') || 'image/png').split(';')[0].trim()
    const bytes = await readBytes(response, MAX_OUTPUT_FILE_BYTES, `Image ${image.filename}`)
    await emit.file(
      {
        base64: toDataUrl(bytes, mediaType),
        mediaType,
        metadata: { runtimeManager: 'pinokio', appId: input.binding.appId, kind: 'comfyui', node: image.node, filename: image.filename }
      },
      index
    )
    index += 1
  }
  const text = `Generated ${index} image${index === 1 ? '' : 's'} with ${title} (ComfyUI via Pinokio).`
  await emit.chunk(text)
  return { text, fileCount: index, metadata: { promptId, fieldsApplied: applied, ...(seed !== null ? { seed } : {}) } }
}

/* ------------------------------------------------------------------ *
 * Gradio
 * ------------------------------------------------------------------ */

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.internal')) return true
  const parts = host.split('.').map(Number)
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  }
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
}

/**
 * The bytes of one file argument. Accepted: a `data:` URL, a Batshit upload URL (a Clip), or an
 * http(s) URL on a public host. Anything else on this machine or the private network is
 * refused, so a field value cannot make Batshit read another local service. Exported for tests.
 */
export async function readFileArgument(
  deps: PinokioRunnerDeps,
  value: unknown,
  label: string,
  userId?: string
): Promise<{ bytes: Uint8Array; mediaType: string; name: string }> {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PinokioAppRunError(
      'input_invalid',
      `${label} needs a file: a Clip id (clip_...), a data: URL, a Batshit Clip URL, or a public http(s) URL.`
    )
  }
  const text = value.trim()
  // An agent knows an attached picture by its Clip id (the DCM Clips roster), never by its URL.
  if (PINOKIO_CLIP_ID_PATTERN.test(text)) {
    const clip = userId ? await deps.readClip(userId, text) : null
    if (!clip) {
      throw new PinokioAppRunError('input_invalid', `${label}: Clip "${text}" was not found, or it has no stored file.`)
    }
    const file = await readFileArgument(deps, clip.dataUrl, label)
    return clip.filename ? { ...file, name: clip.filename } : file
  }
  const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(text)
  if (dataMatch) {
    const mediaType = dataMatch[1] || 'application/octet-stream'
    const bytes = dataMatch[2] ? Buffer.from(dataMatch[3], 'base64') : Buffer.from(decodeURIComponent(dataMatch[3]))
    if (bytes.byteLength > MAX_INPUT_FILE_BYTES) {
      throw new PinokioAppRunError('input_invalid', `${label} is over the ${MAX_INPUT_FILE_BYTES}-byte limit.`)
    }
    const extension = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
    return { bytes: new Uint8Array(bytes), mediaType, name: `input.${extension}` }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new PinokioAppRunError('input_invalid', `${label} is not a URL or a data: URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PinokioAppRunError('input_invalid', `${label} must be an http(s) or data: URL.`)
  }
  const batshitUpload = deps.batshitUploadOrigins().includes(url.origin) && url.pathname.startsWith('/uploads/')
  if (!batshitUpload && isPrivateOrLoopbackHost(url.hostname)) {
    throw new PinokioAppRunError(
      'input_invalid',
      `${label} points at this computer or the private network (${url.host}). Pass a Batshit Clip URL, a public URL, or a data: URL.`
    )
  }
  let response: Response
  try {
    response = await deps.fetch(url.toString(), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' })
  } catch (error) {
    // undici puts the real reason (DNS, refused, a redirect) in `cause`.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null
    const reason = cause ?? (error instanceof Error ? error.message : 'unknown error')
    throw new PinokioAppRunError(
      'input_invalid',
      `${label}: Batshit could not download ${url.host} (${reason}; redirects are not followed). Check the link, or pass a Batshit Clip URL or a data: URL.`
    )
  }
  if (!response.ok) {
    throw new PinokioAppRunError(
      'input_invalid',
      `${label}: ${url.host} answered ${response.status} when Batshit downloaded the link, so the link is wrong or that site refuses downloads. Check it, or pass a Batshit Clip URL or a data: URL.`
    )
  }
  const bytes = await readBytes(response, MAX_INPUT_FILE_BYTES, label)
  const mediaType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
  const name = decodeURIComponent(url.pathname.split('/').pop() || 'input') || 'input'
  return { bytes, mediaType, name }
}

async function gradioPrefix(deps: PinokioRunnerDeps, title: string, base: string, signal?: AbortSignal): Promise<string> {
  const response = await appFetch(deps, title, `${base}/config`, { signal })
  if (!response.ok) {
    throw new PinokioAppRunError('app_error', `${title} did not return its Gradio config (${response.status}); is it a Gradio app?`)
  }
  const config = (await response.json().catch(() => null)) as Record<string, any> | null
  const prefix = typeof config?.api_prefix === 'string' ? config.api_prefix.trim() : ''
  return prefix === '/' ? '' : prefix.replace(/\/+$/, '')
}

/**
 * The defaults the app declares for one endpoint's parameters, by position (`<prefix>/info`).
 * Null when the app does not answer: the run then sends null for an empty field, as the recipe says.
 */
async function gradioParameterDefaults(
  deps: PinokioRunnerDeps,
  base: string,
  prefix: string,
  apiName: string,
  signal?: AbortSignal
): Promise<Map<number, unknown> | null> {
  const response = await deps
    .fetch(`${base}${prefix}/info`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .catch(() => null)
  if (!response?.ok) return null
  const info = (await response.json().catch(() => null)) as Record<string, any> | null
  const parameters = info?.named_endpoints?.[apiName]?.parameters
  if (!Array.isArray(parameters)) return null
  const defaults = new Map<number, unknown>()
  parameters.forEach((parameter: any, position: number) => {
    if (parameter?.parameter_has_default === true) defaults.set(position, parameter.parameter_default)
  })
  return defaults
}

/**
 * A Gradio endpoint can return a component update (`{"__type__": "update", ...}`) instead of a
 * value: it changes a slider's range or hides a box on the app's own page and is never a result.
 * One that carries a `value` stands for that value; any other update is dropped (undefined).
 */
export function unwrapGradioUpdate(output: unknown): unknown {
  if (!isRecord(output) || output.__type__ !== 'update') return output
  return 'value' in output ? output.value : undefined
}

/** Reads a Gradio `call` event stream to its `complete` (or `error`) event. Exported for tests. */
export function parseGradioEventStream(text: string): { event: 'complete' | 'error' | null; data: unknown } {
  let current: string | null = null
  let result: { event: 'complete' | 'error' | null; data: unknown } = { event: null, data: null }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith('event:')) {
      current = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:') && (current === 'complete' || current === 'error')) {
      const raw = line.slice('data:'.length).trim()
      let data: unknown = raw
      try {
        data = JSON.parse(raw)
      } catch {}
      result = { event: current, data }
    }
  }
  return result
}

function gradioFileUrl(value: Record<string, any>, base: string, prefix: string): string | null {
  if (typeof value.url === 'string' && value.url) {
    try {
      const url = new URL(value.url, base)
      // The app's own file route only: rewrite its host to the address Batshit resolved.
      const resolved = new URL(url.pathname + url.search, base)
      return resolved.toString()
    } catch {
      return null
    }
  }
  if (typeof value.path === 'string' && value.path) return `${base}${prefix}/file=${value.path}`
  return null
}

async function runGradio(
  deps: PinokioRunnerDeps,
  input: PinokioRunInput,
  endpoint: Extract<PinokioAppEndpoint, { ok: true }>,
  emit: PinokioRunEmitter
): Promise<PinokioRunResult> {
  const recipe = input.binding.runtime as unknown as PinokioGradioRecipe
  const title = endpoint.title
  const base = endpoint.baseUrl
  const prefix = await gradioPrefix(deps, title, base, input.signal)

  const apiName = recipe.api_name.startsWith('/') ? recipe.api_name : `/${recipe.api_name}`
  // A positional null overrides the app's own default (an OCR app answered "Unknown model: None"
  // when the agent left the model out), so an empty field takes the default the app declares.
  const needsDefaults = recipe.inputs.some((argument) => !('value' in argument) && !argument.file && !hasValue(input.values[argument.field]))
  const defaults = needsDefaults ? await gradioParameterDefaults(deps, base, prefix, apiName, input.signal) : null

  const data: unknown[] = []
  const applied: string[] = []
  for (const [index, argument] of recipe.inputs.entries()) {
    if ('value' in argument) {
      data.push(argument.value)
      continue
    }
    const value = input.values[argument.field]
    if (!argument.file) {
      if (hasValue(value)) {
        data.push(value)
        applied.push(argument.field)
      } else {
        data.push(defaults?.has(index) ? defaults.get(index) : null)
      }
      continue
    }
    const file = await readFileArgument(deps, value, `"${argument.field}"`, input.userId)
    const form = new FormData()
    form.append('files', new Blob([Buffer.from(file.bytes)], { type: file.mediaType }), file.name)
    const uploaded = await appFetch(deps, title, `${base}${prefix}/upload`, { method: 'POST', body: form, signal: input.signal })
    const uploadedText = await uploaded.text()
    let paths: unknown = null
    try {
      paths = JSON.parse(uploadedText)
    } catch {}
    if (!uploaded.ok || !Array.isArray(paths) || typeof paths[0] !== 'string') {
      throw new PinokioAppRunError('app_error', `${title} refused the file for argument ${index + 1} (${uploaded.status}): ${bodyExcerpt(uploadedText)}`)
    }
    data.push({ path: paths[0], orig_name: file.name, mime_type: file.mediaType, meta: { _type: 'gradio.FileData' } })
    applied.push(argument.field)
  }

  const called = await appFetch(deps, title, `${base}${prefix}/call${apiName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: input.signal
  })
  const calledText = await called.text()
  let eventId: string | null = null
  try {
    eventId = JSON.parse(calledText)?.event_id ?? null
  } catch {}
  if (!called.ok || typeof eventId !== 'string') {
    throw new PinokioAppRunError('app_error', `${title} refused the call to ${apiName} (${called.status}): ${bodyExcerpt(calledText)}`)
  }

  const streamed = await deps.fetch(`${base}${prefix}/call${apiName}/${encodeURIComponent(eventId)}`, {
    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(RUN_CEILING_MS)]) : AbortSignal.timeout(RUN_CEILING_MS)
  }).catch((error) => {
    throw new PinokioAppRunError('app_unreachable', `${title} stopped answering during the run: ${error instanceof Error ? error.message : 'unknown error'}.`)
  })
  const outcome = parseGradioEventStream(await streamed.text())
  if (outcome.event !== 'complete') {
    const detail = outcome.event === 'error' && outcome.data ? `: ${typeof outcome.data === 'string' ? outcome.data : JSON.stringify(outcome.data)}` : ''
    throw new PinokioAppRunError(
      'app_error',
      `${title} failed ${apiName}${detail || ' with no error message (Gradio hides the reason unless the app sets show_error)'}. Its log may say why: fabric:sys.pinokio.logs.`
    )
  }

  const returned = Array.isArray(outcome.data) ? outcome.data : [outcome.data]
  // The recipe's `outputs` picks the result out of everything the endpoint returns (an OCR app
  // also returns a preview of the input page and a status line); left out, all of it is kept.
  const outputs = Array.isArray(recipe.outputs) ? recipe.outputs.map((position) => returned[position]) : returned
  const texts: string[] = []
  let fileIndex = 0
  for (const rawOutput of outputs) {
    const output = unwrapGradioUpdate(rawOutput)
    if (output === undefined) continue
    if (typeof output === 'string') {
      if (output.trim()) texts.push(output)
      continue
    }
    if (isRecord(output) && (typeof output.url === 'string' || typeof output.path === 'string')) {
      const fileUrl = gradioFileUrl(output, base, prefix)
      const mediaType = typeof output.mime_type === 'string' ? output.mime_type : ''
      if (fileUrl && fileIndex < MAX_OUTPUT_FILES) {
        const response = await appFetch(deps, title, fileUrl, { signal: input.signal })
        if (response.ok) {
          const type = (response.headers.get('content-type') || mediaType || 'application/octet-stream').split(';')[0].trim()
          if (type.startsWith('image/')) {
            const bytes = await readBytes(response, MAX_OUTPUT_FILE_BYTES, 'An output file')
            await emit.file(
              { base64: toDataUrl(bytes, type), mediaType: type, metadata: { runtimeManager: 'pinokio', appId: input.binding.appId, kind: 'gradio' } },
              fileIndex
            )
            fileIndex += 1
            continue
          }
        }
      }
      texts.push(`[file ${typeof output.orig_name === 'string' ? output.orig_name : 'output'}]`)
      continue
    }
    if (output !== null && output !== undefined) texts.push(typeof output === 'object' ? JSON.stringify(output) : String(output))
  }
  const text = texts.join('\n\n') || (fileIndex > 0 ? `${title} returned ${fileIndex} file${fileIndex === 1 ? '' : 's'}.` : '')
  if (!text && fileIndex === 0) {
    throw new PinokioAppRunError('no_output', `${title} finished ${apiName} but returned nothing.`)
  }
  if (text) await emit.chunk(text)
  return { text, fileCount: fileIndex, metadata: { apiName, fieldsApplied: applied } }
}

/* ------------------------------------------------------------------ *
 * Custom HTTP API
 * ------------------------------------------------------------------ */

async function runCustom(
  deps: PinokioRunnerDeps,
  input: PinokioRunInput,
  endpoint: Extract<PinokioAppEndpoint, { ok: true }>,
  emit: PinokioRunEmitter
): Promise<PinokioRunResult> {
  const recipe = input.binding.runtime as Record<string, any>
  const title = endpoint.title
  const response = await appFetch(deps, title, `${endpoint.baseUrl}${recipe.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, image/*' },
    body: JSON.stringify(input.values),
    signal: input.signal
  })
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim()
  if (!response.ok) {
    throw new PinokioAppRunError('app_error', `${title} answered ${recipe.path} with ${response.status}: ${bodyExcerpt(await response.text())}`)
  }
  if (contentType.startsWith('image/')) {
    const bytes = await readBytes(response, MAX_OUTPUT_FILE_BYTES, 'The image')
    await emit.file(
      { base64: toDataUrl(bytes, contentType), mediaType: contentType, metadata: { runtimeManager: 'pinokio', appId: input.binding.appId, kind: 'custom' } },
      0
    )
    const text = `${title} returned an image.`
    await emit.chunk(text)
    return { text, fileCount: 1, metadata: { path: recipe.path } }
  }
  const bodyText = await response.text()
  let text = bodyText
  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(bodyText)
      const direct = isRecord(parsed) ? parsed.text ?? parsed.output ?? parsed.result ?? parsed.response : null
      text = typeof direct === 'string' ? direct : JSON.stringify(parsed, null, 2)
    } catch {}
  }
  if (!text.trim()) throw new PinokioAppRunError('no_output', `${title} answered ${recipe.path} with an empty body.`)
  await emit.chunk(text)
  return { text, fileCount: 0, metadata: { path: recipe.path } }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function runPinokioAppArtifact(
  input: PinokioRunInput,
  emit: PinokioRunEmitter,
  deps: PinokioRunnerDeps = realDeps
): Promise<PinokioRunResult> {
  const problems = pinokioArtifactProblems({ brainType: 'pinokio_app', metadata: input.metadata, mode: 'published' })
  if (problems.length > 0) {
    throw new PinokioAppRunError('recipe_invalid', `This Pinokio app artifact cannot run yet: ${problems.join(' ')}`)
  }

  const endpoint = await deps.resolveEndpoint(input.binding.appId)
  if (!endpoint.ok) {
    throw new PinokioAppRunError(endpoint.code, pinokioEndpointAgentMessage(endpoint), {
      appId: endpoint.appId,
      title: endpoint.title,
      state: endpoint.state ?? null,
      ...(endpoint.reason ? { reason: endpoint.reason } : {})
    })
  }

  try {
    const kind = input.binding.kind
    const result =
      kind === 'comfyui'
        ? await runComfy(deps, input, endpoint, emit)
        : kind === 'gradio'
          ? await runGradio(deps, input, endpoint, emit)
          : await runCustom(deps, input, endpoint, emit)
    return {
      ...result,
      metadata: {
        transport: 'pinokio-app',
        runtimeManager: 'pinokio',
        appId: input.binding.appId,
        appTitle: endpoint.title,
        kind,
        kindLabel: `${PINOKIO_ARTIFACT_KIND_LABELS[kind]} via Pinokio`,
        ...result.metadata
      }
    }
  } catch (error) {
    // The app may have stopped between the probe and the call: the next run asks Pinokio again.
    if (error instanceof PinokioAppRunError && error.code === 'app_unreachable') forgetPinokioAppEndpoint(input.binding.appId)
    throw error
  }
}
