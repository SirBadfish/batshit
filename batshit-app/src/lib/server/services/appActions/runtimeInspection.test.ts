import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { isRuntimeInspectionReport } from '$lib/appActions/runtimeInspection'
import type { AdapterContext } from './managementTypes'

const mocks = vi.hoisted(() => ({
  context: vi.fn(), cloud: vi.fn(), cli: vi.fn(), operator: vi.fn(),
  start: vi.fn(), install: vi.fn(), aggregate: vi.fn(), prepare: vi.fn(), control: vi.fn()
}))
vi.mock('$lib/server/redis', () => ({ redis: {} }))
vi.mock('../runtimeContext', () => ({ resolveRuntimeContext: mocks.context }))
vi.mock('../cloudflaredRuntime', () => ({
  getCloudflaredRuntimeStatus: mocks.cloud, resolveCloudflaredInstallDir: () => '/private/runtime',
  ensureManagedCloudflaredTunnel: mocks.start, installCloudflaredRuntime: mocks.install
}))
vi.mock('../managedCliInstaller', () => ({
  getManagedCliInstallStatus: mocks.cli, resolveManagedCliRoot: () => '/private/cli',
  MANAGED_CLI_PINNED_VERSIONS: { claude: '2.1.296' }
}))
vi.mock('../runtimeAddons', () => ({
  getRuntimeAddonOperatorStatus: mocks.operator, listRuntimeAddons: mocks.aggregate,
  prepareRuntimeAddon: mocks.prepare, controlRuntimeAddon: mocks.control
}))

import { AppActionsManagementRefusal } from './settings/authority'
import { createRuntimeInspectionReader, readRuntimeStatus, type RuntimeInspectionSources } from './runtimeInspection'

const nativeContext = () => ({ mode: 'native', label: '/secret label', macApp: false, containerized: false, pinokio: false,
  windowsWsl: false, localVoiceEngineStopPolicy: 'per-engine', runtimeOwner: '/secret owner', runtimeEnv: '/secret env',
  adminCards: { macAppRequiredRuntime: false, appleContainerSandbox: false, dockerSandbox: true } } as const)
function cloud() {
  return { installed: true, supported: true, supportLevel: 'native-managed', installScope: 'system', managedInstallPresent: false,
    version: '2026.3.0', testedVersion: '2026.3.0', command: '/secret command', manifest: { token: 'never-print' },
    tunnel: { running: true, publicUrl: 'https://secret.trycloudflare.com', targetUrl: 'http://private-target', pid: 123,
      lastError: 'private error', startedAt: 'private timestamp' }, dockerSidecar: null }
}
function cli(runtime: 'claude') {
  return { runtime, supported: true, installed: true, version: '2.1.296',
    pinnedVersion: '2.1.296', operation: null,
    executablePath: '/secret binary', installRoot: '/secret root', manifest: { sourceUrl: 'https://secret', integrity: 'private hash' } }
}
function context(signal?: AbortSignal): AdapterContext {
  const policy = { ...defaultAppActionsPolicy(true), enabled: true }
  return { admission: { actor: { userId: 'user', kind: 'portable', id: 'token', generation: 2, label: 'Token' },
    policy, fence: { key: 'private-authority', paths: [] } }, signal, deadlineAt: Date.now() + 20_000,
    refreshAuthority: vi.fn(async () => {}), assertCurrent: vi.fn(() => {
      if (signal?.aborted) throw new AppActionsManagementRefusal('CONTROL_CANCELLATION_REQUIRED', 'stopped')
    }) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function sources() {
  const configs = { cloudflared: 'A', claude: 'A', 'runtime-addon-operator': 'A' }
  const value: RuntimeInspectionSources = {
    context: () => nativeContext(), platform: () => 'darwin', architecture: () => 'arm64', configuration: id => [configs[id]],
    read: { cloudflared: vi.fn(async () => cloud()),
      claude: vi.fn(async () => cli('claude')), 'runtime-addon-operator': vi.fn(async () => ({ configured: true, available: true })) }
  }
  return { value, configs }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.context.mockReturnValue(nativeContext())
  mocks.cloud.mockResolvedValue(cloud())
  mocks.cli.mockImplementation(async id => cli(id))
  mocks.operator.mockResolvedValue({ configured: true, available: true, url: 'https://secret', details: { token: 'private' } })
})
afterEach(() => vi.useRealTimers())

describe('finite runtime inspection reader', () => {
  it('binds only the actual finite readers and projects their real status shapes without effects or raw fields', async () => {
    const report = await readRuntimeStatus(context())
    expect(isRuntimeInspectionReport(report)).toBe(true)
    expect(mocks.cloud).toHaveBeenCalledExactlyOnceWith()
    expect(mocks.cli.mock.calls).toEqual([['claude']])
    expect(mocks.operator).not.toHaveBeenCalled()
    for (const effect of [mocks.start, mocks.install, mocks.aggregate, mocks.prepare, mocks.control]) expect(effect).not.toHaveBeenCalled()
    expect(report.rows[0]).toMatchObject({ status: 'observed', data: { owner: 'system', executableProbe: 'passed',
      tunnel: { processReported: true, urlReported: true, issueReported: true, readiness: 'not_verified' } } })
    expect(report.rows[1]).toMatchObject({ data: { managedFiles: 'reported_present', proof: 'managed_files_only', readiness: 'not_checked' } })
    expect(report.rows[2]).toMatchObject({ status: 'not_applicable', data: null, observedAt: null })
    const text = JSON.stringify(report)
    for (const secret of ['secret', 'private', 'never-print', '"pid"', 'command', 'sourceUrl', 'integrity']) expect(text).not.toContain(secret)
  })

  it('reports Docker heartbeat/operator evidence without claiming a binary install, controls or Clip readiness', async () => {
    const { value } = sources()
    value.context = () => ({ ...nativeContext(), mode: 'docker', containerized: true })
    value.read.cloudflared = async () => ({ ...cloud(), installed: false, supportLevel: 'docker-sidecar', installScope: 'docker-sidecar',
      version: '2026.3.0\nprivate', dockerSidecar: { status: 'stopped', stale: true }, tunnel: { running: false, publicUrl: null, lastError: 'private' } })
    value.read['runtime-addon-operator'] = async () => ({ configured: true, available: false, controls: ['start', 'stop'], details: { token: 'private' } })
    const report = await createRuntimeInspectionReader(value)(context())
    expect(report.rows[0]).toMatchObject({ data: { owner: 'docker-sidecar', executableProbe: 'not_applicable', version: null,
      pinComparison: 'unknown', tunnel: { processReported: null, sidecarState: 'stopped', stale: true, readiness: 'not_verified' } } })
    expect(report.rows[2]).toMatchObject({ data: { configured: true, healthReported: false, proof: 'health_response_only' } })
    expect(JSON.stringify(report)).not.toMatch(/private|controls|start|stop"/)
  })

  it('preserves uncertain inventory/lock evidence and rejects malformed or failed sources without their raw errors', async () => {
    const { value } = sources()
    value.read.cloudflared = async () => { throw new Error('private source failure') }
    value.read.claude = async () => ({ ...cli('claude'), installed: false, version: null,
      operation: { runtime: 'claude', operation: 'install', phase: 'starting', startedAt: new Date(0).toISOString() } })
    const report = await createRuntimeInspectionReader(value)(context())
    expect(report.rows[0]).toMatchObject({ status: 'unknown', reason: 'source_failed', data: null, observedAt: null })
    expect(report.rows[1]).toMatchObject({ status: 'observed', data: { managedFiles: 'not_confirmed', version: null,
      operation: { evidence: 'unverified', kind: null, phase: null } } })
    value.read.claude = async () => ({ ...cli('claude'), installed: 'private malformed' })
    const malformed = await createRuntimeInspectionReader(value)(context())
    expect(malformed.rows[1]).toMatchObject({ status: 'unknown', reason: 'malformed_source', observedAt: null })
    expect(JSON.stringify([report, malformed])).not.toContain('private')
  })

  it('keeps the one pending source owned after timeout and never gives its old observation to a new caller', async () => {
    vi.useFakeTimers()
    const held = deferred<unknown>()
    const { value } = sources()
    value.read.cloudflared = vi.fn(() => held.promise)
    const read = createRuntimeInspectionReader(value)
    const original = read(context())
    await vi.advanceTimersByTimeAsync(18_001)
    const report = await original
    expect(report.rows[0]).toMatchObject({ status: 'unknown', reason: 'source_deadline', observedFrom: null, observedAt: null, data: null })
    const joined = await read(context())
    expect(joined.rows[0]).toMatchObject({ status: 'unknown', reason: 'source_pending', observedAt: null, data: null })
    expect(value.read.cloudflared).toHaveBeenCalledTimes(1)
    const frozen = JSON.stringify(report)
    held.resolve(cloud())
    await vi.runAllTimersAsync()
    expect(JSON.stringify(report)).toBe(frozen)
    await read(context())
    expect(value.read.cloudflared).toHaveBeenCalledTimes(2)
  })

  it('invalidates an observed configuration A→B→A without opening another pending slot', async () => {
    const held = deferred<unknown>()
    const { value, configs } = sources()
    value.read.cloudflared = vi.fn(() => held.promise)
    const read = createRuntimeInspectionReader(value)
    const first = read(context())
    await vi.waitFor(() => expect(value.read.cloudflared).toHaveBeenCalledTimes(1))
    configs.cloudflared = 'B'
    expect((await read(context())).rows[0]).toMatchObject({ status: 'unknown', reason: 'configuration_changed' })
    configs.cloudflared = 'A'
    expect((await read(context())).rows[0]).toMatchObject({ status: 'unknown', reason: 'configuration_changed' })
    held.resolve(cloud())
    expect((await first).rows[0]).toMatchObject({ status: 'unknown', reason: 'configuration_changed', observedFrom: null, observedAt: null })
    expect(value.read.cloudflared).toHaveBeenCalledTimes(1)
  })

  it('checks source identity after the last awaited authority refresh', async () => {
    const { value, configs } = sources()
    const refreshHeld = deferred<void>()
    const ctx = context()
    vi.mocked(ctx.refreshAuthority).mockResolvedValueOnce(undefined).mockImplementationOnce(() => refreshHeld.promise)
    const pending = createRuntimeInspectionReader(value)(ctx)
    await vi.waitFor(() => expect(ctx.refreshAuthority).toHaveBeenCalledTimes(2))
    configs.cloudflared = 'new selected command'
    refreshHeld.resolve()
    expect((await pending).rows[0]).toMatchObject({ status: 'unknown', reason: 'configuration_changed', data: null })
  })

  it('propagates initial/final authority refusals and preserves original Stop while a source remains owned', async () => {
    const { value } = sources()
    const refusal = new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'changed')
    const refused = context()
    vi.mocked(refused.refreshAuthority).mockRejectedValueOnce(refusal)
    await expect(createRuntimeInspectionReader(value)(refused)).rejects.toBe(refusal)
    expect(value.read.cloudflared).not.toHaveBeenCalled()
    const final = context()
    vi.mocked(final.refreshAuthority).mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal)
    await expect(createRuntimeInspectionReader(value)(final)).rejects.toBe(refusal)

    const held = deferred<unknown>()
    value.read.cloudflared = vi.fn(() => held.promise)
    const read = createRuntimeInspectionReader(value)
    const stop = new AbortController()
    const stopped = read(context(stop.signal))
    const stoppedAssertion = expect(stopped).rejects.toMatchObject({ code: 'CONTROL_CANCELLATION_REQUIRED' })
    await vi.waitFor(() => expect(value.read.cloudflared).toHaveBeenCalledTimes(1))
    stop.abort()
    await stoppedAssertion
    expect((await read(context())).rows[0]).toMatchObject({ reason: 'source_pending', data: null })
    expect(value.read.cloudflared).toHaveBeenCalledTimes(1)
    held.reject(new Error('private late error'))
    await Promise.resolve()
  })

  it('bounds a stalled authority refresh by the inherited deadline without starting readers', async () => {
    vi.useFakeTimers()
    const { value } = sources()
    const held = deferred<void>()
    const ctx = { ...context(), deadlineAt: Date.now() + 1000 }
    vi.mocked(ctx.refreshAuthority).mockImplementation(() => held.promise)
    const pending = createRuntimeInspectionReader(value)(ctx)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'RUNTIME_INSPECTION_DEADLINE' })
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    expect(value.read.cloudflared).not.toHaveBeenCalled()
    held.resolve()
  })

  it('never turns a queued actor assertion refusal into a source-unknown row', async () => {
    const { value } = sources()
    const ctx = context()
    const refusal = new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'queued authority refusal')
    let refuseNext = false
    value.read.cloudflared = async () => { refuseNext = true; return cloud() }
    vi.mocked(ctx.assertCurrent).mockImplementation(() => {
      if (refuseNext) { refuseNext = false; throw refusal }
    })
    await expect(createRuntimeInspectionReader(value)(ctx)).rejects.toBe(refusal)
  })

  it('observes a pending rejection when config work crosses the read deadline before within admits it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { value } = sources()
    const ctx = context()
    const refusal = new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'configuration-time authority refusal')
    const start = Date.now()
    let changed = false
    value.configuration = id => {
      if (id === 'cloudflared') {
        vi.setSystemTime(start + 18_001)
        changed = true
      }
      return ['A']
    }
    vi.mocked(ctx.assertCurrent).mockImplementation(() => { if (changed) throw refusal })
    const unhandled: unknown[] = []
    const capture = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', capture)
    try {
      await expect(createRuntimeInspectionReader(value)(ctx)).rejects.toBe(refusal)
      // The source promise's queued assertion settles after its caller refused.
      // Wait for Node's rejection turn, without a real process or runtime probe.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
      expect(value.read.cloudflared).not.toHaveBeenCalled()
    } finally {
      process.removeListener('unhandledRejection', capture)
    }
  })
})
