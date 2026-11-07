import { AbortError } from 'redis'
import { redis } from '$lib/server/redis'
import type { AdapterContext } from './appActions/managementTypes'
import { AppActionsManagementRefusal } from './appActions/settings/authority'
import {
  acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot
} from './appActions/settings/lifecycle'
import type { SettingsRedisExecutor } from './appActions/settings/conditionalAgentSettings'
import { getCloudflaredRuntimeStatus, resolveCloudflaredInstallDir, type CloudflaredRuntimeStatus } from './cloudflaredRuntime'

// Raw RedisJSON replies, not the browser URL projection or whole-settings writer.
export const TUNNEL_SETTINGS_PATHS = [
  '$.id', '$.user_id', '$.created_at', '$.ui_settings.upload_settings', '$.upload_settings', '$.upload_provider'
] as const
export const READ_TUNNEL_SETTINGS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID_RECORD'} end
local out = {'OK', redis.call('JSON.TYPE', KEYS[1], '$.ui_settings')[1] or ''}
for _, path in ipairs(cjson.decode(ARGV[1])) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return out
`
export const SAVE_OBSERVED_TUNNEL_URL_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return 'INVALID_RECORD' end
local expected = cjson.decode(ARGV[1])
local paths = {'$.id','$.user_id','$.created_at','$.ui_settings.upload_settings','$.upload_settings','$.upload_provider'}
if #expected ~= #paths then return 'INVALID_SNAPSHOT' end
if (redis.call('JSON.TYPE', KEYS[1], '$.ui_settings')[1] or '') ~= ARGV[2] then return 'CONFLICT' end
for index, path in ipairs(paths) do
  if (redis.call('JSON.GET', KEYS[1], path) or '') ~= expected[index] then return 'CONFLICT' end
end
local function value(path)
  local raw = redis.call('JSON.GET', KEYS[1], path)
  if not raw then return nil end
  return cjson.decode(raw)[1]
end
if type(value('$.id')) ~= 'string' or value('$.user_id') ~= ARGV[3] or type(value('$.created_at')) ~= 'string' then return 'FORBIDDEN' end
if not KEYS[2] or redis.call('EXISTS', KEYS[2]) == 0 then return 'AUTHORITY_CHANGED' end
if redis.call('JSON.TYPE', KEYS[2], '$')[1] ~= 'object' then return 'AUTHORITY_CHANGED' end
local fence = cjson.decode(ARGV[6])
if #fence == 0 then return 'AUTHORITY_CHANGED' end
for _, entry in ipairs(fence) do
  if (redis.call('JSON.GET', KEYS[2], entry[1]) or '') ~= entry[2] then return 'AUTHORITY_CHANGED' end
end
local deadline = tonumber(ARGV[7])
if not deadline then return 'EXPIRED' end
local now = redis.call('TIME')
if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= deadline then return 'EXPIRED' end
local branch = ARGV[4]
if branch ~= 'nested' and branch ~= 'legacy' then return 'INVALID_SNAPSHOT' end
local nestedType = redis.call('JSON.TYPE', KEYS[1], '$.ui_settings.upload_settings')[1]
local nested = value('$.ui_settings.upload_settings')
local actualBranch = nestedType == 'object' and next(nested) ~= nil and 'nested' or 'legacy'
if branch ~= actualBranch then return 'CONFLICT' end
local parent = branch == 'nested' and '$.ui_settings.upload_settings' or '$.upload_settings'
if redis.call('JSON.TYPE', KEYS[1], parent)[1] ~= 'object' then return 'INVALID_RECORD' end
local upload = value(parent)
if upload.tunnel_provider ~= 'cloudflared_managed' or type(upload.cloudflared_target_url) ~= 'string' then return 'PROVENANCE_CHANGED' end
local url = ARGV[5]
if #url > 512 or not string.match(url, '^https://[a-z0-9%-]+%.trycloudflare%.com$') then return 'INVALID_URL' end
local path = parent .. '.tunnel_url'
if value(path) == url then return 'UNCHANGED' end
-- One fixed path write only. Do not create an alias or touch updated_at/siblings.
local result = redis.pcall('JSON.SET', KEYS[1], path, cjson.encode(url))
if type(result) == 'table' and result.ok == 'OK' then return 'OK' end
return 'WRITE_UNCONFIRMED'
`

const snapshotBrand: unique symbol = Symbol('held tunnel settings')
const urlBrand: unique symbol = Symbol('observed tunnel URL')
export type HeldTunnelSettings = Readonly<{ [snapshotBrand]: true }>
export type ObservedTunnelUrl = Readonly<{ [urlBrand]: true }>
export type TunnelSettingsCommitContext = AdapterContext & Readonly<{
  /** Future exact runtime operation's server-owned effect/consent gate. */
  assertCommitAdmitted(): void
  /** Record known save synchronously; no await or admission in this callback. */
  onSaved(): void
}>
export type TunnelUrlSaveResult = Readonly<{
  status: 'completed' | 'no_op' | 'blocked' | 'unknown_outcome'
  saved: 'saved' | 'not_requested' | 'unknown'
  readback: 'verified' | 'unavailable' | 'changed' | 'not_requested'
  visible: 'unknown'
  reason?: string
}>
type RawSettings = { raw: string[]; uiType: string; branch: 'nested' | 'legacy'; target: string; url: unknown; lifecycle: SettingsLifecycleSnapshot }
type Captured = { key: string; binding: string; before: RawSettings; result?: TunnelUrlSaveResult; flight?: Promise<TunnelUrlSaveResult> }
type Advertisement = { url: string; target: string; owner: 'batshit-managed' | 'system' | 'docker-sidecar'; pid: number | null; startedAt: string; observedAt: number; configuration: readonly unknown[] }
type Proof = { snapshot: HeldTunnelSettings; binding: string; advertisement: Advertisement }

function refusal(code: string, message: string): never { throw new AppActionsManagementRefusal(code, message, 409) }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function rawValue(raw: string): unknown {
  if (raw === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { refusal('TUNNEL_SETTINGS_UNAVAILABLE', 'The raw tunnel settings are unreadable.') }
  if (!Array.isArray(parsed) || parsed.length > 1) refusal('TUNNEL_SETTINGS_UNAVAILABLE', 'The raw tunnel settings are unreadable.')
  return parsed[0]
}
function binding(ctx: AdapterContext): string {
  const a = ctx.admission
  return JSON.stringify([a.actor.userId, a.actor.kind, a.actor.id, a.actor.sessionId ?? null, a.actor.generation, a.fence])
}
function userKey(ctx: AdapterContext): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ctx.admission.actor.userId)) refusal('TUNNEL_SETTINGS_UNAVAILABLE', 'The settings owner is unavailable.')
  return `user:${ctx.admission.actor.userId}:settings`
}
function requireAuthority(ctx: AdapterContext): void {
  ctx.assertCurrent()
  if (!ctx.admission.fence.paths.length || !ctx.admission.fence.lifecycle) refusal('TUNNEL_AUTHORITY_REQUIRED', 'Current server-owned authority is required.')
  assertSettingsLifecycle(ctx.admission.fence.lifecycle)
}
function parseSettings(answer: unknown, userId: string, lifecycle: SettingsLifecycleSnapshot): RawSettings {
  if (!Array.isArray(answer) || answer.length !== TUNNEL_SETTINGS_PATHS.length + 2 || answer[0] !== 'OK' ||
    answer.slice(1).some(item => typeof item !== 'string')) refusal('TUNNEL_SETTINGS_UNAVAILABLE', 'Current saved tunnel settings are unavailable.')
  const uiType = answer[1] as string
  if (!['', 'null', 'object'].includes(uiType)) refusal('TUNNEL_SETTINGS_UNAVAILABLE', 'The saved settings container is unreadable.')
  const raw = answer.slice(2) as string[]
  const values = raw.map(rawValue)
  if (typeof values[0] !== 'string' || !values[0] || values[1] !== userId || typeof values[2] !== 'string' ||
    !Number.isFinite(Date.parse(values[2]))) refusal('TUNNEL_SETTINGS_UNAVAILABLE', 'The settings ownership preimage is unavailable.')
  const nested = record(values[3])
  const legacy = record(values[4])
  if (values[3] != null && !nested || values[4] != null && !legacy) refusal('TUNNEL_SETTINGS_UNAVAILABLE', 'The upload settings aliases are unreadable.')
  const branch = nested && Object.keys(nested).length > 0 ? 'nested' : 'legacy'
  const upload = branch === 'nested' ? nested : legacy
  if (!upload || upload.tunnel_provider !== 'cloudflared_managed' || typeof upload.cloudflared_target_url !== 'string' ||
    !upload.cloudflared_target_url.trim() || upload.cloudflared_target_url.length > 2048) {
    refusal('TUNNEL_CONFIGURATION_NOT_VOUCHED', 'An explicit saved managed tunnel provider and target are required.')
  }
  const target = upload.cloudflared_target_url.trim()
  try {
    const parsed = new URL(target)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error()
  } catch { refusal('TUNNEL_CONFIGURATION_NOT_VOUCHED', 'The saved managed tunnel target is not admitted.') }
  return { raw, uiType, branch, target, url: upload.tunnel_url, lifecycle }
}
function runtimeConfiguration(): readonly unknown[] {
  return [resolveCloudflaredInstallDir(), process.env.BATSHIT_CLOUDFLARED_BIN, process.env.PATH, process.env.PATHEXT,
    process.env.BATSHIT_CONTAINERIZED, process.env.BATSHIT_RUNTIME_ENV, process.env.BATSHIT_CLOUDFLARED_DOCKER_STATE_PATH,
    process.cwd(), process.platform, process.arch]
}
function sameConfiguration(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
}
function advertisement(status: CloudflaredRuntimeStatus, target: string, configuration: readonly unknown[]): Advertisement | null {
  const tunnel = status?.tunnel
  if (!tunnel?.running || tunnel.targetUrl !== target || typeof tunnel.publicUrl !== 'string' ||
    !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(tunnel.publicUrl) || tunnel.publicUrl.length > 512 || tunnel.lastError) return null
  if (status.supportLevel === 'docker-sidecar' && status.installScope === 'docker-sidecar') {
    const sidecar = status.dockerSidecar
    if (!sidecar || sidecar.status !== 'running' || sidecar.stale || sidecar.targetUrl !== target ||
      sidecar.publicUrl !== tunnel.publicUrl || !sidecar.lastSeenAt || !sidecar.startedAt) return null
    return { url: tunnel.publicUrl, target, owner: 'docker-sidecar', pid: null, startedAt: sidecar.startedAt, observedAt: Date.now(), configuration }
  }
  if (status.supportLevel !== 'native-managed' || !status.installed || !['batshit-managed', 'system'].includes(status.installScope) ||
    !Number.isSafeInteger(tunnel.pid) || (tunnel.pid ?? 0) <= 0 || !tunnel.startedAt) return null
  return { url: tunnel.publicUrl, target, owner: status.installScope as 'batshit-managed' | 'system', pid: tunnel.pid,
    startedAt: tunnel.startedAt, observedAt: Date.now(), configuration }
}
function sameAdvertisement(left: Advertisement, right: Advertisement): boolean {
  return left.url === right.url && left.target === right.target && left.owner === right.owner && left.pid === right.pid && left.startedAt === right.startedAt &&
    sameConfiguration(left.configuration, right.configuration)
}
function result(status: TunnelUrlSaveResult['status'], saved: TunnelUrlSaveResult['saved'], readback: TunnelUrlSaveResult['readback'], reason?: string): TunnelUrlSaveResult {
  return Object.freeze({ status, saved, readback, visible: 'unknown', ...(reason ? { reason } : {}) })
}

/** Server/test construction only. Production uses the fixed-source singleton below. */
export function createCloudflaredTunnelSettingsOwner(
  execute: SettingsRedisExecutor,
  isCommandAbortError: (error: unknown) => boolean,
  readStatus: () => Promise<CloudflaredRuntimeStatus> = getCloudflaredRuntimeStatus
) {
  const snapshots = new WeakMap<HeldTunnelSettings, Captured>()
  const proofs = new WeakMap<ObservedTunnelUrl, Proof>()
  const custody = new Map<string, Captured>()
  function captured(ctx: AdapterContext, snapshot: HeldTunnelSettings): Captured {
    requireAuthority(ctx)
    const value = snapshots.get(snapshot)
    if (!value || value.key !== userKey(ctx) || value.binding !== binding(ctx)) refusal('TUNNEL_CAPTURE_NOT_OWNED', 'This server-held settings capture is unavailable to this actor.')
    assertSettingsLifecycle(value.before.lifecycle)
    return value
  }
  async function readRaw(ctx: AdapterContext): Promise<RawSettings> {
    requireAuthority(ctx)
    const key = userKey(ctx)
    // Supported restore/recovery advances the global epoch. User settings has
    // no separate delete/recreate owner hook today; id/created_at remain raw
    // preimages, never a fabricated independent incarnation guarantee.
    const lifecycle = captureSettingsLifecycle([key, ...ctx.admission.fence.lifecycle!.records.map(([name]) => name)])
    const answer = await execute(client => client.eval(READ_TUNNEL_SETTINGS_SCRIPT, { keys: [key], arguments: [JSON.stringify(TUNNEL_SETTINGS_PATHS)] }))
    requireAuthority(ctx); assertSettingsLifecycle(lifecycle)
    return parseSettings(answer, ctx.admission.actor.userId, lifecycle)
  }
  return {
    async capture(ctx: AdapterContext): Promise<HeldTunnelSettings> {
      await ctx.refreshAuthority(); requireAuthority(ctx)
      const key = userKey(ctx)
      if (custody.has(key)) refusal('TUNNEL_SAVE_UNSETTLED', 'An earlier tunnel URL save still owns an unsettled outcome. It must not be replayed.')
      const before = await readRaw(ctx)
      await ctx.refreshAuthority(); requireAuthority(ctx); assertSettingsLifecycle(before.lifecycle)
      const token = Object.freeze({ [snapshotBrand]: true as const })
      snapshots.set(token, { key, binding: binding(ctx), before })
      return token
    },
    async observe(ctx: AdapterContext, snapshot: HeldTunnelSettings): Promise<
      { available: true; proof: ObservedTunnelUrl } | { available: false; reason: 'advertisement_unavailable' }
    > {
      const value = captured(ctx, snapshot)
      await ctx.refreshAuthority(); captured(ctx, snapshot)
      let observed: Advertisement | null = null
      try {
        const config = runtimeConfiguration()
        const status = await readStatus()
        if (sameConfiguration(config, runtimeConfiguration())) observed = advertisement(status, value.before.target, config)
      } catch { /* No raw source error leaves this owner. */ }
      await ctx.refreshAuthority(); captured(ctx, snapshot)
      if (!observed) return { available: false, reason: 'advertisement_unavailable' }
      const proof = Object.freeze({ [urlBrand]: true as const })
      proofs.set(proof, { snapshot, binding: binding(ctx), advertisement: observed })
      return { available: true, proof }
    },
    commit(ctx: TunnelSettingsCommitContext, snapshot: HeldTunnelSettings, ticket: ObservedTunnelUrl): Promise<TunnelUrlSaveResult> {
      const value = captured(ctx, snapshot)
      const proof = proofs.get(ticket)
      if (!proof || proof.snapshot !== snapshot || proof.binding !== binding(ctx)) refusal('TUNNEL_URL_NOT_OBSERVED', 'A matching server-observed tunnel URL is required.')
      if (value.flight) return value.flight
      if (custody.has(value.key)) refusal('TUNNEL_SAVE_UNSETTLED', 'An earlier tunnel URL save still has custody. Do not replay it.')
      custody.set(value.key, value)
      value.flight = (async () => {
        let issued = false
        let lease: ReturnType<typeof acquireSettingsMutation> | undefined
        let knownSaved = false
        let answer: unknown
        try {
          await ctx.refreshAuthority(); captured(ctx, snapshot); ctx.assertCommitAdmitted()
          const config = runtimeConfiguration()
          const current = advertisement(await readStatus(), value.before.target, config)
          await ctx.refreshAuthority(); captured(ctx, snapshot); ctx.assertCommitAdmitted()
          if (!current || !sameAdvertisement(current, proof.advertisement) || !sameConfiguration(config, runtimeConfiguration())) {
            custody.delete(value.key)
            return value.result = result('blocked', 'not_requested', 'not_requested', 'advertisement_changed')
          }
          answer = await execute(async client => {
            const abort = new AbortController()
            const cancelled = () => abort.abort()
            const events = ['error', 'end', 'reconnecting'] as const
            for (const event of events) client.on(event, cancelled)
            ctx.signal?.addEventListener('abort', cancelled, { once: true })
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              const deadlineAt = Math.min(ctx.deadlineAt, ctx.admission.expiresAt ?? Infinity)
              const delay = deadlineAt - Date.now()
              if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) refusal('TUNNEL_SAVE_NOT_ADMITTED', 'The tunnel URL save deadline elapsed before issue.')
              timer = setTimeout(cancelled, delay)
              const options = { keys: [value.key, ctx.admission.fence.key], arguments: [JSON.stringify(value.before.raw), value.before.uiType,
                ctx.admission.actor.userId, value.before.branch, current.url, JSON.stringify(ctx.admission.fence.paths), String(deadlineAt)] }
              captured(ctx, snapshot); ctx.assertCommitAdmitted()
              if (!sameConfiguration(config, runtimeConfiguration())) refusal('TUNNEL_PROVENANCE_CHANGED', 'The runtime source changed before the URL save.')
              lease = acquireSettingsMutation(value.before.lifecycle)
              if (ctx.signal?.aborted || !client.isOpen || !client.isReady || abort.signal.aborted) refusal('TUNNEL_SAVE_NOT_ADMITTED', 'The current connection or operation is not admitted.')
              let saved: unknown
              try {
                const command = client.withAbortSignal(abort.signal)
                issued = true
                saved = await command.eval(SAVE_OBSERVED_TUNNEL_URL_SCRIPT, options)
              }
              catch (error) {
                if (abort.signal.aborted && isCommandAbortError(error)) { issued = false; refusal('TUNNEL_SAVE_NOT_ISSUED', 'The queued tunnel URL save was cancelled before issue.') }
                throw error
              }
              if (saved === 'OK') {
                knownSaved = true
                lease.settle(); custody.delete(value.key)
                value.result = result('completed', 'saved', 'unavailable', 'saved_readback_pending')
                // Evidence precedes readback, forwarding and any later Stop check.
                ctx.onSaved()
              }
              return saved
            } finally {
              for (const event of events) client.removeListener(event, cancelled)
              ctx.signal?.removeEventListener('abort', cancelled)
              if (timer !== undefined) clearTimeout(timer)
            }
          })
        } catch {
          if (knownSaved) return value.result = result('completed', 'saved', 'unavailable', 'saved_followup_unavailable')
          if (issued) {
            lease?.unknown()
            return value.result = result('unknown_outcome', 'unknown', 'unavailable', 'save_outcome_unconfirmed')
          }
          lease?.settle(); custody.delete(value.key)
          return value.result = result('blocked', 'not_requested', 'not_requested', 'save_not_issued')
        }
        if (answer !== 'OK') {
          const refusals = ['UNCHANGED', 'MISSING', 'INVALID_RECORD', 'INVALID_SNAPSHOT', 'FORBIDDEN', 'CONFLICT', 'AUTHORITY_CHANGED', 'EXPIRED', 'PROVENANCE_CHANGED', 'INVALID_URL']
          if (typeof answer !== 'string' || !refusals.includes(answer)) {
            lease?.unknown()
            return value.result = result('unknown_outcome', 'unknown', 'unavailable', 'save_outcome_unconfirmed')
          }
          lease?.settle(); custody.delete(value.key)
          return value.result = answer === 'UNCHANGED' ? result('no_op', 'not_requested', 'verified') :
            result('blocked', 'not_requested', 'not_requested', answer.toLowerCase())
        }
        try {
          const after = await readRaw(ctx)
          const same = JSON.stringify(after.lifecycle) === JSON.stringify(value.before.lifecycle) && after.branch === value.before.branch &&
            after.target === value.before.target && after.url === proof.advertisement.url && after.raw.slice(0, 3).every((raw, index) => raw === value.before.raw[index])
          return value.result = result('completed', 'saved', same ? 'verified' : 'changed', same ? undefined : 'saved_then_changed')
        } catch { return value.result = result('completed', 'saved', 'unavailable', 'saved_readback_unavailable') }
      })()
      // Custody remains observed even when its eventual caller has disappeared.
      void value.flight.catch(() => {})
      return value.flight
    },
    outcome(snapshot: HeldTunnelSettings): TunnelUrlSaveResult | null {
      const value = snapshots.get(snapshot)
      if (!value) refusal('TUNNEL_CAPTURE_NOT_OWNED', 'The server-held settings capture is unavailable.')
      return value.result ?? null
    }
  }
}

/** Not registered or exposed. Future instance-operation integration owns consent. */
export const cloudflaredTunnelSettings = createCloudflaredTunnelSettingsOwner(operation => redis.execute(operation), error => error instanceof AbortError)
