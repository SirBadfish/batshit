import type { BackupUploadOwner } from '$lib/types/backupUploadCheck'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
import { resolveClipUploadLocator } from './clipUploadPayload'
import {
  GOON_UPLOAD_TYPES,
  collectGoonUploadReferencesForClient,
  type GoonAssetReferenceMap
} from './goonAssetCleanupService'
import { memoryKey } from './memory/memoryKeys'

/**
 * BL-378: who a problem upload belongs to, for the Admin "Check Upload Files" list. Reads only
 * (`type`, `get`, `json.get`, `keys`, `sMembers`) and every read throws on a Redis error, so a
 * failed read can never look like "no owner". The answer is current-only evidence: "not found"
 * never proves a file is unused and never permits deleting it. No file is opened here, so no
 * Clip or memory image is ever loaded, resolved, or recreated.
 */

/** The owner reads this module needs; the app's Redis client and the test fake both have them. */
export interface OwnerReadClient {
  type(key: string): Promise<string>
  get(key: string): Promise<string | null>
  keys(pattern: string): Promise<string[]>
  sMembers(key: string): Promise<string[]>
  json: { get(key: string, options?: unknown): Promise<unknown> }
}

// The Scene family Goon Asset Cleanup keeps (goonAssetCleanupService.ts SCENE_UPLOAD_TYPES, BL-1025).
const SCENE_UPLOAD_TYPES = new Set([
  'goon_scenes',
  'goon_scene_thumbs',
  'goon_room_shells',
  'goon_room_textures',
  'goon_scene_props'
])
const GOON_TYPES = new Set<string>(GOON_UPLOAD_TYPES)
const AVATAR_OWNER_TYPES = new Set(['user', 'agent', 'subagent', 'group'])
const AVATAR_OWNER_KEYS = { agent: 'agent', subagent: 'subagent', group: 'group' } as const
const NOTHING_TO_DO = 'Batshit keeps this record: it is the only record of the file.'

async function readRecordValue(client: OwnerReadClient, key: string): Promise<unknown> {
  const type = String(await client.type(key)).toLowerCase()
  if (type === 'none') return null
  if (type === 'rejson-rl' || type === 'json') return client.json.get(key)
  if (type === 'string') {
    const raw = await client.get(key)
    if (raw === null) return null
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  // A set, list, hash or sorted set under an owner key is not an owner record.
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function textField(value: unknown, field: string): string | null {
  if (!isObject(value)) return null
  const text = value[field]
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

/** Whether any string anywhere in `value` contains `needle`. */
function mentions(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (mentions(child, needle, seen)) return true
  }
  return false
}

function uploadTypeOf(key: string) {
  const rest = key.slice('upload:'.length)
  const colon = rest.indexOf(':')
  return colon === -1 ? '' : rest.slice(0, colon)
}

function owner(partial: Omit<BackupUploadOwner, 'urgent'> & { urgent?: boolean }): BackupUploadOwner {
  return { urgent: false, ...partial }
}

async function agentName(client: OwnerReadClient, agentId: string) {
  return textField(await readRecordValue(client, `agent:${agentId}`), 'name') ?? `agent ${agentId}`
}

async function describeMemoryMedia(client: OwnerReadClient, key: string): Promise<BackupUploadOwner> {
  const filename = key.slice('upload:memory-media:'.length)
  const match = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/[^/]+$/.exec(filename)
  if (!match) {
    return owner({
      kind: 'memory-media',
      state: 'not-found',
      label: 'A memory image whose name does not follow the memory-image layout.',
      repair: NOTHING_TO_DO
    })
  }
  const [, agentId, memoryId] = match
  const name = await agentName(client, agentId)
  const record = await readRecordValue(client, memoryKey(agentId, memoryId))
  if (!isObject(record)) {
    return owner({
      kind: 'memory-media',
      state: 'not-found',
      label: `No current memory owns this image (memory ${memoryId} of ${name} was not found).`,
      repair: NOTHING_TO_DO
    })
  }
  const media = Array.isArray(record.media) ? record.media : []
  if (!media.some((entry) => isObject(entry) && entry.filename === filename)) {
    return owner({
      kind: 'memory-media',
      state: 'not-found',
      label: `Memory ${memoryId} of ${name} exists but no longer lists this image.`,
      repair: NOTHING_TO_DO
    })
  }
  // The compile loads a standing Awareness image with no fallback, so every send fails now.
  const standing =
    record.lane === 'awareness' &&
    record.media_mode === 'always' &&
    record.is_superseded !== 'y' &&
    !(typeof record.expires_ts === 'number' && record.expires_ts <= Date.now())
  return owner({
    kind: 'memory-media',
    state: 'found',
    label: `Image of memory ${memoryId} of ${name}.`,
    repair: `Settings → Memory → ${name}: open memory ${memoryId}, then remove or replace this image.` +
      (standing ? ' It is a standing Awareness image, so this agent’s replies with memory on fail until it is fixed.' : ''),
    urgent: standing
  })
}

async function describeAvatar(client: OwnerReadClient, key: string, userId: string): Promise<BackupUploadOwner> {
  const rest = key.slice('upload:avatars:'.length)
  const colon = rest.indexOf(':')
  const filename = colon === -1 ? rest : rest.slice(colon + 1)
  const needle = `/uploads/avatars/${filename}`
  const prefixType = colon === -1 ? '' : rest.slice(0, colon)
  const typed = AVATAR_OWNER_TYPES.has(prefixType) ? prefixType : null
  // `<type>_<id>_<timestamp>.jpg` (batshit-server avatarOwnerSweep.js).
  const named = typed ? new RegExp(`^${typed}_(.+)_[0-9]+\\.jpg$`).exec(filename) : null

  if (typed && named) {
    const entityId = named[1]
    if (typed === 'user') {
      // A restore renames user keys but not picture files, so the id in the name may be the
      // source instance's: what the settings show decides, then the name.
      const shown = mentions(await readRecordValue(client, `user:${userId}:settings`), needle)
      const current = shown || entityId === userId
      return owner({
        kind: 'avatar',
        state: current ? 'found' : 'not-found',
        label: shown
          ? 'Your profile picture.'
          : current
            ? 'An older picture of your profile.'
            : 'A profile picture your profile does not show, named for another user id.',
        repair: current ? 'Choose a new profile picture in Settings; saving tidies older pictures.' : NOTHING_TO_DO
      })
    }
    const prefix = AVATAR_OWNER_KEYS[typed as keyof typeof AVATAR_OWNER_KEYS]
    if (prefix) {
      const record = await readRecordValue(client, `${prefix}:${entityId}`)
      if (!isObject(record)) {
        return owner({
          kind: 'avatar',
          state: 'not-found',
          label: `The ${typed} ${entityId} that this picture belonged to no longer exists.`,
          repair: NOTHING_TO_DO
        })
      }
      const name = textField(record, 'name') ?? `${typed} ${entityId}`
      return owner({
        kind: 'avatar',
        state: 'found',
        label: mentions(record, needle) ? `Picture of ${name}.` : `An older picture of ${name}.`,
        repair: `Choose a new picture for ${name} in its settings; saving tidies its older pictures.`
      })
    }
  }

  // An older flat picture (`avatar_<ts>.jpg`) names no owner: look for a current mention.
  const owners: Array<[string, string]> = [[`user:${userId}:settings`, 'your profile']]
  for (const [setKey, prefix] of [
    [`user:${userId}:agents`, 'agent'],
    [`user:${userId}:subagents`, 'subagent'],
    [`user:${userId}:groups`, 'group']
  ] as const) {
    for (const id of await client.sMembers(setKey)) owners.push([`${prefix}:${id}`, `${prefix} ${id}`])
  }
  for (const [ownerKey, fallback] of owners) {
    const record = await readRecordValue(client, ownerKey)
    if (mentions(record, needle)) {
      const name = textField(record, 'name') ?? fallback
      return owner({
        kind: 'avatar',
        state: 'found',
        label: `Picture of ${name}.`,
        repair: `Choose a new picture for ${name} in its settings.`
      })
    }
  }
  return owner({
    kind: 'avatar',
    state: 'not-found',
    label: 'An older picture that no current profile, agent, Subagent or Group shows.',
    repair: NOTHING_TO_DO
  })
}

type ClipIndex = Map<string, { clipId: string; name: string; original: boolean }>

async function buildClipIndex(client: OwnerReadClient, userId: string): Promise<ClipIndex> {
  const index: ClipIndex = new Map()
  const keys = (await client.keys(`clip:${escapeRedisGlob(userId)}:*`)).sort()
  for (const key of keys) {
    const clip = await readRecordValue(client, key)
    if (!isObject(clip)) continue
    const clipId = key.slice(`clip:${userId}:`.length)
    const name = textField(clip, 'filename') ?? clipId
    const main = resolveClipUploadLocator(clip as Parameters<typeof resolveClipUploadLocator>[0])
    if (main && !index.has(main.redisKey)) index.set(main.redisKey, { clipId, name, original: false })
    const fullResolutionUrl = textField(clip, 'fullResolutionUrl')
    const original = fullResolutionUrl ? resolveClipUploadLocator({ localUrl: fullResolutionUrl }) : null
    if (original && !index.has(original.redisKey)) index.set(original.redisKey, { clipId, name, original: true })
  }
  return index
}

function describeClip(key: string, clips: ClipIndex): BackupUploadOwner {
  const clip = clips.get(key)
  if (!clip) {
    return owner({
      kind: 'clip',
      state: 'not-found',
      label:
        'No current Clip points at this file. Chat messages, zips and artifact pages were not searched, ' +
        'so this does not prove the file is unused.',
      repair: NOTHING_TO_DO
    })
  }
  if (clip.original) {
    return owner({
      kind: 'clip-original',
      state: 'found',
      label: `Full-size original of Clip "${clip.name}" (an artifact share).`,
      repair: 'Deleting that Clip does not remove this original yet (BL-327).'
    })
  }
  return owner({
    kind: 'clip',
    state: 'found',
    label: `Clip "${clip.name}".`,
    repair: 'Delete this Clip in the Clip Vault. Memories keep their own image copies, and chats show a Clip Log line.'
  })
}

function describeGoon(key: string, uploadType: string, references: GoonAssetReferenceMap): BackupUploadOwner {
  const filename = key.slice(`upload:${uploadType}:`.length)
  const contexts = Array.from(references.get(`${uploadType}/${filename}`) ?? []).sort()
  const scene = SCENE_UPLOAD_TYPES.has(uploadType)
  if (contexts.length > 0) {
    const shown = contexts.slice(0, 3).join('; ')
    const more = contexts.length > 3 ? `; and ${contexts.length - 3} more` : ''
    return owner({
      kind: scene ? 'goon-scene' : 'goon',
      state: 'found',
      label: `Used by ${shown}${more}.`,
      repair: scene
        ? 'Replace this file in that Scene in Goons.'
        : 'Replace this file where it is used in Goons; Goon Asset Cleanup can then remove the old record.'
    })
  }
  if (scene) {
    return owner({
      kind: 'goon-scene',
      state: 'not-found',
      label: 'No current Scene reference.',
      repair:
        'Kept: a failed or partial settings write may have removed the reference (BL-1025), so Batshit ' +
        'does not treat this file as unused. Nothing can safely repair it yet.'
    })
  }
  return owner({
    kind: 'goon',
    state: 'not-found',
    label: 'No current Goon reference.',
    repair: 'Inspect it in Goon Asset Cleanup, which can remove this record.'
  })
}

async function describeHairImport(client: OwnerReadClient, key: string, userId: string): Promise<BackupUploadOwner> {
  const filename = key.slice('upload:goon_hair_imports:'.length)
  const needle = `/uploads/goon_hair_imports/${filename}`
  const prefix = `hair_import_job:${userId}:`
  for (const jobKey of (await client.keys(`hair_import_job:${escapeRedisGlob(userId)}:*`)).sort()) {
    const job = await readRecordValue(client, jobKey)
    if (!mentions(job, needle)) continue
    const status = textField(job, 'status')
    return owner({
      kind: 'hair-import',
      state: 'found',
      label: `Staging file of hair import ${jobKey.slice(prefix.length)}${status ? ` (${status})` : ''}.`,
      repair: 'Finish or cancel that hair import in Goons.'
    })
  }
  return owner({
    kind: 'hair-import',
    state: 'not-found',
    label: 'No hair import job uses this staging file.',
    repair: NOTHING_TO_DO
  })
}

const CLIP_UPLOAD_TYPES = new Set(['images', 'videos', 'documents'])

function ownerKindOf(uploadType: string): BackupUploadOwner['kind'] {
  if (uploadType === 'memory-media') return 'memory-media'
  if (uploadType === 'avatars') return 'avatar'
  if (uploadType === 'goon_hair_imports') return 'hair-import'
  if (SCENE_UPLOAD_TYPES.has(uploadType)) return 'goon-scene'
  if (GOON_TYPES.has(uploadType)) return 'goon'
  if (CLIP_UPLOAD_TYPES.has(uploadType)) return 'clip'
  return 'unknown'
}

/**
 * One owner per problem key, read once per owner family. A lookup that fails says so for its
 * own rows (`lookup-failed`, with the reason) and never becomes "not found"; the other rows and
 * the problem list itself still show.
 */
export async function describeUploadOwners(
  client: OwnerReadClient,
  userId: string,
  keys: readonly string[]
): Promise<Map<string, BackupUploadOwner>> {
  const owners = new Map<string, BackupUploadOwner>()
  // Promises, so a failed family read fails each of its rows once, without reading again.
  let clips: Promise<ClipIndex> | null = null
  let goonReferences: Promise<GoonAssetReferenceMap> | null = null

  for (const key of keys) {
    if (owners.has(key)) continue
    const uploadType = uploadTypeOf(key)
    try {
      if (uploadType === 'memory-media') {
        owners.set(key, await describeMemoryMedia(client, key))
      } else if (uploadType === 'avatars') {
        owners.set(key, await describeAvatar(client, key, userId))
      } else if (uploadType === 'goon_hair_imports') {
        owners.set(key, await describeHairImport(client, key, userId))
      } else if (GOON_TYPES.has(uploadType)) {
        goonReferences ??= collectGoonUploadReferencesForClient(
          client as unknown as Parameters<typeof collectGoonUploadReferencesForClient>[0],
          userId
        )
        owners.set(key, describeGoon(key, uploadType, await goonReferences))
      } else if (CLIP_UPLOAD_TYPES.has(uploadType)) {
        clips ??= buildClipIndex(client, userId)
        owners.set(key, describeClip(key, await clips))
      }
    } catch (error) {
      // A TypeError or ReferenceError (a coding bug, or a record so malformed the Goon reference
      // walk cannot iterate it) fails the whole check, closed. Failed reads and bad URLs become rows.
      if (error instanceof TypeError || error instanceof ReferenceError) throw error
      const reason = (error instanceof Error ? error.message : 'unknown error').slice(0, 200)
      owners.set(
        key,
        owner({
          kind: ownerKindOf(uploadType),
          state: 'lookup-failed',
          label: `Batshit could not look up what this file belongs to (${reason}).`,
          repair: 'Run Check Upload Files again; if it keeps failing, that reason is the place to start.'
        })
      )
      continue
    }
    if (!owners.has(key)) {
      owners.set(
        key,
        owner({
          kind: 'unknown',
          state: 'not-found',
          label: `No known owner for "${uploadType || 'unnamed'}" uploads.`,
          repair: NOTHING_TO_DO
        })
      )
    }
  }
  return owners
}
