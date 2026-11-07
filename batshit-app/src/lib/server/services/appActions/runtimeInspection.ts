import {
  RUNTIME_INSPECTION_BUDGET_MS, RUNTIME_INSPECTION_BYTE_LIMIT, RUNTIME_INSPECTION_CLI_PHASES,
  RUNTIME_INSPECTION_SIDECAR_STATES, RUNTIME_INSPECTION_SOURCE_IDS,
  isRuntimeInspectionReport, normalizeRuntimeInspectionVersion, runtimePinComparison,
  type CloudflaredInspection, type ManagedCliInspection, type RuntimeInspectionContext,
  type RuntimeInspectionReport, type RuntimeInspectionRow, type RuntimeInspectionSourceId,
  type RuntimeInspectionUnknownReason, type RuntimeOperatorInspection
} from '$lib/appActions/runtimeInspection'
import type { AdapterContext } from './managementTypes'
import { AppActionsManagementRefusal } from './settings/authority'
import { resolveRuntimeContext, type RuntimeContext } from '../runtimeContext'
import { getCloudflaredRuntimeStatus, resolveCloudflaredInstallDir } from '../cloudflaredRuntime'
import { getManagedCliInstallStatus, MANAGED_CLI_PINNED_VERSIONS, resolveManagedCliRoot } from '../managedCliInstaller'
import { getRuntimeAddonOperatorStatus } from '../runtimeAddons'

type SourceData = CloudflaredInspection | ManagedCliInspection | RuntimeOperatorInspection
type Configuration = readonly unknown[]
type ConfigurationStamp = { values: Configuration; revision: number }
type PendingRead = { stamp: ConfigurationStamp; startedAt: number; promise: Promise<Observation> }
type Observation = { row: RuntimeInspectionRow; stamp?: ConfigurationStamp }
export type RuntimeInspectionSources = {
  context(): RuntimeContext
  platform(): string
  architecture(): string
  configuration(id: RuntimeInspectionSourceId): Configuration
  read: Record<RuntimeInspectionSourceId, () => Promise<unknown>>
}

const defaultSources: RuntimeInspectionSources = {
  context: resolveRuntimeContext,
  platform: () => process.platform,
  architecture: () => process.arch,
  configuration(id) {
    if (id === 'claude') {
      return [resolveManagedCliRoot(), id, MANAGED_CLI_PINNED_VERSIONS[id], process.platform, process.arch, process.env.PATH]
    }
    if (id === 'cloudflared') {
      return [resolveCloudflaredInstallDir(), process.env.BATSHIT_CLOUDFLARED_BIN, process.env.PATH, process.env.PATHEXT,
        process.env.BATSHIT_CONTAINERIZED, process.env.BATSHIT_RUNTIME_ENV, process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH,
        process.cwd(), process.platform, process.arch]
    }
    // Only private equality checks retain this tuple. Never serialize it, its
    // digest, or an exception from a source/configuration reader.
    return [process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL?.trim() || process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL?.trim(),
      process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN?.trim() || process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN?.trim(),
      process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TIMEOUT_MS]
  },
  read: {
    cloudflared: getCloudflaredRuntimeStatus,
    claude: () => getManagedCliInstallStatus('claude'),
    'runtime-addon-operator': getRuntimeAddonOperatorStatus
  }
}

function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}
function member(value: unknown, values: readonly unknown[]): boolean { return values.includes(value) }
function nullableText(value: unknown): boolean { return value === null || typeof value === 'string' }
function unknownRow(id: RuntimeInspectionSourceId, reason: RuntimeInspectionUnknownReason): RuntimeInspectionRow {
  return { id, status: 'unknown', reason, observedFrom: null, observedAt: null, data: null }
}
function projectContext(source: RuntimeContext, platform: string, architecture: string): RuntimeInspectionContext | null {
  if (!source || !member(source.mode, ['mac-app', 'docker', 'native']) || typeof source.pinokio !== 'boolean' || typeof source.windowsWsl !== 'boolean') return null
  return {
    mode: source.mode,
    distribution: source.mode === 'mac-app' ? 'mac-app' : source.mode === 'docker' ? 'docker' :
      source.pinokio ? source.windowsWsl ? 'pinokio-windows-wsl' : 'pinokio' : 'source-checkout',
    platform: member(platform, ['darwin', 'linux', 'win32']) ? platform as RuntimeInspectionContext['platform'] : 'other',
    architecture: member(architecture, ['arm64', 'x64']) ? architecture as RuntimeInspectionContext['architecture'] : 'other'
  }
}
function projectCloudflared(value: unknown): CloudflaredInspection | null {
  const source = object(value)
  const tunnel = object(source?.tunnel)
  if (!source || !tunnel || typeof source.installed !== 'boolean' || typeof source.managedInstallPresent !== 'boolean' ||
    !member(source.supportLevel, ['native-managed', 'docker-deferred', 'docker-sidecar']) ||
    !member(source.installScope, ['none', 'batshit-managed', 'system', 'docker-sidecar']) ||
    !nullableText(source.version) || typeof source.testedVersion !== 'string' || typeof tunnel.running !== 'boolean' ||
    !nullableText(tunnel.publicUrl) || !nullableText(tunnel.lastError)) return null
  const sidecar = source.dockerSidecar === null || source.dockerSidecar === undefined ? null : object(source.dockerSidecar)
  if (source.dockerSidecar != null && (!sidecar || typeof sidecar.stale !== 'boolean' || !member(sidecar.status, RUNTIME_INSPECTION_SIDECAR_STATES))) return null
  const native = source.supportLevel === 'native-managed'
  const version = normalizeRuntimeInspectionVersion(source.version)
  const testedVersion = normalizeRuntimeInspectionVersion(source.testedVersion)
  return {
    kind: 'cloudflared',
    owner: source.installScope === 'none' ? 'unverified' : source.installScope,
    executableProbe: !native ? 'not_applicable' : source.installed ? 'passed' : 'not_verified',
    managedInstallReported: source.managedInstallPresent,
    version, testedVersion, pinComparison: runtimePinComparison(version, testedVersion),
    tunnel: {
      processReported: native ? tunnel.running : null,
      urlReported: typeof tunnel.publicUrl === 'string' && tunnel.publicUrl.length > 0,
      issueReported: typeof tunnel.lastError === 'string' && tunnel.lastError.length > 0,
      sidecarState: sidecar?.status ?? null,
      stale: sidecar?.stale ?? null,
      readiness: 'not_verified'
    }
  }
}
function projectCli(id: 'claude', value: unknown): ManagedCliInspection | null {
  const source = object(value)
  if (!source || source.runtime !== id || typeof source.supported !== 'boolean' || typeof source.installed !== 'boolean' ||
    !nullableText(source.version) || typeof source.pinnedVersion !== 'string') return null
  let operation: ManagedCliInspection['operation'] = { evidence: 'not_reported', kind: null, phase: null }
  if (source.operation !== null) {
    const op = object(source.operation)
    if (!op || op.runtime !== id || !member(op.operation, ['install', 'reinstall', 'uninstall']) ||
      !member(op.phase, RUNTIME_INSPECTION_CLI_PHASES) || typeof op.startedAt !== 'string' || !Number.isFinite(Date.parse(op.startedAt))) return null
    // The existing owner uses epoch time when a lock's operation record is
    // unreadable. Preserve that uncertainty instead of inventing an install.
    operation = Date.parse(op.startedAt) === 0 ? { evidence: 'unverified', kind: null, phase: null } :
      { evidence: 'reported', kind: op.operation, phase: op.phase }
  }
  const version = normalizeRuntimeInspectionVersion(source.version)
  const pinnedVersion = normalizeRuntimeInspectionVersion(source.pinnedVersion)
  return { kind: 'managed-cli', supported: source.supported, managedFiles: source.installed ? 'reported_present' : 'not_confirmed',
    version, pinnedVersion, pinComparison: runtimePinComparison(version, pinnedVersion), operation,
    proof: 'managed_files_only', readiness: 'not_checked' }
}
function projectSource(id: RuntimeInspectionSourceId, value: unknown): SourceData | null {
  if (id === 'cloudflared') return projectCloudflared(value)
  if (id === 'claude') return projectCli(id, value)
  const source = object(value)
  return source && typeof source.configured === 'boolean' && typeof source.available === 'boolean'
    ? { kind: 'runtime-addon-operator', configured: source.configured, healthReported: source.available, proof: 'health_response_only' } : null
}
function sameConfiguration(left: Configuration, right: Configuration): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}
function deadlineRefusal() {
  return new AppActionsManagementRefusal('RUNTIME_INSPECTION_DEADLINE', 'The runtime report deadline elapsed. No management action was issued.', 409)
}
async function within<T>(start: () => Promise<T>, deadlineAt: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new AppActionsManagementRefusal('CONTROL_CANCELLATION_REQUIRED', 'This exact reply has ended or stopped.')
  if (Date.now() >= deadlineAt) throw deadlineRefusal()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(deadlineRefusal()), deadlineAt - Date.now())
    onAbort = () => reject(new AppActionsManagementRefusal('CONTROL_CANCELLATION_REQUIRED', 'This exact reply has ended or stopped.'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  const work = Promise.resolve().then(() => {
    if (signal?.aborted) throw new AppActionsManagementRefusal('CONTROL_CANCELLATION_REQUIRED', 'This exact reply has ended or stopped.')
    if (Date.now() >= deadlineAt) throw deadlineRefusal()
    return start()
  })
  try { return await Promise.race([work, interrupted]) }
  finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/** Fixed sources only; the factory seam reuses existing reader fixtures. */
export function createRuntimeInspectionReader(sources: RuntimeInspectionSources = defaultSources) {
  const pending = new Map<RuntimeInspectionSourceId, PendingRead>()
  const configurations = new Map<RuntimeInspectionSourceId, ConfigurationStamp>()
  function runtime() { return projectContext(sources.context(), sources.platform(), sources.architecture()) }
  function stamp(id: RuntimeInspectionSourceId): ConfigurationStamp {
    const current = runtime()
    if (!current) throw new Error('context_unavailable')
    const values = [current.mode, current.distribution, current.platform, current.architecture, ...sources.configuration(id)]
    const before = configurations.get(id)
    if (before && sameConfiguration(before.values, values)) return before
    const next = { values, revision: (before?.revision ?? 0) + 1 }
    configurations.set(id, next)
    return next
  }
  async function observe(id: RuntimeInspectionSourceId, readDeadlineAt: number, ctx: AdapterContext): Promise<Observation> {
    ctx.assertCurrent()
    if (Date.now() >= readDeadlineAt) return { row: unknownRow(id, 'source_deadline') }
    let captured: ConfigurationStamp
    try { captured = stamp(id) }
    catch { return { row: unknownRow(id, 'context_unavailable') } }
    const held = pending.get(id)
    if (held) return { row: unknownRow(id, held.stamp === captured ? 'source_pending' : 'configuration_changed') }
    const startedAt = Date.now()
    const slot: PendingRead = { stamp: captured, startedAt, promise: undefined! }
    let actorRefused = false
    let actorRefusal: unknown
    // A slot is held until the actual source settles, even after report Stop or
    // timeout. Config changes cannot open another slot or adopt its old result.
    pending.set(id, slot)
    slot.promise = Promise.resolve().then(() => {
      try { ctx.assertCurrent() }
      catch (error) { actorRefused = true; actorRefusal = error; throw error }
      if (Date.now() >= readDeadlineAt || ctx.signal?.aborted || stamp(id) !== captured) return null
      return sources.read[id]()
    }).then(value => {
      try {
        if (stamp(id) !== captured) return { row: unknownRow(id, 'configuration_changed') }
        const data = projectSource(id, value)
        if (!data) return { row: unknownRow(id, 'malformed_source') }
        const row = { id, status: 'observed', reason: null, observedFrom: new Date(startedAt).toISOString(),
          observedAt: new Date().toISOString(), data } as RuntimeInspectionRow
        return { row, stamp: captured }
      } catch { return { row: unknownRow(id, 'source_failed') } }
    }, () => {
      if (actorRefused) throw actorRefusal
      return { row: unknownRow(id, 'source_failed') }
    }).finally(() => {
      if (pending.get(id) === slot) pending.delete(id)
    })
    // The caller may refuse before within ever joins. Observe custody's
    // rejection independently; keep the original promise/error for its caller.
    void slot.promise.catch(() => {})
    try {
      const result = await within(() => slot.promise, readDeadlineAt, ctx.signal)
      ctx.assertCurrent()
      return result
    } catch (error) {
      // Authority/Stop failures are request refusals, never source unknowns.
      if (error instanceof AppActionsManagementRefusal && error.code === 'RUNTIME_INSPECTION_DEADLINE') {
        ctx.assertCurrent()
        return { row: unknownRow(id, 'source_deadline') }
      }
      throw error
    }
  }
  return async function read(ctx: AdapterContext): Promise<RuntimeInspectionReport> {
    const deadlineAt = Math.min(ctx.deadlineAt, Date.now() + RUNTIME_INSPECTION_BUDGET_MS)
    ctx.assertCurrent()
    await within(() => ctx.refreshAuthority(), deadlineAt, ctx.signal)
    ctx.assertCurrent()
    let context: RuntimeInspectionContext | null
    try { context = runtime() } catch { context = null }
    // Leave a bounded part of the same response budget for final authority.
    const remaining = Math.max(0, deadlineAt - Date.now())
    const readDeadlineAt = deadlineAt - Math.min(2_000, remaining / 4)
    const observations = await Promise.all(RUNTIME_INSPECTION_SOURCE_IDS.map(id => {
      if (!context) return Promise.resolve({ row: unknownRow(id, 'context_unavailable') } as Observation)
      if (id === 'runtime-addon-operator' && context.mode !== 'docker') return Promise.resolve({ row: {
        id, status: 'not_applicable', reason: null, observedFrom: null, observedAt: null, data: null
      } } as Observation)
      return observe(id, readDeadlineAt, ctx)
    }))
    ctx.assertCurrent()
    await within(() => ctx.refreshAuthority(), deadlineAt, ctx.signal)
    ctx.assertCurrent()
    // Final config check is after the last authority await. The private stamp's
    // revision also rejects observed A→B→A changes; unobserved file replacement
    // is not an atomic source snapshot, so output claims an observation window.
    let finalContext: RuntimeInspectionContext | null
    try { finalContext = runtime() } catch { finalContext = null }
    const rows = observations.map(({ row, stamp: captured }) => {
      if (row.status === 'not_applicable' && context?.mode !== finalContext?.mode) return unknownRow(row.id, 'configuration_changed')
      if (!captured) return row
      try { return stamp(row.id) === captured ? row : unknownRow(row.id, 'configuration_changed') }
      catch { return unknownRow(row.id, 'configuration_changed') }
    })
    if (Date.now() >= deadlineAt) throw deadlineRefusal()
    ctx.assertCurrent()
    const report: RuntimeInspectionReport = { version: 1, domain: 'runtime-inspection', scope: 'this-instance',
      reportedAt: new Date().toISOString(), runtime: finalContext, rows }
    if (!isRuntimeInspectionReport(report) || Buffer.byteLength(JSON.stringify(report), 'utf8') > RUNTIME_INSPECTION_BYTE_LIMIT) {
      throw new AppActionsManagementRefusal('RUNTIME_INSPECTION_UNAVAILABLE', 'The masked runtime report is unavailable.', 503)
    }
    return report
  }
}

export const readRuntimeStatus = createRuntimeInspectionReader()
