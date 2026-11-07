import { getBatshitHomeDir } from './batshitHome'
import { env } from '$env/dynamic/private'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { redis } from '$lib/server/redis'
import { saveHostVoiceReferenceAudioViaOperator } from '$lib/server/services/voiceHostOperatorRuntime'
import type { VoiceProfileRecord } from '$lib/types/voice'
import { validTtsId } from '$lib/appActions/settings/configuredTtsPreferences'
import { parseQwenAudioEndpoint, type QwenAudioRegion } from '$lib/data/qwenAudioTts'
import {
  captureSettingsLifecycle, assertSettingsLifecycle, assertSettingsRecordReplacement,
  type SettingsLifecycleSnapshot
} from './appActions/settings/lifecycle'

export function getManagedVoiceProfileStorageRoot(): string {
  return path.join(getBatshitHomeDir(), 'voice-profiles')
}

function isContainerizedRuntime(): boolean {
  return (
    env.BATSHIT_CONTAINERIZED === '1' ||
    process.env.BATSHIT_CONTAINERIZED === '1' ||
    env.BATSHIT_RUNTIME_ENV === 'docker' ||
    process.env.BATSHIT_RUNTIME_ENV === 'docker'
  )
}

function buildManagedVoiceProfileDir(profileId: string): string {
  return path.join(getManagedVoiceProfileStorageRoot(), profileId)
}

function resolveManagedVoiceProfileAudioExtension(options: {
  filename?: string | null
  contentType?: string | null
}): string {
  const fromFilename = path.extname(options.filename ?? '').trim().toLowerCase()
  if (/^\.[a-z0-9]{1,10}$/.test(fromFilename)) {
    return fromFilename
  }

  const normalizedType = options.contentType?.trim().toLowerCase() ?? ''
  const byContentType: Record<string, string> = {
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac'
  }

  return byContentType[normalizedType] ?? '.wav'
}

async function saveManagedVoiceProfileReferenceAudio(options: {
  profileId: string
  audio: Uint8Array
  filename?: string | null
  contentType?: string | null
}): Promise<{ audioPath: string; dirPath: string }> {
  const dirPath = buildManagedVoiceProfileDir(options.profileId)
  const extension = resolveManagedVoiceProfileAudioExtension(options)
  const audioPath = path.join(dirPath, `reference${extension}`)

  await fs.mkdir(dirPath, { recursive: true })
  await fs.writeFile(audioPath, Buffer.from(options.audio))

  return { audioPath, dirPath }
}

export async function saveReferenceAudioForByoClone(options: {
  profileId: string
  audio: Uint8Array
  filename?: string | null
  contentType?: string | null
}): Promise<{ audioPath: string; dirPath?: string }> {
  if (!isContainerizedRuntime()) {
    return saveManagedVoiceProfileReferenceAudio(options)
  }

  const result = await saveHostVoiceReferenceAudioViaOperator({
    profileId: options.profileId,
    audioBase64: Buffer.from(options.audio).toString('base64'),
    filename: options.filename,
    contentType: options.contentType
  }).catch((error) => {
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : 'The host operator could not store the reference sample.'
    throw new Error(
      `Docker voice cloning for host-local BYO engines requires the authenticated Batshit host operator so the speech engine can read the reference audio file. ${detail}`
    )
  })

  return {
    audioPath: result.audioPath,
    dirPath: result.dirPath
  }
}

function getManagedVoiceProfileAudioPath(profile: { settings?: unknown } | null | undefined): string | null {
  const settings =
    profile?.settings && typeof profile.settings === 'object' && !Array.isArray(profile.settings)
      ? (profile.settings as Record<string, unknown>)
      : null
  const candidate =
    settings && typeof settings.batshitManagedReferenceAudioPath === 'string'
      ? settings.batshitManagedReferenceAudioPath.trim()
      : ''
  if (!candidate) return null

  const root = path.resolve(getManagedVoiceProfileStorageRoot())
  const resolved = path.resolve(candidate)
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    return null
  }

  return resolved
}

export async function deleteManagedVoiceProfileArtifacts(
  profile: { settings?: unknown } | null | undefined
): Promise<void> {
  const audioPath = getManagedVoiceProfileAudioPath(profile)
  if (!audioPath) return

  await fs.rm(path.dirname(audioPath), { recursive: true, force: true })
}

export async function createVoiceProfile(profile: VoiceProfileRecord): Promise<VoiceProfileRecord> {
  return redis.createVoiceProfile(profile)
}

export async function listVoiceProfiles(userId: string): Promise<VoiceProfileRecord[]> {
  return redis.getVoiceProfiles(userId)
}

export async function deleteVoiceProfile(userId: string, profileId: string, original?: PreparedVoiceProfile): Promise<void> {
  if (original) {
    if (original.id !== profileId || original.userId !== userId) throw new Error('Voice profile cleanup identity changed.')
    // No await before the existing owner synchronously admits this replacement. The owner
    // advances its own revision, so this original slice must never be asserted inside it.
    assertSettingsLifecycle(original.lifecycle)
  }
  return redis.deleteVoiceProfile(profileId, userId, async () => {
    let profile: VoiceProfileRecord | CleanupVoiceProfile | null
    if (original) {
      const raw = await redis.json.getRaw(`voice_profile:${profileId}`, '$')
      if (typeof raw !== 'string' || raw !== original.raw || createHash('sha1').update(raw).digest('hex') !== original.fingerprint) {
        throw new Error('Saved voice profile changed after cleanup was prepared.')
      }
      profile = cleanupProfileFromRaw(raw, profileId, userId)
      if (profile.provider !== original.providerId) throw new Error('Voice profile cleanup provider changed.')
    } else {
      profile = await redis.getVoiceProfile(profileId)
    }
    if (profile?.user_id && profile.user_id !== userId) throw new Error('Voice profile not found')
    // Restore can begin while the raw-only reread awaits. Recheck this admitted owner
    // immediately before the existing helper's synchronous rm issue, not a fresh incarnation.
    if (original) assertSettingsRecordReplacement(`voice_profile:${profileId}`)
    await deleteManagedVoiceProfileArtifacts(profile)
  })
}

type CleanupVoiceProfile = { id: string; provider: string; user_id?: unknown; settings?: unknown }
type PreparedVoiceProfile = Readonly<{
  id: string; userId: string; providerId: string; raw: string; fingerprint: string
  lifecycle: SettingsLifecycleSnapshot
}>
type VoiceProfileCleanupPreparation = Readonly<{ userId: string; profiles: readonly PreparedVoiceProfile[] }>

function cleanupProfileFromRaw(raw: string, id: string, userId: string): CleanupVoiceProfile {
  const rows: unknown = JSON.parse(raw)
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) {
    throw new Error('Voice profile cleanup requires a readable saved profile.')
  }
  const row = rows[0] as Record<string, unknown>
  if (row.id !== id || typeof row.provider !== 'string' || !row.provider.trim() ||
      row.user_id != null && row.user_id !== '' && row.user_id !== userId) {
    throw new Error('Voice profile cleanup could not verify the saved profile identity, owner or provider.')
  }
  return row as CleanupVoiceProfile
}

/** One server-private original cohort; neither a picker DTO nor a grant to delete a later row. */
export async function prepareVoiceProfileCleanup(userId: string, providerIds: readonly string[]): Promise<VoiceProfileCleanupPreparation> {
  let source: Awaited<ReturnType<typeof readRawVoiceProfileInventory>>
  try { source = await readRawVoiceProfileInventory(userId, undefined, []) }
  catch (error) {
    if (!(error instanceof VoiceProfileInventoryReadError)) throw error
    throw new Error(error.kind === 'limit'
      ? 'Voice profile cleanup requires at most 1024 indexed profiles.'
      : 'Voice profile cleanup requires a complete readable inventory within the saved-profile size limits.', { cause: error })
  }
  if (!source.complete) throw new Error('Voice profile cleanup requires a complete saved profile inventory. Read the saved profiles again.')
  const providers = new Set(providerIds)
  const profiles: PreparedVoiceProfile[] = []
  for (const item of source.profiles) {
    // Validate every indexed row before selecting: an unreadable provider cannot be omitted
    // as unrelated. No picker-only name, model, voice or projected-field requirement applies.
    const profile = cleanupProfileFromRaw(item.raw, item.id, userId)
    if (!providers.has(profile.provider)) continue
    const key = `voice_profile:${item.id}`
    const records = source.lifecycle.records.filter(([entry]) => entry === key).map(([entry, revision]): [string, string] => [entry, revision])
    if (records.length !== 1) throw new Error('Voice profile cleanup original incarnation is unavailable.')
    profiles.push(Object.freeze({ id: item.id, userId, providerId: profile.provider, raw: item.raw,
      fingerprint: item.fingerprint, lifecycle: { epoch: source.lifecycle.epoch, records } }))
  }
  return Object.freeze({ userId, profiles: Object.freeze(profiles) })
}

export async function deletePreparedVoiceProfiles(preparation: VoiceProfileCleanupPreparation): Promise<{ deletedProfileIds: string[] }> {
  const deletedProfileIds: string[] = []
  for (const profile of preparation.profiles) {
    await deleteVoiceProfile(preparation.userId, profile.id, profile)
    deletedProfileIds.push(profile.id)
  }
  return { deletedProfileIds }
}

class VoiceProfileInventoryReadError extends Error {
  constructor(readonly kind: 'limit' | 'unavailable', readonly count?: number) {
    super(kind === 'limit' ? 'voice_profile_source_limit' : 'voice_profile_source_unavailable')
  }
}

type RawVoiceProfile = { id: string; fingerprint: string; raw: string; metadata: string[] }

/** Read-only original raw/field strings and the original lifecycle. No migration or writes. */
async function readRawVoiceProfileInventory(userId: string, exactId: string | undefined, fields: readonly string[]) {
  const index = `user:${userId}:voice_profiles`
  return redis.execute(async client => {
    const inventory = exactId ? ['OK', exactId] : await client.eval(`-- VOICE_PROFILE_RAW_INVENTORY_IDS
local count = redis.call('SCARD', KEYS[1]); if count > 1024 then return {'LIMIT', tostring(count)} end
local out = {'OK'}; for _, id in ipairs(redis.call('SMEMBERS', KEYS[1])) do if string.len(id) > 256 then return {'UNAVAILABLE'} end; out[#out+1] = id end; return out`, { keys: [index], arguments: [] })
    if (!Array.isArray(inventory) || inventory[0] !== 'OK' || inventory.slice(1).some(id => typeof id !== 'string')) {
      const limited = Array.isArray(inventory) && inventory[0] === 'LIMIT'
      throw new VoiceProfileInventoryReadError(limited ? 'limit' : 'unavailable', limited ? Number(inventory[1]) : undefined)
    }
    const initialIds = inventory.slice(1) as string[]
    if (new Set(initialIds).size !== initialIds.length || initialIds.some(id => !id || !id.isWellFormed() || Buffer.byteLength(id, 'utf8') > 256)) throw new VoiceProfileInventoryReadError('unavailable')
    const lifecycle = captureSettingsLifecycle(initialIds.map(id => `voice_profile:${id}`))
    const answer = await client.eval(`-- VOICE_PROFILE_RAW_INVENTORY_READ
local count = redis.call('SCARD', KEYS[1])
local ids = cjson.decode(ARGV[1]); local paths = cjson.decode(ARGV[2])
table.sort(ids)
local out = {'OK', tostring(count)}; local bytes = 0
for _, id in ipairs(ids) do
  if redis.call('SISMEMBER', KEYS[1], id) ~= 1 then return {'UNAVAILABLE'} end
  local shape = redis.pcall('JSON.TYPE', 'voice_profile:' .. id, '$')
  if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return {'UNAVAILABLE'} end
  local raw = redis.call('JSON.GET', 'voice_profile:' .. id, '$') or '[]'
  bytes = bytes + string.len(raw)
  if string.len(raw) > 65536 or bytes > 262144 then return {'UNAVAILABLE'} end
  out[#out+1] = id; out[#out+1] = redis.sha1hex(raw); out[#out+1] = raw
  for _, path in ipairs(paths) do
    local metadata = redis.call('JSON.GET', 'voice_profile:' .. id, path) or '[]'
    if string.len(metadata) > 16384 then return {'UNAVAILABLE'} end
    out[#out+1] = metadata
  end
end
return out`, { keys: [index], arguments: [JSON.stringify(initialIds), JSON.stringify(fields.map(field => `$.${field}`))] })
    assertSettingsLifecycle(lifecycle)
    if (!Array.isArray(answer) || answer[0] !== 'OK' || typeof answer[1] !== 'string') throw new VoiceProfileInventoryReadError('unavailable')
    const count = Number(answer[1]), stride = fields.length + 3
    if (!Number.isSafeInteger(count) || count < 0 || answer.length !== 2 + initialIds.length * stride) throw new VoiceProfileInventoryReadError('unavailable')
    const profiles: RawVoiceProfile[] = [], seen = new Set<string>()
    let bytes = 0
    for (let offset = 2; offset < answer.length; offset += stride) {
      const id = answer[offset], fingerprint = answer[offset + 1], raw = answer[offset + 2], metadata = answer.slice(offset + 3, offset + stride)
      if (typeof id !== 'string' || !initialIds.includes(id) || seen.has(id) || typeof fingerprint !== 'string' || !/^[a-f0-9]{40}$/.test(fingerprint) ||
          typeof raw !== 'string' || metadata.length !== fields.length || !metadata.every((value): value is string => typeof value === 'string')) throw new VoiceProfileInventoryReadError('unavailable')
      bytes += Buffer.byteLength(raw, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > 65536 || bytes > 262144 || createHash('sha1').update(raw).digest('hex') !== fingerprint) throw new VoiceProfileInventoryReadError('unavailable')
      seen.add(id); profiles.push({ id, fingerprint, raw, metadata })
    }
    return { profiles, count, lifecycle, complete: exactId ? profiles.length === 1 : count === initialIds.length }
  })
}

/** Strict bounded configured-profile source. Keep the existing A10 picker projection/guards.
 * The private collector's full raw strings never enter this returned DTO. */
export async function readConfiguredVoiceProfiles(userId: string, exactId?: string) {
  const index = `user:${userId}:voice_profiles`
  const fields = ['id', 'user_id', 'name', 'provider', 'voiceId', 'model']
  const source = await readRawVoiceProfileInventory(userId, exactId, fields)
  const profiles = []
  for (const item of source.profiles) {
    const { id, fingerprint, metadata: raw } = item
    const profile = Object.fromEntries(fields.map((field, offset) => {
      const value: unknown = JSON.parse(raw[offset]); if (!Array.isArray(value) || value.length > 1) throw new Error('voice_profile_source_unavailable')
      return [field, value[0]]
    }))
    if (profile.id !== id || !validTtsId(id) || profile.user_id != null && profile.user_id !== '' && profile.user_id !== userId ||
      !validTtsId(profile.provider) || !validTtsId(profile.voiceId) || typeof profile.name !== 'string' || !profile.name || Buffer.byteLength(profile.name, 'utf8') > 800 ||
      profile.model != null && profile.model !== '' && !validTtsId(profile.model)) throw new Error('voice_profile_source_unavailable')
    // The original raw row is already bounded and fingerprinted; project only the region,
    // never retain or expose the private workspace endpoint itself.
    const row = JSON.parse(item.raw)[0] as Record<string, unknown>
    const settings = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings) ? row.settings as Record<string, unknown> : undefined
    const common = settings?.common && typeof settings.common === 'object' && !Array.isArray(settings.common) ? settings.common as Record<string, unknown> : undefined
    const endpoint = typeof common?.endpoint === 'string' ? common.endpoint.trim() : ''
    let qwenEndpointRegion: QwenAudioRegion | 'invalid' | null = null
    if (endpoint) { try { qwenEndpointRegion = parseQwenAudioEndpoint(endpoint).region } catch { qwenEndpointRegion = 'invalid' } }
    profiles.push({ id, name: profile.name as string, providerId: profile.provider as string, voiceId: profile.voiceId as string,
      modelId: typeof profile.model === 'string' && profile.model ? profile.model : null,
      ...({ qwenEndpointRegion } as { qwenEndpointRegion?: QwenAudioRegion | 'invalid' | null }),
      guard: { key: `voice_profile:${id}`, path: '$', fingerprint, byteLimit: 65536 },
      metadataGuards: fields.map((field, offset) => ({ key: `voice_profile:${id}`, path: `$.${field}`, raw: raw[offset] as string })), membership: { key: index, member: id, present: true as const } })
  }
  return { profiles, count: source.count, lifecycle: source.lifecycle, complete: source.complete }
}
