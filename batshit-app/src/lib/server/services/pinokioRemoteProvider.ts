/**
 * Saved remote Pinokio 8.2.0 native reads and one server-admitted root-script launch.
 * No local Pinokio, pterm, config, executable, environment or peer relay is involved.
 * Native source provenance/limitations: Plans/2026-10-16-pinokio-lan-and-compatibility-plan.md.
 * In particular, candidates project ENVIRONMENT metadata but cannot attest a successful read.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Agent, WebSocket } from 'undici'
import { pinokioArtifactAppIdProblem } from '$lib/artifacts/pinokioArtifact'
import { isPinokioControlHost, type PinokioRemoteMachine } from '$lib/pinokio/machines'
import { pinokioMachineService, PinokioMachineError } from './pinokioMachineService'
import { registerRuntimeShutdownTask } from './runtimeShutdown'
import type { PinokioAppStatus, PinokioLogs, PinokioOutcome, PinokioSearchResult, PinokioStartPreview, PinokioRunResult } from './pinokioTypes'

const READ_BUDGET_MS = 15_000
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_GRAPH_APPS = 64
const MAX_GRAPH_DEPTH = 16
const STATES = new Set(['offline', 'starting', 'online'])
const VERSION_FLOOR = [8, 2, 0]

export interface PinokioReadTargetOptions {
  userId?: string
  machineId?: string
  revision?: number
  /** Server-owned request cancellation; never part of a model-facing schema. */
  signal?: AbortSignal
}

export interface PinokioRemoteScope {
  machineId: string
  machineRevision: number
  machineLabel: string
}

export interface PinokioRemoteDetection extends PinokioRemoteScope {
  available: true
  kind: 'remote'
  version: string | null
  pinokiodVersion: string
  scriptVersion: string | null
  message: string
}

interface NativePath {
  root: string
  style: 'posix' | 'win32'
}

export interface PinokioRemoteNativeStatus extends Omit<PinokioAppStatus, keyof PinokioRemoteScope>, PinokioRemoteScope {
  nativePath: NativePath
  defaultTarget: string | null
  defaultScript: string | null
  startScript: string | null
  installScript: string | null
  /** Same saved host only; these are reported addresses, not a reachability assertion. */
  externalReadyUrls: string[]
  excludedExternalReadyUrls: number
  /** Missing native correlation is unknown, never inferred from aggregate app.ready. */
  runningScripts: string[] | null
  readyScript: string | null
}

export interface PinokioRemoteStartOptions extends PinokioReadTargetOptions {
  appId: string
  alsoStarts?: string[]
  waitSeconds?: number
  launchFingerprint?: string
  /** In-process P3 owner/scope/subject/Stop admission, NEVER a model/body approval flag. */
  admitStart?: () => Promise<boolean>
}

export type PinokioNativeSocket = Pick<InstanceType<typeof WebSocket>, 'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>
interface NativeClient { socket: PinokioNativeSocket; dispose(): Promise<void> }

interface NativeCandidate {
  script: string
  label: string
  source: 'menu' | 'current' | 'local'
  menuDefault: boolean
  hasParams: boolean
}

export interface PinokioRemoteCandidates extends PinokioRemoteScope {
  appId: string
  nativePath: NativePath
  launcherRoot: string
  configuredScript: string
  declaredRequires: string[]
  startupEnabled: boolean
  candidates: NativeCandidate[]
  /** Shipping native API turns missing AND failed ENVIRONMENT reads into empty values. */
  dependencyRead: 'native_projection_unattested'
}

export interface PinokioRemoteGraph extends PinokioRemoteScope {
  appId: string
  nodes: Array<{ status: PinokioRemoteNativeStatus; projection: PinokioRemoteCandidates }>
  /** All projected declared requirements, conservatively retained for consent. */
  declaredAlsoStarts: string[]
  /** Native implicit preparation applies only to the exact configured root script. */
  effectiveAlsoStarts: string[]
  dependencyRead: 'native_projection_unattested'
}

type RemoteTarget = PinokioRemoteMachine & { kind: 'remote' }
interface ReadContext {
  userId: string
  target: RemoteTarget
  deadline: number
  signal?: AbortSignal
}

export interface PinokioRemoteReadDeps {
  fetch: typeof fetch
  resolveCurrent: typeof pinokioMachineService.resolveCurrent
  resolve: typeof pinokioMachineService.resolve
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  createClient(url: URL): NativeClient
}

const realDeps: PinokioRemoteReadDeps = {
  fetch: (...args) => fetch(...args),
  resolveCurrent: (...args) => pinokioMachineService.resolveCurrent(...args),
  resolve: (...args) => pinokioMachineService.resolve(...args),
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve() }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Cancelled')) }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  }),
  createClient: (url) => {
    // Dedicated direct dispatcher: no ambient proxy/auth/cookie state, TLS defaults intact.
    // Undici's WS handshake uses redirect:error; native WS close only unsubscribes.
    const dispatcher = new Agent({ connect: { timeout: 10_000 }, webSocket: { maxPayloadSize: 256 * 1024, maxFragments: 256 } })
    const socket = new WebSocket(url, { dispatcher, headers: {} })
    return { socket, dispose: async () => { socket.close(); await dispatcher.destroy() } }
  }
}
let deps = realDeps

export function __setPinokioRemoteReadDepsForTests(overrides: Partial<PinokioRemoteReadDeps> | null) {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps
  if (!overrides) {
    for (const controller of activeStarts) controller.abort()
    startAttempts.clear()
    admissionFences = 0
    admissionEpoch += 1
    shutdownRegistered = false
  }
}

class RemoteReadError extends Error {
  constructor(public code: string, message: string, public kind: 'unavailable' | 'not_found' | 'refused' | 'error' = 'error') {
    super(message)
  }
}

function fail(code: string, message: string, kind: RemoteReadError['kind'] = 'error'): never {
  throw new RemoteReadError(code, message, kind)
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function clean(value: string, limit = 500): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(0, limit)
}
function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('pinokio_remote_shape', `Pinokio returned an unrecognised ${name}.`)
  }
  return value
}
function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name)
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail('pinokio_remote_shape', `Pinokio returned an unrecognised ${name}.`)
  return value
}
function appId(value: unknown): string {
  if (pinokioArtifactAppIdProblem(value)) fail('pinokio_remote_app_invalid', 'Choose an installed app folder ID from this saved Pinokio computer.', 'refused')
  return (value as string).trim()
}
function exactApp(value: unknown, expected: string) {
  if (value !== expected) fail('pinokio_remote_app_mismatch', 'Pinokio answered for a different app. Nothing was retargeted.', 'refused')
}
function scope(target: RemoteTarget): PinokioRemoteScope {
  return { machineId: target.id, machineRevision: target.revision, machineLabel: target.label }
}
function checkActive(context: ReadContext) {
  if (context.signal?.aborted) fail('pinokio_remote_cancelled', 'The Pinokio read was cancelled.', 'refused')
  if (deps.now() >= context.deadline) fail('pinokio_remote_timeout', 'The Pinokio computer did not answer within the read deadline.', 'unavailable')
}
function sameTarget(a: RemoteTarget, b: RemoteTarget) {
  return a.id === b.id && a.revision === b.revision && a.controlHost === b.controlHost &&
    a.controlPort === b.controlPort && a.controlProtocol === b.controlProtocol
}
async function revalidate(context: ReadContext) {
  checkActive(context)
  const current = await deps.resolve(context.userId, { machineId: context.target.id, revision: context.target.revision })
  checkActive(context)
  if (current.kind !== 'remote' || !sameTarget(context.target, current)) {
    fail('pinokio_machine_changed', 'This Pinokio computer changed while it was being read. Choose it again.', 'refused')
  }
  context.target = current
}

async function begin(input: PinokioReadTargetOptions): Promise<ReadContext> {
  if (typeof input.userId !== 'string' || !input.userId.trim() || typeof input.machineId !== 'string') {
    fail('pinokio_machine_invalid', 'A signed-in user and saved Pinokio computer are required.', 'refused')
  }
  const target = input.revision === undefined
    ? await deps.resolveCurrent(input.userId, input.machineId)
    : await deps.resolve(input.userId, { machineId: input.machineId, revision: input.revision })
  if (target.kind !== 'remote') fail('pinokio_machine_invalid', 'Choose a saved remote Pinokio computer.', 'refused')
  const context = { userId: input.userId, target, signal: input.signal, deadline: deps.now() + READ_BUDGET_MS }
  checkActive(context)
  return context
}

async function readJson(context: ReadContext, pathname: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  checkActive(context)
  const { controlProtocol, controlHost, controlPort } = context.target
  // The canonical owner admits RFC1918 literals. Recheck rather than let a mocked/changed
  // owner or returned native ref turn this helper into a public URL/DNS fetcher.
  if (!isPinokioControlHost(controlHost) || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535 ||
    (controlProtocol !== 'http' && controlProtocol !== 'https')) {
    fail('pinokio_machine_invalid', 'The saved Pinokio address is invalid.', 'refused')
  }
  const url = new URL(pathname, `${controlProtocol}://${controlHost}:${controlPort}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const controller = new AbortController()
  const abort = () => controller.abort()
  context.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, Math.max(1, Math.min(READ_BUDGET_MS, context.deadline - deps.now())))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let completed = false
  try {
    const response = await deps.fetch(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal
    })
    reader = response.body?.getReader()
    checkActive(context)
    if (response.status >= 300 && response.status < 400) fail('pinokio_remote_redirect', 'Pinokio redirected the read. Batshit did not follow it.', 'refused')
    if (!response.ok) {
      const kind = response.status === 404 ? 'not_found' : response.status === 401 || response.status === 403 ? 'refused' : 'error'
      fail('pinokio_remote_http', `Pinokio answered HTTP ${response.status}.`, kind)
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      fail('pinokio_remote_shape', 'Pinokio did not return the expected JSON read response.')
    }
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
      fail('pinokio_remote_size', 'The Pinokio read response exceeded its size limit.')
    }
    if (!reader) fail('pinokio_remote_shape', 'Pinokio returned an empty read response.')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let body = ''
    while (true) {
      const chunk = await reader.read()
      checkActive(context)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_JSON_BYTES) fail('pinokio_remote_size', 'The Pinokio read response exceeded its size limit.')
      try { body += decoder.decode(chunk.value, { stream: true }) } catch { fail('pinokio_remote_shape', 'Pinokio returned invalid UTF-8 JSON.') }
    }
    try { body += decoder.decode() } catch { fail('pinokio_remote_shape', 'Pinokio returned invalid UTF-8 JSON.') }
    completed = true
    let value: unknown
    try { value = JSON.parse(body) } catch { fail('pinokio_remote_shape', 'Pinokio returned invalid JSON.') }
    if (!record(value)) fail('pinokio_remote_shape', 'Pinokio returned an unrecognised JSON read response.')
    await revalidate(context)
    return value
  } catch (error) {
    if (error instanceof RemoteReadError || error instanceof PinokioMachineError) throw error
    checkActive(context)
    if (controller.signal.aborted) fail('pinokio_remote_timeout', 'The Pinokio computer did not answer within the read deadline.', 'unavailable')
    return fail('pinokio_remote_unreachable', 'The saved Pinokio computer could not be read. Check its address and that Pinokio is running there.', 'unavailable')
  } finally {
    clearTimeout(timer)
    context.signal?.removeEventListener('abort', abort)
    if (reader) {
      if (!completed) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

function supportedVersion(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return false
  const parts = value.split('.').map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) return false
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== VERSION_FLOOR[i]) return parts[i] > VERSION_FLOOR[i]
  }
  return true
}
async function version(context: ReadContext): Promise<PinokioRemoteDetection> {
  const value = await readJson(context, '/pinokio/version')
  if (!supportedVersion(value.pinokiod) || (value.pinokio != null && !supportedVersion(value.pinokio))) {
    fail('pinokio_remote_version', 'This Pinokio computer needs a supported Pinokio 8.2.0 or newer native read interface.', 'unavailable')
  }
  return {
    ...scope(context.target), kind: 'remote', available: true, version: value.pinokio == null ? null : value.pinokio as string,
    pinokiodVersion: value.pinokiod, scriptVersion: value.script == null ? null : text(value.script, 'script version', 50),
    message: `Pinokio is answering on ${context.target.label}.`
  }
}

function nativeRoot(value: unknown, id: string): NativePath {
  const root = text(value, 'native app folder')
  const style = /^[A-Za-z]:[\\/]/.test(root) ? 'win32' : root.startsWith('/') && !root.startsWith('//') ? 'posix' : null
  if (!style || root.split(/[\\/]/).some((part) => part === '.' || part === '..')) {
    fail('pinokio_remote_path', 'Pinokio did not identify a safe native installed-app folder.', 'refused')
  }
  const impl = path[style]
  if (impl.basename(root) !== id || impl.basename(impl.dirname(root)).toLowerCase() !== 'api') {
    fail('pinokio_remote_path', 'Pinokio answered with a different installed-app folder.', 'refused')
  }
  return { root: impl.normalize(root), style }
}
function relativeScript(value: unknown, allowEmpty = false): string {
  const script = text(value, 'relative launcher script', 1024)
  if (allowEmpty && !script) return ''
  if (!script || /^[A-Za-z][A-Za-z\d+.-]*:/.test(script) || /^[\\/]/.test(script) ||
    script.includes('#') || script.split(/[\\/]/).some((part) => part === '.' || part === '..' || !part)) {
    fail('pinokio_remote_path', 'Pinokio returned a launcher script outside its admitted app.', 'refused')
  }
  return script.replace(/\\/g, '/')
}
function declaredScript(value: unknown): string | null {
  return value === null ? null : relativeScript(text(value, 'launcher script').split('?')[0])
}
function sourceLocal(value: Record<string, unknown>) {
  if (!record(value.source) || value.source.local !== true) {
    fail('pinokio_remote_source', 'The saved Pinokio computer answered through another peer. Batshit did not retarget the read.', 'refused')
  }
}
function checkRef(value: unknown, expected: string) {
  if (value === undefined || value === null) return
  let ref: URL
  try { ref = new URL(text(value, 'app ref')) } catch { fail('pinokio_remote_shape', 'Pinokio returned an invalid app ref.') }
  const parts = ref.pathname.split('/').filter(Boolean)
  let refId = ''
  try { refId = decodeURIComponent(parts[1] ?? '') } catch { fail('pinokio_remote_shape', 'Pinokio returned an invalid app ref.') }
  if (ref.protocol !== 'pinokio:' || !ref.hostname || !ref.port || ref.username || ref.password || ref.search || ref.hash ||
    parts.length !== 2 || parts[0] !== 'api' || refId !== expected) {
    fail('pinokio_remote_app_mismatch', 'Pinokio returned a different app ref. Nothing was retargeted.', 'refused')
  }
  // Its host is informational. Every request still uses the saved canonical origin.
}
function parseStatus(value: Record<string, unknown>, id: string, target: RemoteTarget): PinokioRemoteNativeStatus {
  exactApp(value.app_id, id)
  sourceLocal(value)
  checkRef(value.ref, id)
  const state = text(value.state, 'app state')
  if (!STATES.has(state) || (value.probe !== null && typeof value.probe !== 'boolean')) fail('pinokio_remote_shape', 'Pinokio returned an unrecognised app state or probe.')
  const folder = nativeRoot(value.path, id)
  const defaultTarget = nullableText(value.default_target, 'default target')
  const defaultScript = value.default_script === null ? null : text(value.default_script, 'default script')
  if ((defaultTarget === null) !== (defaultScript === null)) {
    // An HTTP default is an existing app URL, not a runnable script.
    if (!defaultTarget || !/^https?:\/\//i.test(defaultTarget) || defaultScript !== null) fail('pinokio_remote_shape', 'Pinokio returned an inconsistent launcher default.')
  }
  if (defaultScript !== null) {
    const script = relativeScript(defaultScript.split('?')[0])
    const targetPath = defaultTarget!.split('?')[0]
    const impl = path[folder.style]
    if (!impl.isAbsolute(targetPath) || impl.relative(folder.root, targetPath).split(impl.sep).join('/') !== script) {
      fail('pinokio_remote_path', 'Pinokio returned a default outside this installed app.', 'refused')
    }
  }
  if (!Array.isArray(value.external_ready_urls) || value.external_ready_urls.length > 128) fail('pinokio_remote_shape', 'Pinokio returned unrecognised advertised app URLs.')
  const urls: string[] = []
  let excluded = 0
  for (const item of value.external_ready_urls) {
    if (!record(item) || item.transport !== 'ip') fail('pinokio_remote_shape', 'Pinokio returned an unrecognised advertised app URL.')
    let url: URL
    try { url = new URL(text(item.url, 'advertised app URL')) } catch { fail('pinokio_remote_shape', 'Pinokio returned an invalid advertised app URL.') }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash || url.hostname !== target.controlHost) excluded += 1
    else urls.push(url.toString())
  }
  return {
    ...scope(target), appId: id, title: clean(text(value.title, 'app title')), state: state as PinokioAppStatus['state'],
    running: bool(value.running, 'running state'), ready: bool(value.ready, 'ready state'),
    readyUrl: nullableText(value.ready_url, 'ready URL'), probe: value.probe as boolean | null,
    path: folder.root, lastError: value.last_error === null ? null : clean(text(value.last_error, 'last error')),
    nativePath: folder, defaultTarget, defaultScript, startScript: declaredScript(value.start_script), installScript: declaredScript(value.install_script),
    externalReadyUrls: [...new Set(urls)], excludedExternalReadyUrls: excluded,
    runningScripts: value.running_scripts === undefined ? null : (() => {
      if (!Array.isArray(value.running_scripts) || value.running_scripts.length > 1000) fail('pinokio_remote_shape', 'Pinokio returned unrecognised running scripts.')
      return value.running_scripts.map((script) => relativeScript(script))
    })(),
    readyScript: value.ready_script == null ? null : relativeScript(value.ready_script)
  }
}
async function status(context: ReadContext, id: string, probe = false) {
  return parseStatus(await readJson(context, `/apps/status/${encodeURIComponent(id)}`, { probe: probe ? '1' : '0', timeout: '1500' }), id, context.target)
}

async function candidates(context: ReadContext, current: PinokioRemoteNativeStatus): Promise<PinokioRemoteCandidates> {
  const value = await readJson(context, '/autolaunch/candidates', { app: current.appId })
  if (value.ok !== true || !record(value.app)) fail('pinokio_remote_shape', 'Pinokio returned unrecognised launch settings.')
  const app = value.app
  exactApp(app.id, current.appId)
  const folder = nativeRoot(app.workspace_path, current.appId)
  if (folder.style !== current.nativePath.style || folder.root !== current.nativePath.root) fail('pinokio_remote_path', 'Pinokio changed the app folder during the read.', 'refused')
  const launcherRoot = relativeScript(value.launcher_root, true)
  const impl = path[folder.style]
  if (impl.normalize(text(app.launcher_path, 'launcher folder')) !== impl.join(folder.root, launcherRoot)) {
    fail('pinokio_remote_path', 'Pinokio returned an inconsistent launcher folder.', 'refused')
  }
  const configuredScript = text(app.autolaunch, 'configured launch script', 1024)
  if (configuredScript) relativeScript(configuredScript.split('?')[0])
  if (value.current !== configuredScript || !Array.isArray(app.autolaunch_depends) || app.autolaunch_depends.length > MAX_GRAPH_APPS) {
    fail('pinokio_remote_shape', 'Pinokio returned inconsistent launch requirements.')
  }
  const declaredRequires = app.autolaunch_depends.map(appId)
  if (new Set(declaredRequires).size !== declaredRequires.length) fail('pinokio_remote_shape', 'Pinokio returned duplicate launch requirements.')
  const parsed: NativeCandidate[] = []
  for (const list of [value.menu, value.other]) {
    if (!Array.isArray(list) || list.length > 1000) fail('pinokio_remote_shape', 'Pinokio returned unrecognised launcher candidates.')
    for (const entry of list) {
      if (!record(entry) || !['menu', 'current', 'local'].includes(entry.source as string)) fail('pinokio_remote_shape', 'Pinokio returned an unrecognised launcher candidate.')
      parsed.push({
        script: relativeScript(entry.script), label: clean(text(entry.label, 'script label')), source: entry.source as NativeCandidate['source'],
        menuDefault: bool(entry.menu_default, 'menu default'), hasParams: bool(entry.has_params, 'script parameters')
      })
    }
  }
  return {
    ...scope(context.target), appId: current.appId, nativePath: folder, launcherRoot, configuredScript,
    declaredRequires, startupEnabled: bool(app.autolaunch_enabled, 'startup setting'), candidates: parsed,
    dependencyRead: 'native_projection_unattested'
  }
}

async function outcome<T>(input: PinokioReadTargetOptions, read: (context: ReadContext, detection: PinokioRemoteDetection) => Promise<T>, recheck = true): Promise<PinokioOutcome<T>> {
  try {
    const context = await begin(input)
    const detection = await version(context)
    const value = await read(context, detection)
    if (recheck) await revalidate(context)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof PinokioMachineError) return { ok: false, kind: 'refused', code: error.code, message: error.message }
    if (error instanceof RemoteReadError) return { ok: false, kind: error.kind, code: error.code, message: error.message }
    return { ok: false, kind: 'error', code: 'pinokio_remote_read', message: 'Batshit could not read the saved Pinokio computer.' }
  }
}

async function readGraph(context: ReadContext, rootId: string): Promise<PinokioRemoteGraph> {
  const nodes: PinokioRemoteGraph['nodes'] = []
  const held = new Map<string, PinokioRemoteGraph['nodes'][number]>()
  const visiting = new Set<string>()
  const visit = async (id: string, depth: number): Promise<void> => {
    if (visiting.has(id)) fail('pinokio_remote_dependencies', 'Pinokio reports a cycle in the app launch requirements.', 'refused')
    if (held.has(id)) return
    if (depth > MAX_GRAPH_DEPTH || held.size >= MAX_GRAPH_APPS) fail('pinokio_remote_dependencies', 'The Pinokio launch requirements exceeded the bounded read limit.', 'refused')
    const current = await status(context, id)
    const projection = await candidates(context, current)
    const selected = id === rootId ? current.defaultScript?.split('?')[0] : projection.configuredScript.replace(/\\/g, '/')
    if (selected && (selected === current.installScript || /(?:^|\/)install\.(?:js|json|mjs|cjs)$/i.test(selected))) {
      fail('pinokio_remote_install_default', 'Pinokio selected an install action. Batshit will not run it.', 'refused')
    }
    if (selected && !projection.candidates.some((candidate) => candidate.script === selected)) {
      fail('pinokio_remote_path', 'The selected Pinokio script is not an admitted native candidate.', 'refused')
    }
    if (id !== rootId && !selected) fail('pinokio_remote_dependencies', `Required app ${id} has no configured launch script.`, 'refused')
    const node = { status: current, projection }
    held.set(id, node)
    visiting.add(id)
    for (const dependency of projection.declaredRequires) await visit(dependency, depth + 1)
    visiting.delete(id)
    nodes.push(node)
  }
  await visit(rootId, 0)
  const root = held.get(rootId)!
  const declaredAlsoStarts = nodes.map((node) => node.status.appId).filter((id) => id !== rootId).sort()
  const effectiveAlsoStarts = root.status.defaultScript?.split('?')[0] === root.projection.configuredScript
    ? declaredAlsoStarts : []
  return { ...scope(context.target), appId: rootId, nodes, declaredAlsoStarts, effectiveAlsoStarts, dependencyRead: 'native_projection_unattested' }
}

interface ObservedPlan {
  graph: PinokioRemoteGraph
  root: PinokioRemoteGraph['nodes'][number]
  fingerprint: string
}
interface LaunchPlan extends ObservedPlan {
  script: string
  uri: string
  input?: Record<string, string | string[]>
}

function launchPlan(context: ReadContext, graph: PinokioRemoteGraph): LaunchPlan {
  const root = graph.nodes.find((node) => node.status.appId === graph.appId)!
  const { defaultTarget, defaultScript, nativePath } = root.status
  // Native pterm run has no implicit start.js/install.js fallback without a selected
  // default. HTTP defaults are links, never command authority. No mode:open reservation.
  if (!defaultTarget || !defaultScript || /^https?:/i.test(defaultTarget)) {
    fail('pinokio_remote_default', 'This app has no admitted native default start script. Choose its start action in Pinokio first.', 'refused')
  }
  const queryIndex = defaultTarget.indexOf('?')
  const uri = path[nativePath.style].normalize(queryIndex < 0 ? defaultTarget : defaultTarget.slice(0, queryIndex))
  const query = queryIndex < 0 ? '' : defaultTarget.slice(queryIndex + 1)
  const script = relativeScript(defaultScript.split('?')[0])
  const relative = path[nativePath.style].relative(nativePath.root, uri).split(path[nativePath.style].sep).join('/')
  const scriptQuery = defaultScript.includes('?') ? defaultScript.slice(defaultScript.indexOf('?') + 1) : ''
  if (relative !== script || scriptQuery !== query || !root.projection.candidates.some((candidate) => candidate.script === script)) {
    fail('pinokio_remote_path', 'The native default script and admitted candidate disagree.', 'refused')
  }
  const input: Record<string, string | string[]> = Object.create(null)
  for (const [key, value] of new URLSearchParams(query)) {
    if (Object.hasOwn(input, key)) input[key] = [...(Array.isArray(input[key]) ? input[key] : [input[key]]), value]
    else input[key] = value
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    contract: 'native-root-v1', userId: context.userId,
    machineId: context.target.id, revision: context.target.revision,
    origin: [context.target.controlProtocol, context.target.controlHost, context.target.controlPort],
    appId: graph.appId, uri, input, script,
    nodes: [...graph.nodes].sort((a, b) => a.status.appId.localeCompare(b.status.appId)).map(({ status, projection }) => ({
      appId: status.appId, nativePath: status.nativePath, launcherRoot: projection.launcherRoot,
      ...(status.appId === graph.appId ? { defaultTarget: status.defaultTarget, defaultScript: status.defaultScript } : {}),
      configuredScript: projection.configuredScript, requires: [...projection.declaredRequires].sort(),
      // Membership/install guards are checked separately on every fresh graph. An
      // unrelated menu item or a dependency's dynamic Open default is not intent.
      selectedUri: status.appId === graph.appId ? uri : path[status.nativePath.style].join(status.nativePath.root, projection.configuredScript)
    }))
  })).digest('hex')
  return { graph, root, script, uri, input: query ? input : undefined, fingerprint }
}

function readOnlyRunning(status: PinokioRemoteNativeStatus): boolean {
  return !status.defaultScript && status.running && (status.runningScripts?.length ?? 0) > 0
}
function runningObservation(context: ReadContext, graph: PinokioRemoteGraph): ObservedPlan {
  const root = graph.nodes.find((node) => node.status.appId === graph.appId)!
  return { graph, root, fingerprint: createHash('sha256').update(JSON.stringify([
    'native-running-observation-v1', context.userId, context.target.id, context.target.revision, graph.appId, root.status.nativePath
  ])).digest('hex') }
}
function preview(plan: ObservedPlan & { script?: string }): PinokioStartPreview {
  const { status } = plan.root
  return {
    ...scopeFromStatus(status), appId: status.appId, title: status.title, state: status.state,
    ready: nativeHttpReady(status, plan.script ?? status.readyScript), alsoStarts: plan.graph.declaredAlsoStarts,
    launchFingerprint: plan.fingerprint, dependencyRead: 'native_projection_unattested'
  }
}
function scopeFromStatus(status: PinokioRemoteNativeStatus): PinokioRemoteScope {
  return { machineId: status.machineId, machineRevision: status.machineRevision, machineLabel: status.machineLabel }
}
function scriptRunning(status: PinokioRemoteNativeStatus, script: string): boolean {
  return status.runningScripts?.includes(script) === true
}
function nativeHttpReady(status: PinokioRemoteNativeStatus, script: string | null): boolean {
  return !!script && status.running && status.ready && status.state === 'online' && scriptRunning(status, script) &&
    status.readyScript === script && status.probe === true && status.externalReadyUrls.length > 0
}
function exactAlsoStarts(supplied: unknown, expected: string[]) {
  if (!Array.isArray(supplied) || supplied.length > MAX_GRAPH_APPS) fail('pinokio_remote_dependencies', 'alsoStarts must name the observed native requirements.', 'refused')
  const actual = [...new Set(supplied.map(appId))].sort()
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    fail('pinokio_remote_dependencies', `Nothing was started. The approval must name exactly these observed native requirements in alsoStarts: ${JSON.stringify(expected)}.`, 'refused')
  }
}

interface StartAttempt {
  fingerprint: string
  uri: string
  nativePath: NativePath
  script: string
  /** May outlive the observer: no automatic retry while native acceptance is uncertain. */
  issued: boolean
  reconciled?: boolean
  nativeControlOutcome?: 'blocked' | 'cancelled'
  nativeError?: boolean
  promise?: Promise<PinokioOutcome<PinokioRunResult>>
}
const startAttempts = new Map<string, StartAttempt>()
const activeStarts = new Set<AbortController>()
const MAX_START_ATTEMPTS = 128
let admissionFences = 0
let admissionEpoch = 0
let shutdownRegistered = false

/** Status can settle only the recorded exact native root/style/script, never an Open URL. */
function reconcileAttempt(context: ReadContext, current: PinokioRemoteNativeStatus) {
  const key = attemptKey(context, current.appId)
  const attempt = startAttempts.get(key)
  if (attempt && attempt.nativePath.style === current.nativePath.style && attempt.nativePath.root === current.nativePath.root &&
    path[current.nativePath.style].join(current.nativePath.root, attempt.script) === attempt.uri && scriptRunning(current, attempt.script)) {
    attempt.reconciled = true
    if (!attempt.promise) startAttempts.delete(key)
  }
}

/** Canonical restore/shutdown owns this synchronous admission fence. It never stops native apps. */
export function fencePinokioRemoteStarts(): () => void {
  admissionFences += 1
  admissionEpoch += 1
  for (const controller of activeStarts) controller.abort()
  let released = false
  return () => { if (!released) { released = true; admissionFences -= 1 } }
}
function checkStart(context: ReadContext, epoch: number) {
  checkActive(context)
  if (admissionFences || epoch !== admissionEpoch) fail('pinokio_remote_start_fenced', 'Pinokio start admission changed. Nothing else was sent.', 'refused')
}
async function admit(context: ReadContext, input: PinokioRemoteStartOptions, epoch: number) {
  checkStart(context, epoch)
  await revalidate(context)
  if (!input.admitStart || await input.admitStart() !== true) fail('pinokio_remote_start_not_admitted', 'This start no longer has its originating owner and approval.', 'refused')
  checkStart(context, epoch)
}
function startResult(context: ReadContext, plan: ObservedPlan, current: PinokioRemoteNativeStatus, startedAt: number,
  launchState: 'ready' | 'pending' | 'unknown', alreadyRunning: boolean): PinokioRunResult {
  const ready = launchState === 'ready'
  return {
    ...scope(context.target), appId: current.appId, title: current.title, alreadyRunning, ready,
    state: current.state, readyUrl: ready ? current.externalReadyUrls[0] : null,
    externalReadyUrls: current.externalReadyUrls, alsoStarted: [], declaredAlsoStarts: plan.graph.declaredAlsoStarts,
    waitedMs: Math.max(0, deps.now() - startedAt), launchState,
    readiness: ready ? 'native_http_probe' : 'unknown', nativeScriptReady: null,
    launchFingerprint: plan.fingerprint, dependencyRead: 'native_projection_unattested',
    message: ready
      ? `${current.title}'s selected script answered Pinokio's HTTP probe. Its advertised address still needs Batshit-side endpoint validation; exact native script completion is not asserted.`
      : launchState === 'pending'
        ? `${current.title}'s native launch is pending. Pinokio owns its requirements and continues after this observation ends. Check status and logs; no second launch was sent.`
        : `${current.title}'s native launch outcome is unknown. It may still be waiting for requirements in Pinokio. Batshit will not automatically resend this uncertain action. Check status and logs.`
  }
}
function uncertainResult(context: ReadContext, plan: ObservedPlan, current: PinokioRemoteNativeStatus, attempt: StartAttempt, startedAt: number) {
  const result = startResult(context, plan, current, startedAt, 'unknown', false)
  if (attempt.nativeControlOutcome) {
    result.nativeControlOutcome = attempt.nativeControlOutcome
    result.message = `Pinokio ${attempt.nativeControlOutcome} this root launch. Some requirements may already have started; no continuation is claimed. Check Pinokio logs. Batshit will not automatically resend this uncertain action.`
  } else if (attempt.nativeError) result.message = `${current.title}'s native launcher reported an error. Some requirements may already have started. Check Pinokio logs; Batshit will not automatically resend this uncertain action.`
  return result
}
async function socketOpen(socket: PinokioNativeSocket, context: ReadContext, epoch: number) {
  checkStart(context, epoch)
  if (socket.readyState === 1) return
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer)
      socket.removeEventListener('open', open)
      socket.removeEventListener('close', closed)
      socket.removeEventListener('error', closed)
      context.signal?.removeEventListener('abort', cancelled)
      if (error) reject(error); else resolve()
    }
    const open = () => done()
    const closed = () => done(new RemoteReadError('pinokio_remote_ws_unavailable', 'The saved Pinokio native connection did not open.', 'unavailable'))
    const cancelled = () => done(new RemoteReadError('pinokio_remote_cancelled', 'The Pinokio start was cancelled before send.', 'refused'))
    const timer = setTimeout(closed, Math.max(1, Math.min(10_000, context.deadline - deps.now())))
    socket.addEventListener('open', open, { once: true })
    socket.addEventListener('close', closed, { once: true })
    socket.addEventListener('error', closed, { once: true })
    context.signal?.addEventListener('abort', cancelled, { once: true })
    if (context.signal?.aborted) cancelled()
    else if (socket.readyState > 1) closed()
  })
  checkStart(context, epoch)
}

async function observeNativeStart(context: ReadContext, input: PinokioRemoteStartOptions, plan: LaunchPlan,
  attempt: StartAttempt, epoch: number, startedAt: number): Promise<PinokioOutcome<PinokioRunResult>> {
  let client: NativeClient | undefined
  let last = plan.root.status
  let sawRelevantPacket = false
  let nativeLaunchError = false
  let terminalControl: 'blocked' | 'cancelled' | null = null
  const terminalResult = () => uncertainResult(context, plan, last, attempt, startedAt)
  let removeMessage: (() => void) | undefined
  try {
    await admit(context, input, epoch)
    const protocol = context.target.controlProtocol === 'https' ? 'wss' : 'ws'
    client = deps.createClient(new URL(`${protocol}://${context.target.controlHost}:${context.target.controlPort}/`))
    await socketOpen(client.socket, context, epoch)
    // Full observed declaration/default/path projection again AFTER the socket opens.
    // These native reads cannot attest hidden ENVIRONMENT read failures, nor lock files.
    const freshGraph = await readGraph(context, plan.graph.appId)
    const freshRoot = freshGraph.nodes.find((node) => node.status.appId === plan.graph.appId)!.status
    if (freshRoot.nativePath.style === plan.root.status.nativePath.style && freshRoot.nativePath.root === plan.root.status.nativePath.root &&
      scriptRunning(freshRoot, plan.script)) {
      await admit(context, input, epoch)
      attempt.reconciled = true
      return { ok: true, value: startResult(context, plan, freshRoot, startedAt, nativeHttpReady(freshRoot, plan.script) ? 'ready' : 'pending', true) }
    }
    const fresh = launchPlan(context, freshGraph)
    if (fresh.fingerprint !== plan.fingerprint) fail('pinokio_remote_plan_changed', 'The native launch plan changed. Nothing was sent; preview it again.', 'refused')
    exactAlsoStarts(input.alsoStarts ?? [], fresh.graph.declaredAlsoStarts)
    await admit(context, input, epoch)
    if (scriptRunning(fresh.root.status, fresh.script)) {
      attempt.reconciled = true
      return { ok: true, value: startResult(context, fresh, fresh.root.status, startedAt, 'pending', true) }
    }
    const socket = client.socket
    const message = (event: { data: unknown }) => {
      if (typeof event.data !== 'string' || event.data.length > 256 * 1024) return
      let packet: unknown
      try { packet = JSON.parse(event.data) } catch { return }
      // Receipt only, NEVER exact-ready/completion. No raw stream reaches callers.
      if (record(packet) && packet.id === fresh.uri && typeof packet.type === 'string') {
        if (packet.type === 'error') { nativeLaunchError = true; attempt.nativeError = true }
        else if (packet.type === 'launch.requirements.control' && record(packet.data) &&
          (packet.data.action === 'blocked' || packet.data.action === 'cancelled')) {
          terminalControl = packet.data.action
          attempt.nativeControlOutcome = packet.data.action
        } else if (['start', 'info', 'launch.requirements', 'launch.requirements.control'].includes(packet.type)) sawRelevantPacket = true
      }
    }
    socket.addEventListener('message', message)
    removeMessage = () => socket.removeEventListener('message', message)
    checkStart(context, epoch)
    if (socket.readyState !== 1) fail('pinokio_remote_ws_unavailable', 'The native connection closed before send. Nothing was sent.', 'unavailable')
    // No await between final admission/cancel check and send. The ONLY effect payload:
    // server-derived native installed script + native query input; requirements ENABLED.
    attempt.issued = true // send() may throw AFTER enqueueing: that is uncertain, never retry.
    socket.send(JSON.stringify({ uri: fresh.uri, ...(fresh.input ? { input: fresh.input } : {}) }))
    last = fresh.root.status
    while (deps.now() < context.deadline) {
      if (nativeLaunchError || terminalControl) break
      await deps.sleep(Math.min(2_000, context.deadline - deps.now()), context.signal)
      if (deps.now() >= context.deadline) break
      checkStart(context, epoch)
      last = await status(context, plan.graph.appId, true)
      // A terminal control/error may arrive while HTTP/status was awaited.
      if (nativeLaunchError || terminalControl) break
      if (last.nativePath.root === fresh.root.status.nativePath.root && last.nativePath.style === fresh.root.status.nativePath.style && scriptRunning(last, fresh.script)) {
        attempt.reconciled = true
        if (nativeHttpReady(last, fresh.script)) return { ok: true, value: startResult(context, fresh, last, startedAt, 'ready', false) }
        sawRelevantPacket = true
      }
    }
    return { ok: true, value: nativeLaunchError || terminalControl ? terminalResult()
      : startResult(context, fresh, last, startedAt, sawRelevantPacket ? 'pending' : 'unknown', false) }
  } catch (error) {
    if (attempt.issued) return { ok: true, value: terminalResult() }
    throw error
  } finally {
    removeMessage?.()
    if (client) await client.dispose().catch(() => {}) // closes only our client; no native stop RPC.
  }
}
function attemptKey(context: ReadContext, id: string) {
  return JSON.stringify([context.userId, context.target.id, context.target.revision, id])
}

/** A joined observer owns only its own wait, never another caller's native flight. */
async function joinAttempt(context: ReadContext, plan: LaunchPlan, attempt: StartAttempt, startedAt: number): Promise<PinokioRunResult> {
  return await new Promise<PinokioRunResult>((resolve, reject) => {
    let settled = false
    const finish = (value?: PinokioRunResult, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', cancelled)
      if (error) reject(error); else resolve(value!)
    }
    const detach = (reason: 'cancelled' | 'timeout') => {
      if (attempt.issued) {
        const result = startResult(context, plan, plan.root.status, startedAt, 'unknown', false)
        result.observationEnded = reason
        result.message = `This observer ${reason === 'cancelled' ? 'was cancelled' : 'reached its wait limit'}. Another admitted caller may still own the native launch. No extra action or native stop was sent; check status and logs.`
        finish(result)
      } else finish(undefined, new RemoteReadError(reason === 'cancelled' ? 'pinokio_remote_cancelled' : 'pinokio_remote_observation_timeout',
        'This observer ended. Another admitted caller may still own the native launch.', reason === 'cancelled' ? 'refused' : 'unavailable'))
    }
    const cancelled = () => detach('cancelled')
    const timer = setTimeout(() => detach('timeout'), Math.max(1, context.deadline - deps.now()))
    context.signal?.addEventListener('abort', cancelled, { once: true })
    void attempt.promise!.then((result) => {
      if (!result.ok) finish(undefined, new RemoteReadError(result.code ?? 'pinokio_remote_start', result.message, result.kind))
      else finish({ ...result.value, waitedMs: Math.max(0, deps.now() - startedAt) })
    }, (error) => finish(undefined, error))
    if (context.signal?.aborted) cancelled()
  })
}

async function startRemote(input: PinokioRemoteStartOptions): Promise<PinokioOutcome<PinokioRunResult>> {
  const startedAt = deps.now()
  const epoch = admissionEpoch
  const controller = new AbortController()
  const cancel = () => controller.abort()
  input.signal?.addEventListener('abort', cancel, { once: true })
  if (input.signal?.aborted) cancel()
  activeStarts.add(controller)
  if (!shutdownRegistered) {
    registerRuntimeShutdownTask('pinokio-remote-clients', () => { fencePinokioRemoteStarts() })
    shutdownRegistered = true
  }
  try {
    return await outcome({ ...input, signal: controller.signal }, async (context) => {
      if (!Number.isSafeInteger(input.revision) || !input.launchFingerprint || !/^[a-f0-9]{64}$/.test(input.launchFingerprint) ||
        typeof input.admitStart !== 'function' || (input.waitSeconds !== undefined && !Number.isFinite(input.waitSeconds))) {
        fail('pinokio_remote_start_input', 'Remote starts require the freshly previewed target revision, launch fingerprint and server-owned admission.', 'refused')
      }
      context.deadline = startedAt + Math.min(50, Math.max(5, Math.round(input.waitSeconds ?? 45))) * 1000
      checkStart(context, epoch)
      const graph = await readGraph(context, appId(input.appId))
      const rootStatus = graph.nodes.find((node) => node.status.appId === graph.appId)!.status
      reconcileAttempt(context, rootStatus)
      // This is a read-only no-op. A normal running menu swaps Start for an Open
      // HTTP link; that link never becomes dispatch authority or a fallback script.
      if (readOnlyRunning(rootStatus)) {
        await admit(context, input, epoch)
        const current = await status(context, graph.appId, true)
        reconcileAttempt(context, current)
        if (current.nativePath.root !== rootStatus.nativePath.root || current.nativePath.style !== rootStatus.nativePath.style || !readOnlyRunning(current)) {
          fail('pinokio_remote_running_changed', 'The running app changed during observation. Preview it again; no start was sent.', 'refused')
        }
        const unresolved = startAttempts.get(attemptKey(context, graph.appId))
        if (unresolved?.issued && !unresolved.reconciled) {
          return uncertainResult(context, runningObservation(context, graph), current, unresolved, startedAt)
        }
        return startResult(context, runningObservation(context, graph), current, startedAt, nativeHttpReady(current, current.readyScript) ? 'ready' : 'pending', true)
      }
      const plan = launchPlan(context, graph)
      if (plan.fingerprint !== input.launchFingerprint) fail('pinokio_remote_plan_changed', 'The native launch plan changed. Nothing was sent; preview it again.', 'refused')
      exactAlsoStarts(input.alsoStarts ?? [], plan.graph.declaredAlsoStarts)
      await admit(context, input, epoch)
      const key = attemptKey(context, plan.graph.appId)
      const existing = startAttempts.get(key)
      if (existing?.promise) {
        if (existing.fingerprint !== plan.fingerprint) fail('pinokio_remote_start_in_flight', 'A different native launch is already being observed for this app.', 'refused')
        return await joinAttempt(context, plan, existing, startedAt)
      }
      if (scriptRunning(plan.root.status, plan.script)) {
        const current = await status(context, plan.graph.appId, true)
        reconcileAttempt(context, current)
        if (current.nativePath.root !== plan.root.status.nativePath.root || current.nativePath.style !== plan.root.status.nativePath.style) {
          fail('pinokio_remote_running_changed', 'The running native folder changed during observation. No start was sent.', 'refused')
        }
        return startResult(context, plan, current, startedAt, nativeHttpReady(current, plan.script) ? 'ready' : 'pending', true)
      }
      if (existing?.issued) return uncertainResult(context, plan, plan.root.status, existing, startedAt)
      if (startAttempts.size >= MAX_START_ATTEMPTS) fail('pinokio_remote_start_capacity', 'Too many native launches have unresolved outcomes. No start was sent. Check their status before trying another app.', 'refused')
      const attempt: StartAttempt = { fingerprint: plan.fingerprint, uri: plan.uri, nativePath: plan.root.status.nativePath, script: plan.script, issued: false }
      startAttempts.set(key, attempt)
      const run = observeNativeStart(context, input, plan, attempt, epoch, startedAt)
      attempt.promise = run
      try { return unwrapStart(await run) } finally {
        attempt.promise = undefined
        if (!attempt.issued || attempt.reconciled) startAttempts.delete(key)
      }
    }, false)
  } finally {
    input.signal?.removeEventListener('abort', cancel)
    activeStarts.delete(controller)
  }
}
function unwrapStart(result: PinokioOutcome<PinokioRunResult>): PinokioRunResult {
  if (!result.ok) fail(result.code ?? 'pinokio_remote_start', result.message, result.kind)
  return result.value
}

export const pinokioRemoteProvider = {
  previewStart(input: PinokioReadTargetOptions & { appId: string }): Promise<PinokioOutcome<PinokioStartPreview>> {
    return outcome(input, async (context) => {
      const graph = await readGraph(context, appId(input.appId))
      const current = graph.nodes.find((node) => node.status.appId === graph.appId)!.status
      reconcileAttempt(context, current)
      return preview(readOnlyRunning(current) ? runningObservation(context, graph) : launchPlan(context, graph))
    })
  },

  start: startRemote,

  detect(input: PinokioReadTargetOptions): Promise<PinokioOutcome<PinokioRemoteDetection>> {
    return outcome(input, async (_context, detection) => detection)
  },

  appStatus(input: PinokioReadTargetOptions & { appId: string; probe?: boolean }) {
    return outcome(input, async (context) => {
      const current = await status(context, appId(input.appId), input.probe !== false)
      reconcileAttempt(context, current)
      return current
    })
  },

  candidates(input: PinokioReadTargetOptions & { appId: string }) {
    return outcome(input, async (context) => candidates(context, await status(context, appId(input.appId))))
  },

  search(input: PinokioReadTargetOptions & { query?: string; limit?: number }): Promise<PinokioOutcome<PinokioSearchResult & PinokioRemoteScope>> {
    return outcome(input, async (context) => {
      const query = input.query === undefined ? '' : text(input.query, 'search query', 500).trim()
      const limit = input.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('pinokio_remote_input', 'Choose an app search limit from 1 to 100.', 'refused')
      const value = await readJson(context, '/apps/search', { q: query, limit: String(limit), peer_scope: 'local', include_peers: '0' })
      if (!Array.isArray(value.apps) || value.apps.length > 1000 || typeof value.q !== 'string') fail('pinokio_remote_shape', 'Pinokio returned unrecognised installed apps.')
      const seen = new Set<string>()
      const apps = value.apps.map((entry) => {
        if (!record(entry)) fail('pinokio_remote_shape', 'Pinokio returned an unrecognised installed app.')
        sourceLocal(entry)
        const id = appId(entry.app_id)
        if (seen.has(id)) fail('pinokio_remote_shape', 'Pinokio returned duplicate installed app IDs.')
        seen.add(id)
        checkRef(entry.ref, id)
        const state = text(entry.state, 'app state')
        if (!STATES.has(state)) fail('pinokio_remote_shape', 'Pinokio returned an unrecognised app state.')
        return {
          appId: id, title: clean(text(entry.title, 'app title')), description: entry.description === null ? null : clean(text(entry.description, 'app description'), 240),
          state: state as PinokioAppStatus['state'], running: bool(entry.running, 'running state'), ready: bool(entry.ready, 'ready state'), readyUrl: nullableText(entry.ready_url, 'ready URL')
        }
      })
      return { ...scope(context.target), query: value.q, apps, skippedRemote: 0 }
    })
  },

  logs(input: PinokioReadTargetOptions & { appId: string; tail?: number }): Promise<PinokioOutcome<PinokioLogs & PinokioRemoteScope>> {
    return outcome(input, async (context) => {
      const id = appId(input.appId)
      const tail = input.tail ?? 50
      if (!Number.isInteger(tail) || tail < 1 || tail > 500) fail('pinokio_remote_input', 'Choose a log tail from 1 to 500 lines.', 'refused')
      await status(context, id)
      const value = await readJson(context, `/apps/logs/${encodeURIComponent(id)}`, { tail: String(tail) })
      exactApp(value.app_id, id)
      // Unlike status/search, this node-local route returns the log kind. Peer-forwarded
      // logs replace it with a source object; those must not pass this fixed-node read.
      if (value.source !== 'api' && value.source !== 'shell') {
        fail('pinokio_remote_source', 'Pinokio returned an unrecognised or peer-forwarded app log source.', 'refused')
      }
      checkRef(value.ref, id)
      if (!Array.isArray(value.lines) || value.lines.length > 5000 || !value.lines.every((line) => typeof line === 'string') ||
        (value.line_count !== null && (!Number.isSafeInteger(value.line_count) || (value.line_count as number) < 0))) {
        fail('pinokio_remote_shape', 'Pinokio returned unrecognised app log lines.')
      }
      const lines: string[] = []
      let chars = 0
      let truncated = false
      for (const line of value.lines.slice(-tail).reverse()) {
        const trimmed = clean(line as string)
        if (trimmed.length !== (line as string).length) truncated = true
        if (chars + trimmed.length > 16_000) { truncated = true; break }
        chars += trimmed.length
        lines.unshift(trimmed)
      }
      return { ...scope(context.target), appId: id, script: nullableText(value.script, 'log script'), lineCount: value.line_count as number | null, lines, truncated }
    })
  },

  graph(input: PinokioReadTargetOptions & { appId: string }): Promise<PinokioOutcome<PinokioRemoteGraph>> {
    return outcome(input, async (context) => {
      return readGraph(context, appId(input.appId))
    })
  }
}
