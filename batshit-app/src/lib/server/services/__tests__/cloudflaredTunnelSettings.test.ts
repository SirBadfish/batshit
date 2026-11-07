import { EventEmitter } from 'node:events'
import { AbortError } from 'redis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import type { CloudflaredRuntimeStatus } from '../cloudflaredRuntime'
import type { SettingsRedisExecutor } from '../appActions/settings/conditionalAgentSettings'

vi.mock('$lib/server/redis', () => ({ redis: { execute: vi.fn() } }))
vi.mock('../cloudflaredRuntime', () => ({ getCloudflaredRuntimeStatus: vi.fn(), resolveCloudflaredInstallDir: () => '/fixture/runtime' }))

let domain: typeof import('../cloudflaredTunnelSettings')
let lifecycle: typeof import('../appActions/settings/lifecycle')
let serial = 0
const STAMP = '2026-10-17T00:00:00.000Z'
const TARGET = 'http://localhost:5600'
const URL = 'https://observed-fixture.trycloudflare.com'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function upload() { return { strategy: 'local', tunnel_provider: 'cloudflared_managed', cloudflared_target_url: TARGET,
  cloudflared_auto_start: false, use_https: false, tunnel_url: 'https://prior.trycloudflare.com', extension: { keep: true } } }
function status(): CloudflaredRuntimeStatus {
  return { installed: true, supported: true, dockerUnsupported: false, supportLevel: 'native-managed', installScope: 'batshit-managed',
    command: '/fixture/cloudflared', version: '2026.3.0', reason: null, testedVersion: '2026.3.0', managedInstallPresent: true,
    installCommand: 'fixture', installHelp: 'fixture', defaultPlatform: 'darwin-arm64', manifest: null,
    tunnel: { running: true, targetUrl: TARGET, publicUrl: URL, pid: 41000, startedAt: STAMP, lastError: null },
    dockerSidecar: null }
}
beforeEach(async () => {
  vi.resetModules()
  domain = await import('../cloudflaredTunnelSettings')
  lifecycle = await import('../appActions/settings/lifecycle')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

function fixture() {
  const user = `p6b_fixture_${++serial}`
  let settings: any = { id: `settings_${user}`, user_id: user, created_at: STAMP, updated_at: STAMP,
    ui_settings: { theme: 'keep', upload_settings: upload() }, upload_settings: { legacy: 'preserve', ...upload() },
    upload_provider: 'preserve-exact', voice_settings: { keep: true } }
  const control = new AbortController()
  let effectAllowed = true
  const fence = { key: `agent:actor_${user}`, paths: [['$.generation', '[1]']] as Array<[string, string]>,
    lifecycle: lifecycle.captureSettingsLifecycle([`agent:actor_${user}`]) }
  const ctx = {
    admission: { actor: { userId: user, kind: 'native' as const, id: `actor_${user}`, sessionId: 'session', generation: 1, label: 'Primary' },
      policy: { ...defaultAppActionsPolicy(), enabled: true }, fence }, signal: control.signal, deadlineAt: Date.now() + 30_000,
    refreshAuthority: vi.fn(async () => {}),
    assertCurrent() {
      if (control.signal.aborted || Date.now() >= ctx.deadlineAt) throw new Error('exact originating Stop/deadline')
      lifecycle.assertSettingsLifecycle(fence.lifecycle)
    },
    assertCommitAdmitted: vi.fn(() => { if (!effectAllowed) throw new Error('exact effect consent revoked') }),
    onSaved: vi.fn()
  }
  const client = new EventEmitter() as EventEmitter & {
    isOpen: boolean; isReady: boolean; eval: ReturnType<typeof vi.fn>; withAbortSignal: ReturnType<typeof vi.fn>
  }
  client.isOpen = true; client.isReady = true
  let readCount = 0
  let writeCount = 0
  let writeAnswer: unknown = 'OK'
  let onWrite: (() => Promise<unknown>) | undefined
  let onRead: (() => Promise<unknown>) | undefined
  const pathValue = (path: string) => path.slice(2).split('.').reduce((value, key) => value?.[key], settings)
  const raw = (value: unknown) => value === undefined ? '[]' : JSON.stringify([value])
  const readAnswer = () => ['OK', settings.ui_settings === undefined ? '' : settings.ui_settings === null ? 'null' :
    Array.isArray(settings.ui_settings) ? 'array' : typeof settings.ui_settings,
    ...domain.TUNNEL_SETTINGS_PATHS.map(path => raw(pathValue(path)))]
  client.eval = vi.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
    if (script === domain.READ_TUNNEL_SETTINGS_SCRIPT) { readCount++; return onRead ? onRead() : readAnswer() }
    if (script !== domain.SAVE_OBSERVED_TUNNEL_URL_SCRIPT) throw new Error('unexpected script')
    writeCount++
    if (onWrite) return onWrite()
    // This fixture checks orchestration/planned arguments, NOT Lua atomicity.
    // The separate real-Redis owner executes the actual script after allocation.
    if (writeAnswer === 'OK') {
      const parent = options.arguments[3] === 'nested' ? settings.ui_settings.upload_settings : settings.upload_settings
      parent.tunnel_url = options.arguments[4]
    }
    return writeAnswer
  })
  client.withAbortSignal = vi.fn(() => ({ eval: client.eval }))
  let connection: Promise<void> | undefined
  let connectionEntered = false
  const execute: SettingsRedisExecutor = async operation => {
    if (connection) { connectionEntered = true; await connection }
    return operation(client as any)
  }
  const readStatus = vi.fn(async () => status())
  const owner = domain.createCloudflaredTunnelSettingsOwner(execute, error => error instanceof AbortError, readStatus)
  return { owner, ctx, client, control, readStatus, get settings() { return settings }, set settings(value) { settings = value },
    get readCount() { return readCount }, get writeCount() { return writeCount }, readAnswer,
    setWriteAnswer(value: unknown) { writeAnswer = value }, setWrite(work: () => Promise<unknown>) { onWrite = work },
    setRead(work: () => Promise<unknown>) { onRead = work },
    holdConnection(promise: Promise<void>) { connection = promise }, get connectionEntered() { return connectionEntered },
    revokeEffect() { effectAllowed = false } }
}
async function prepared(f: ReturnType<typeof fixture>) {
  const snapshot = await f.owner.capture(f.ctx)
  const observed = await f.owner.observe(f.ctx, snapshot)
  if (!observed.available) throw new Error('fixture advertisement not available')
  return { snapshot, proof: observed.proof }
}

describe('unexposed Cloudflared observed-URL settings owner', () => {
  it('mints opaque source proof and records a known nested-branch save before readback, preserving every other field', async () => {
    const f = fixture()
    const before = structuredClone(f.settings)
    const { snapshot, proof } = await prepared(f)
    expect(JSON.stringify(snapshot)).toBe('{}')
    expect(JSON.stringify(proof)).toBe('{}')
    f.ctx.onSaved.mockImplementation(() => {
      expect(f.readCount).toBe(1)
      expect(f.owner.outcome(snapshot)).toMatchObject({ saved: 'saved', readback: 'unavailable' })
    })
    expect(await f.owner.commit(f.ctx, snapshot, proof)).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified' })
    before.ui_settings.upload_settings.tunnel_url = URL
    expect(f.settings).toEqual(before)
    expect(f.ctx.onSaved).toHaveBeenCalledOnce()
    expect(f.writeCount).toBe(1)
    expect(f.readStatus).toHaveBeenCalledTimes(2)
    const args = f.client.eval.mock.calls.find(call => call[0] === domain.SAVE_OBSERVED_TUNNEL_URL_SCRIPT)![1]
    expect(args.keys).toEqual([`user:${f.ctx.admission.actor.userId}:settings`, f.ctx.admission.fence.key])
    expect(args.arguments[3]).toBe('nested')
    expect(args.arguments[4]).toBe(URL)
  })

  it.each([undefined, null, {}])('keeps legacy precedence when the nested upload alias is %j', async nested => {
    const f = fixture()
    f.settings.ui_settings.upload_settings = nested
    const before = structuredClone(f.settings)
    const { snapshot, proof } = await prepared(f)
    expect(await f.owner.commit(f.ctx, snapshot, proof)).toMatchObject({ saved: 'saved', readback: 'verified' })
    before.upload_settings.tunnel_url = URL
    expect(f.settings).toEqual(before)
    expect(f.client.eval.mock.calls.find(call => call[0] === domain.SAVE_OBSERVED_TUNNEL_URL_SCRIPT)![1].arguments[3]).toBe('legacy')
  })

  it.each(['bad-owner', 'bad-alias', 'manual', 'implicit-target'])('refuses an unvouched capture before runtime reads: %s', async fault => {
    const f = fixture()
    if (fault === 'bad-owner') f.settings.user_id = 'other'
    if (fault === 'bad-alias') f.settings.ui_settings.upload_settings = []
    if (fault === 'manual') f.settings.ui_settings.upload_settings.tunnel_provider = 'manual'
    if (fault === 'implicit-target') delete f.settings.ui_settings.upload_settings.cloudflared_target_url
    await expect(f.owner.capture(f.ctx)).rejects.toThrow()
    expect(f.readStatus).not.toHaveBeenCalled()
    expect(f.writeCount).toBe(0)
  })

  it('refuses JSON-forged URL tickets and another actor without an effect', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    expect(() => f.owner.commit(f.ctx, snapshot, { publicURL: URL } as any)).toThrow('server-observed')
    const changed = { ...f.ctx, admission: { ...f.ctx.admission, actor: { ...f.ctx.admission.actor, generation: 2 } } }
    expect(() => f.owner.commit(changed, snapshot, proof)).toThrow('unavailable to this actor')
    expect(f.writeCount).toBe(0)
  })

  it.each(['stopped', 'wrong-target', 'unconfirmed-stop', 'stale-sidecar'])('cannot mint a usable ticket from %s evidence', async fault => {
    const f = fixture()
    f.readStatus.mockImplementation(async () => {
      const current = status()
      if (fault === 'stopped') current.tunnel.running = false
      if (fault === 'wrong-target') current.tunnel.targetUrl = 'http://localhost:5601'
      if (fault === 'unconfirmed-stop') current.tunnel.lastError = 'exit unknown'
      if (fault === 'stale-sidecar') {
        current.supportLevel = 'docker-sidecar'; current.installScope = 'docker-sidecar'
        current.dockerSidecar = { status: 'running', stale: true, publicUrl: URL, targetUrl: TARGET, lastSeenAt: STAMP, startedAt: STAMP } as any
      }
      return current
    })
    const capture = await f.owner.capture(f.ctx)
    expect(await f.owner.observe(f.ctx, capture)).toEqual({ available: false, reason: 'advertisement_unavailable' })
    expect(f.writeCount).toBe(0)
  })

  it('refuses a changed runtime advertisement and reuses a definitive operation result without replay', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    f.readStatus.mockResolvedValue({ ...status(), tunnel: { ...status().tunnel, pid: 41001 } })
    const answer = await f.owner.commit(f.ctx, snapshot, proof)
    expect(answer).toMatchObject({ saved: 'not_requested', reason: 'advertisement_changed' })
    expect(await f.owner.commit(f.ctx, snapshot, proof)).toBe(answer)
    expect(f.writeCount).toBe(0)
  })

  it.each(['stop', 'effect', 'config', 'deadline'])('rechecks %s after awaited client acquisition and before EVAL', async change => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    const gate = deferred<void>()
    f.holdConnection(gate.promise)
    const pending = f.owner.commit(f.ctx, snapshot, proof)
    await vi.waitFor(() => expect(f.connectionEntered).toBe(true))
    if (change === 'stop') f.control.abort()
    if (change === 'effect') f.revokeEffect()
    if (change === 'config') vi.stubEnv('BATSHIT_CLOUDFLARED_BIN', '/changed/command')
    if (change === 'deadline') f.ctx.deadlineAt = Date.now() - 1
    gate.resolve()
    expect(await pending).toMatchObject({ status: 'blocked', saved: 'not_requested' })
    expect(f.writeCount).toBe(0)
  })

  it('retains a known save before a held readback and still records it when Stop arrived during EVAL', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    const issued = deferred<unknown>()
    f.setWrite(() => issued.promise)
    const pending = f.owner.commit(f.ctx, snapshot, proof)
    await vi.waitFor(() => expect(f.writeCount).toBe(1))
    f.control.abort()
    issued.resolve('OK')
    expect(await pending).toMatchObject({ saved: 'saved', readback: 'unavailable' })
    expect(f.ctx.onSaved).toHaveBeenCalledOnce()
    expect(f.owner.outcome(snapshot)).toMatchObject({ saved: 'saved' })
    expect(f.writeCount).toBe(1)
  })

  it('publishes known-save evidence before an indefinitely held readback and calls its observer only once', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    const held = deferred<unknown>()
    f.setRead(() => held.promise)
    const pending = f.owner.commit(f.ctx, snapshot, proof)
    await vi.waitFor(() => expect(f.ctx.onSaved).toHaveBeenCalledOnce())
    expect(f.owner.outcome(snapshot)).toMatchObject({ saved: 'saved', readback: 'unavailable', reason: 'saved_readback_pending' })
    expect(f.owner.commit(f.ctx, snapshot, proof)).toBe(pending)
    held.resolve(f.readAnswer())
    expect(await pending).toMatchObject({ saved: 'saved', readback: 'verified' })
    expect(f.ctx.onSaved).toHaveBeenCalledOnce()
    expect(f.writeCount).toBe(1)
  })

  it('never erases a confirmed save if its progress callback throws', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    f.ctx.onSaved.mockImplementation(() => { throw new Error('forward failure') })
    expect(await f.owner.commit(f.ctx, snapshot, proof)).toMatchObject({ saved: 'saved', readback: 'unavailable' })
    expect(f.owner.outcome(snapshot)).toMatchObject({ saved: 'saved' })
    expect(f.writeCount).toBe(1)
  })

  it('classifies the real AbortError shape as not issued only when its command was cancelled while queued', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    let queued = false
    f.client.withAbortSignal.mockImplementation((signal: AbortSignal) => ({ eval: () => new Promise((_resolve, reject) => {
      queued = true
      signal.addEventListener('abort', () => reject(new AbortError()), { once: true })
    }) }))
    const pending = f.owner.commit(f.ctx, snapshot, proof)
    await vi.waitFor(() => expect(queued).toBe(true))
    f.control.abort()
    expect(await pending).toMatchObject({ status: 'blocked', saved: 'not_requested' })
    expect(f.ctx.onSaved).not.toHaveBeenCalled()
    expect(f.writeCount).toBe(0)
  })

  it.each(['CONFLICT', 'AUTHORITY_CHANGED', 'EXPIRED', 'UNCHANGED'])('recognizes definitive %s without a save callback or replay', async answer => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    f.setWriteAnswer(answer)
    const result = await f.owner.commit(f.ctx, snapshot, proof)
    expect(result.saved).toBe('not_requested')
    expect(await f.owner.commit(f.ctx, snapshot, proof)).toBe(result)
    expect(f.ctx.onSaved).not.toHaveBeenCalled()
    expect(f.writeCount).toBe(1)
  })

  it('retains issued-unknown custody, blocks fresh captures/restores and never retries the operation', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    f.setWrite(async () => { throw new Error('lost command response') })
    const result = await f.owner.commit(f.ctx, snapshot, proof)
    expect(result).toMatchObject({ status: 'unknown_outcome', saved: 'unknown', readback: 'unavailable' })
    expect(await f.owner.commit(f.ctx, snapshot, proof)).toBe(result)
    await expect(f.owner.capture(f.ctx)).rejects.toThrow('must not be replayed')
    await expect(lifecycle.withSettingsRestoreFence(async () => {})).rejects.toThrow('unknown outcome')
    expect(f.writeCount).toBe(1)
    expect(f.ctx.onSaved).not.toHaveBeenCalled()
  })

  it('invalidates an old capture across the actual global restore epoch without calling dates an incarnation', async () => {
    const f = fixture()
    const { snapshot, proof } = await prepared(f)
    await lifecycle.withSettingsRestoreFence(async () => {})
    expect(() => f.owner.commit(f.ctx, snapshot, proof)).toThrow('identity changed')
    expect(f.writeCount).toBe(0)
  })
})
