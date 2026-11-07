import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbortError } from 'redis'
import { redis } from '$lib/server/redis'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { captureSettingsLifecycle, assertSettingsLifecycle } from '../appActions/settings/lifecycle'
import type { SettingsRedisExecutor, SettingsRedisClient } from '../appActions/settings/conditionalAgentSettings'
import type { CloudflaredRuntimeStatus } from '../cloudflaredRuntime'
import { createCloudflaredTunnelSettingsOwner, SAVE_OBSERVED_TUNNEL_URL_SCRIPT, type TunnelSettingsCommitContext } from '../cloudflaredTunnelSettings'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'p6b_tunnel_url_fixture'
const KEY = `user:${USER}:settings`
const AUTH = 'agent:p6b_tunnel_url_actor'
const STAMP = '2026-10-17T00:00:00.000Z'
const TARGET = 'http://localhost:5600'
const URL = 'https://observed-fixture.trycloudflare.com'

// No fake interpreter is atomic/RedisJSON proof. These cases stay skipped until
// root allocates the existing disposable Redis8+JSON lane and both explicit URLs.
describe.runIf(REAL)('observed tunnel URL CAS on the allocated real Redis boundary', () => {
  const admission = useRedisTestServer({
    async beforeCleanupAdmission({ adminClient, resolvedUrl }) {
      const requested = process.env.BATSHIT_REDIS_TEST_URL
      if (!requested) throw new Error('P6b requires an explicit shared test allocation URL.')
      const base = new globalThis.URL(requested)
      const resolved = new globalThis.URL(resolvedUrl)
      if (base.protocol !== 'redis:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.search || base.hash || base.pathname !== '/15' ||
        resolved.protocol !== base.protocol || resolved.hostname !== base.hostname || resolved.port !== base.port || resolved.username || resolved.password ||
        resolved.search || resolved.hash || resolved.pathname !== '/14' || process.env.REDIS_URL !== resolvedUrl) {
        throw new Error('P6b test allocation must be the explicit loopback DB15/workerDB14 lane.')
      }
      const [info, connection, count, missing] = await Promise.all([
        adminClient.info('server'), adminClient.clientInfo(), adminClient.dbSize(),
        adminClient.sendCommand(['JSON.GET', 'p6b:missing-json-admission', '$'])
      ])
      if (!info.split(/\r?\n/).includes('redis_version:8.10.1') || connection.db !== 14 || count !== 0 || missing !== null) {
        throw new Error('P6b requires the admitted empty Redis8.10.1 JSON worker database.')
      }
    }
  })
  const policy = { ...defaultAppActionsPolicy(), enabled: true }
  let ctx: TunnelSettingsCommitContext
  function upload() { return { strategy: 'local', tunnel_provider: 'cloudflared_managed', cloudflared_target_url: TARGET,
    cloudflared_auto_start: false, use_https: false, tunnel_url: 'https://prior.trycloudflare.com', extension: { keep: true } } }
  function observed(): CloudflaredRuntimeStatus {
    return { installed: true, supported: true, dockerUnsupported: false, supportLevel: 'native-managed', installScope: 'batshit-managed',
      command: '/fixture/cloudflared', version: '2026.3.0', reason: null, testedVersion: '2026.3.0', managedInstallPresent: true,
      installCommand: 'fixture', installHelp: 'fixture', defaultPlatform: 'darwin-arm64', manifest: null,
      tunnel: { running: true, targetUrl: TARGET, publicUrl: URL, pid: 41000, startedAt: STAMP, lastError: null }, dockerSidecar: null }
  }
  const execute: SettingsRedisExecutor = operation => redis.execute(operation)
  const owner = () => createCloudflaredTunnelSettingsOwner(execute, error => error instanceof AbortError, async () => observed())
  async function row() { return await redis.json.get(KEY, '$') as any }
  beforeEach(async () => {
    admission.requireAdmission()
    await redis.json.set(KEY, '$', { id: `settings_${USER}`, user_id: USER, created_at: STAMP, updated_at: STAMP,
      ui_settings: { theme: 'keep', upload_settings: upload() }, upload_settings: { ...upload(), legacyExtension: 'keep' },
      upload_provider: 'preserve-exact', voice_settings: { keep: ['exact'] } })
    await redis.json.set(AUTH, '$', { id: 'p6b_tunnel_url_actor', user_id: USER, agentType: 'api', created_at: STAMP,
      app_action_policy: { generation: 1, policy } })
    const paths = ['$.id', '$.user_id', '$.agentType', '$.created_at', '$.app_action_policy']
    const raw = await redis.execute(client => Promise.all(paths.map(path => client.sendCommand(['JSON.GET', AUTH, path]))))
    if (raw.some(value => typeof value !== 'string')) throw new Error('Actual authority JSONPath reply was not raw text.')
    const lifecycle = captureSettingsLifecycle([AUTH])
    const signal = new AbortController().signal
    ctx = { admission: { actor: { userId: USER, kind: 'native', id: 'p6b_tunnel_url_actor', generation: 1, label: 'Fixture', sessionId: 'fixture' },
      policy, fence: { key: AUTH, paths: paths.map((path, index) => [path, raw[index] as string]), lifecycle } },
      signal, deadlineAt: Date.now() + 30_000, refreshAuthority: async () => {},
      assertCurrent() { if (signal.aborted || Date.now() >= this.deadlineAt) throw new Error('fixture stopped'); assertSettingsLifecycle(lifecycle) },
      assertCommitAdmitted() {}, onSaved: vi.fn() }
  })
  afterEach(async () => { admission.requireAdmission(); await redis.del(KEY); await redis.del(AUTH) })
  afterAll(async () => { await redis.disconnect() })
  async function prepare(service: ReturnType<typeof owner>) {
    const snapshot = await service.capture(ctx)
    const observed = await service.observe(ctx, snapshot)
    if (!observed.available) throw new Error('Fixed fixture observation did not vouch its URL.')
    return { snapshot, proof: observed.proof }
  }

  it('executes the actual Lua/JSONPath shape and changes exactly the winning URL leaf', async () => {
    const service = owner()
    const before = await row()
    const { snapshot, proof } = await prepare(service)
    await redis.json.set(KEY, '$.ui_settings.concurrentSibling', { keep: 'new' })
    expect(await service.commit(ctx, snapshot, proof)).toMatchObject({ saved: 'saved', readback: 'verified' })
    before.ui_settings.upload_settings.tunnel_url = URL
    before.ui_settings.concurrentSibling = { keep: 'new' }
    expect(await row()).toEqual(before)
    expect(ctx.onSaved).toHaveBeenCalledOnce()
  })

  it.each(['missing', 'null', 'empty'])('keeps %s nested state while updating only the authoritative legacy branch', async state => {
    if (state === 'missing') await redis.execute(client => client.sendCommand(['JSON.DEL', KEY, '$.ui_settings.upload_settings']))
    else await redis.json.set(KEY, '$.ui_settings.upload_settings', state === 'null' ? null : {})
    const before = await row()
    const service = owner()
    const { snapshot, proof } = await prepare(service)
    expect(await service.commit(ctx, snapshot, proof)).toMatchObject({ saved: 'saved', readback: 'verified' })
    before.upload_settings.tunnel_url = URL
    expect(await row()).toEqual(before)
  })

  it.each(['cloudflared_target_url', 'cloudflared_auto_start', 'use_https', 'tunnel_provider'])('refuses a concurrent %s edit without restoring its preimage', async field => {
    const service = owner()
    const { snapshot, proof } = await prepare(service)
    const changed = field === 'cloudflared_target_url' ? 'http://localhost:5601' : field === 'tunnel_provider' ? 'manual' : true
    await redis.json.set(KEY, `$.ui_settings.upload_settings.${field}`, changed)
    const before = await row()
    expect(await service.commit(ctx, snapshot, proof)).toMatchObject({ status: 'blocked', saved: 'not_requested', reason: 'conflict' })
    expect(await row()).toEqual(before)
    expect(ctx.onSaved).not.toHaveBeenCalled()
  })

  it('checks raw current authority at EVAL even when fixture JS admission has not refreshed it', async () => {
    const service = owner()
    const { snapshot, proof } = await prepare(service)
    await redis.json.set(AUTH, '$.app_action_policy.generation', 2)
    const before = await row()
    expect(await service.commit(ctx, snapshot, proof)).toMatchObject({ saved: 'not_requested', reason: 'authority_changed' })
    expect(await row()).toEqual(before)
  })

  it('never recreates a settings key deleted after capture', async () => {
    const service = owner()
    const { snapshot, proof } = await prepare(service)
    await redis.del(KEY)
    expect(await service.commit(ctx, snapshot, proof)).toMatchObject({ saved: 'not_requested', reason: 'missing' })
    expect(await redis.json.get(KEY, '$')).toBeNull()
  })

  it('keeps a lost response unknown after actual Lua applied, with one issue and no fresh-capture replay', async () => {
    let writes = 0
    const lostResponse: SettingsRedisExecutor = operation => redis.execute(client => {
      const view: SettingsRedisClient = {
        get isOpen() { return client.isOpen }, get isReady() { return client.isReady },
        eval: client.eval.bind(client), on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        withAbortSignal(signal) {
          const command = client.withAbortSignal(signal)
          return { async eval(script, options) {
            const answer = await command.eval(script, options)
            if (script === SAVE_OBSERVED_TUNNEL_URL_SCRIPT) { writes++; throw new Error('fixture loses applied response') }
            return answer
          } }
        }
      }
      return operation(view)
    })
    const service = createCloudflaredTunnelSettingsOwner(lostResponse, error => error instanceof AbortError, async () => observed())
    const { snapshot, proof } = await prepare(service)
    const answer = await service.commit(ctx, snapshot, proof)
    expect(answer).toMatchObject({ saved: 'unknown', status: 'unknown_outcome' })
    expect((await row()).ui_settings.upload_settings.tunnel_url).toBe(URL)
    expect(await service.commit(ctx, snapshot, proof)).toBe(answer)
    await expect(service.capture(ctx)).rejects.toThrow('must not be replayed')
    expect(writes).toBe(1)
    expect(ctx.onSaved).not.toHaveBeenCalled()
  })
})
