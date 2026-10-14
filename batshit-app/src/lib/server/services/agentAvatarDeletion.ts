import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  normalizeUploadUrlForStorage
} from '$lib/server/services/batshitServerUrls'

/**
 * BL-41 (2026-09-22): deleting an agent deletes its avatar pictures. Since 2026-09-25 the same
 * holds for a Subagent (BL-139) and a Group (BL-140), and a living owner is tidied after a
 * settings save changes its picture (BL-142, `tidyOwnerAvatars`).
 *
 * The pictures are batshit-server's: `POST /api/upload/avatar` writes the record
 * (`upload:avatars:agent:agent_<id>_<timestamp>.jpg`) and the file, and names every one after
 * the agent, replaced ones included. So the agent delete asks batshit-server to sweep them
 * (`DELETE /api/upload/avatar`, service token, server to server) BEFORE the agent record goes,
 * the same order as the agent's memory media: when batshit-server cannot, the agent stays and
 * the user is told why, and a retry finishes the job. Deleting the record first is what left
 * Bob's three pictures with nothing pointing at them. Before anything at all is deleted (the
 * chats go first), `checkBatshitServerCanDeleteAvatars` makes sure batshit-server answers and
 * its Redis is ready, so a stopped batshit-server refuses the whole delete. Every call has a
 * time limit (`BATSHIT_SERVER_CALL_TIMEOUT_MS`), so a hung batshit-server cannot hold it.
 *
 * batshit-server finds the agent's own pictures by name, so nothing is sent for those. A
 * picture from before 2025-08-12 (`avatar_<timestamp>.jpg`) names no owner: only the agent
 * record points at it, so this module sends that name along, unless the user or another
 * agent, Subagent, or Group points at the same file, in which case it stays (and is reported
 * as `keptSharedLegacy`).
 */

const AVATAR_UPLOAD_PATH = '/uploads/avatars/'
const LEGACY_FLAT_AVATAR_FILENAME = /^avatar_[0-9]{1,20}\.jpg$/
const SAFE_AVATAR_FILENAME = /^[A-Za-z0-9._-]+$/
// batshit-server's owner id rule (`avatarOwnerSweep.js`): the only ids an avatar upload
// accepts since BL-143, and the only ids its owner sweep will look for.
const AVATAR_OWNER_ID = /^[A-Za-z0-9_-]+$/

/** The owners whose pictures are swept when they are deleted, or tidied after a save. */
export type AvatarOwnerType = 'agent' | 'subagent' | 'group'

/** The owners a settings save tidies: the user too, who is never deleted (BL-281). */
export type AvatarTidyOwnerType = AvatarOwnerType | 'user'

const OWNER_LABELS: Record<AvatarTidyOwnerType, string> = {
  agent: 'agent',
  subagent: 'Subagent',
  group: 'Group',
  user: 'user'
}

/**
 * Whether an id meets the owner id rule. An owner whose id does not can have no picture the
 * upload route stored for it since BL-143 (it refuses such ids), and batshit-server's sweep
 * refuses to look for one, so its delete skips the sweep instead of failing.
 */
export function isAvatarOwnerId(id: unknown): id is string {
  return typeof id === 'string' && AVATAR_OWNER_ID.test(id)
}

/** Whether `filename` is exactly one of this owner's own pictures, `<type>_<id>_<digits>.jpg`. */
export function isOwnAvatarFilename(type: AvatarOwnerType | 'user', id: string, filename: string) {
  const prefix = `${type}_${id}_`
  return filename.startsWith(prefix) && /^[0-9]+\.jpg$/.test(filename.slice(prefix.length))
}

/**
 * How long one call to batshit-server may take before the agent delete gives up on it.
 * Without a limit a hung batshit-server held the delete (and the Settings button) for minutes.
 */
export const BATSHIT_SERVER_CALL_TIMEOUT_MS = 15_000

export type AgentAvatarDeletionErrorCode = 'agent_avatar_delete_failed' | 'batshit_server_unavailable'

/** A refusal an owner's delete (or a tidy) can show; the name is from BL-41's agent delete. */
export class AgentAvatarDeletionError extends Error {
  readonly code: AgentAvatarDeletionErrorCode
  readonly status: number

  constructor(
    message: string,
    status: number,
    code: AgentAvatarDeletionErrorCode = 'agent_avatar_delete_failed'
  ) {
    super(message)
    this.name = 'AgentAvatarDeletionError'
    this.status = status
    this.code = code
  }
}

/** A call that did not produce an answer: `reason` reads as a clause, `status` is ours. */
class BatshitServerCallError extends Error {
  readonly status: number

  constructor(reason: string, status: number) {
    super(reason)
    this.name = 'BatshitServerCallError'
    this.status = status
  }
}

function describeWait(ms: number) {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`
}

function failureCause(error: unknown) {
  if (error instanceof Error && error.cause instanceof Error) return error.cause.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * One call to batshit-server: the service token, a time limit that covers the answer's body
 * too, and a failure that says what happened (did not answer, or not in time).
 */
async function callBatshitServer(
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number
): Promise<{ response: Response; text: string }> {
  let headers: Record<string, string>
  try {
    headers = { ...init.headers, ...getInternalBatshitServerAuthHeaders() }
  } catch (error) {
    throw new BatshitServerCallError(failureCause(error).replace(/\.$/, ''), 500)
  }
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(`${getInternalBatshitServerUrl()}${path}`, { ...init, headers, signal })
    return { response, text: await response.text() }
  } catch (error) {
    if (signal.aborted) {
      throw new BatshitServerCallError(`batshit-server did not answer within ${describeWait(timeoutMs)}`, 503)
    }
    throw new BatshitServerCallError(`batshit-server did not answer (${failureCause(error)})`, 503)
  }
}

/**
 * Before the agent delete removes ANYTHING (its chats go first, and "Also delete its chats"
 * is on by default): batshit-server answers and its Redis is ready. `GET /health` answers 503
 * when its Redis is not connected, which is exactly when its sweep would refuse too. The sweep
 * can still fail later (the route's error then says how many chats already went); this check
 * turns the common case, batshit-server not running, into a refusal that deletes nothing.
 */
export async function checkBatshitServerCanDeleteAvatars(
  options: { timeoutMs?: number } = {}
): Promise<void> {
  let result: { response: Response; text: string }
  try {
    result = await callBatshitServer(
      '/health',
      { method: 'GET' },
      options.timeoutMs ?? BATSHIT_SERVER_CALL_TIMEOUT_MS
    )
  } catch (error) {
    if (error instanceof BatshitServerCallError) {
      throw new AgentAvatarDeletionError(`${error.message}.`, error.status, 'batshit_server_unavailable')
    }
    throw error
  }
  let health: { ok?: unknown; checks?: { redis?: unknown } } | null = null
  try {
    health = JSON.parse(result.text)
  } catch {
    health = null
  }
  if (result.response.ok && health?.ok === true) return
  throw new AgentAvatarDeletionError(
    health?.checks?.redis === false
      ? `batshit-server is running, but its Redis is not ready (its health check answered ${result.response.status}).`
      : `batshit-server's health check answered ${result.response.status}${result.text ? ` (${describeFailure(result.text)})` : ''}.`,
    503,
    'batshit_server_unavailable'
  )
}

export interface AgentAvatarDeletionResult {
  deletedRecords: string[]
  deletedFiles: string[]
  /** Legacy flat pictures the agent pointed at that something else points at too. */
  keptSharedLegacy: string[]
}

type AgentAvatarFields = { id: string; avatar?: unknown; avatar_url?: unknown }
type OwnerAvatarFields = AgentAvatarFields & { type: AvatarOwnerType }
type TidyOwnerAvatarFields = AgentAvatarFields & {
  type: AvatarTidyOwnerType
  /** The owner's own picture the save replaced (BL-288), or null. */
  replacedFilename?: string | null
}

/** The `avatars/` filename an avatar URL (stored `/uploads/...` or absolute) names, or null. */
export function avatarUploadFilename(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const uploadPath = normalizeUploadUrlForStorage(value).split(/[?#]/)[0]
  if (!uploadPath.startsWith(AVATAR_UPLOAD_PATH)) return null
  let filename: string
  try {
    filename = decodeURIComponent(uploadPath.slice(AVATAR_UPLOAD_PATH.length))
  } catch {
    return null
  }
  return SAFE_AVATAR_FILENAME.test(filename) && !filename.includes('..') ? filename : null
}

function collectAvatarFilenames(value: unknown, found: Set<string>) {
  if (typeof value === 'string') {
    const filename = avatarUploadFilename(value)
    if (filename) found.add(filename)
  } else if (Array.isArray(value)) {
    for (const item of value) collectAvatarFilenames(item, found)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectAvatarFilenames(item, found)
  }
}

/**
 * A record read that THROWS on a Redis error. `redis.get` answers null instead, which here
 * would read as "nothing else shows this picture" and delete a picture that is still in use.
 */
async function readRecord(client: any, key: string): Promise<unknown> {
  const type = await client.type(key)
  if (type === 'none') return null
  if (type === 'ReJSON-RL' || type === 'json' || type === 'JSON') return client.json.get(key)
  if (type === 'string') {
    const raw = await client.get(key)
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  throw new Error(`${key} is a Redis ${type}, not a record`)
}

/**
 * Every avatar filename the user's other records point at, in any field: the user settings,
 * the agents, the Subagents, and the Groups, except the owner being deleted. Read only when
 * the owner points at a legacy flat picture (almost never), and a mention anywhere counts,
 * the safe direction.
 */
async function avatarFilenamesReferencedElsewhere(userId: string, owner: { type: AvatarOwnerType; id: string }) {
  return redis.execute(async (client: any) => {
    const found = new Set<string>()
    collectAvatarFilenames(await readRecord(client, `user:${userId}:settings`), found)
    const owners: Array<[string, AvatarOwnerType]> = [
      [`user:${userId}:agents`, 'agent'],
      [`user:${userId}:subagents`, 'subagent'],
      [`user:${userId}:groups`, 'group']
    ]
    for (const [setKey, prefix] of owners) {
      for (const id of await client.sMembers(setKey)) {
        if (prefix === owner.type && id === owner.id) continue
        collectAvatarFilenames(await readRecord(client, `${prefix}:${id}`), found)
      }
    }
    return found
  })
}

function describeFailure(details: string) {
  return details.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * One owner-sweep call to batshit-server (`DELETE /api/upload/avatar`) and its answer, or an
 * `AgentAvatarDeletionError` that says what went wrong in the owner's words.
 */
async function requestOwnerSweep(
  body: Record<string, unknown>,
  what: string,
  timeoutMs: number
): Promise<{ deletedRecords: string[]; deletedFiles: string[] }> {
  let response: Response
  let text: string
  try {
    ;({ response, text } = await callBatshitServer(
      '/api/upload/avatar',
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      },
      timeoutMs
    ))
  } catch (error) {
    if (error instanceof BatshitServerCallError) {
      throw new AgentAvatarDeletionError(`Could not delete ${what}: ${error.message}.`, error.status)
    }
    throw error
  }

  let payload: Record<string, unknown> | null = null
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    payload = null
  }
  if (!response.ok) {
    const details = (
      payload
        ? [payload.error, payload.details].filter((part) => typeof part === 'string' && part).join(': ')
        : describeFailure(text)
    ).replace(/\.$/, '')
    throw new AgentAvatarDeletionError(
      `Could not delete ${what}: batshit-server answered ${response.status}${details ? ` (${details})` : ''}.`,
      response.status === 503 ? 503 : 502
    )
  }

  return {
    deletedRecords: Array.isArray(payload?.deletedRecords) ? (payload.deletedRecords as string[]) : [],
    deletedFiles: Array.isArray(payload?.deletedFiles) ? (payload.deletedFiles as string[]) : []
  }
}

/**
 * Delete every avatar picture of an agent, Subagent, or Group that is being deleted. Call it
 * BEFORE the owner's record goes: when batshit-server cannot, the owner stays and a retry
 * finishes the job.
 */
export async function deleteOwnerAvatars(
  userId: string,
  owner: OwnerAvatarFields,
  options: { timeoutMs?: number } = {}
): Promise<AgentAvatarDeletionResult> {
  const pointedAt = new Set<string>()
  for (const value of [owner.avatar, owner.avatar_url]) {
    const filename = avatarUploadFilename(value)
    if (filename && LEGACY_FLAT_AVATAR_FILENAME.test(filename)) pointedAt.add(filename)
  }
  const label = OWNER_LABELS[owner.type]
  const keptSharedLegacy: string[] = []
  const legacyFilenames: string[] = []
  if (pointedAt.size > 0) {
    let elsewhere: Set<string>
    try {
      elsewhere = await avatarFilenamesReferencedElsewhere(userId, owner)
    } catch (error) {
      throw new AgentAvatarDeletionError(
        `Could not check whether anything else shows this ${label}'s old avatar picture: ${error instanceof Error ? error.message : String(error)}.`,
        500
      )
    }
    for (const filename of pointedAt) {
      if (elsewhere.has(filename)) keptSharedLegacy.push(filename)
      else legacyFilenames.push(filename)
    }
  }

  const swept = await requestOwnerSweep(
    { entityType: owner.type, entityId: owner.id, legacyFilenames },
    `this ${label}'s avatar pictures`,
    options.timeoutMs ?? BATSHIT_SERVER_CALL_TIMEOUT_MS
  )
  return { ...swept, keptSharedLegacy }
}

export async function deleteAgentAvatars(
  userId: string,
  agent: AgentAvatarFields,
  options: { timeoutMs?: number } = {}
): Promise<AgentAvatarDeletionResult> {
  return deleteOwnerAvatars(userId, { type: 'agent', ...agent }, options)
}

export interface OwnerAvatarTidyResult {
  deletedRecords: string[]
  deletedFiles: string[]
  /** The owner's own pictures its saved record shows, which stay. */
  kept: string[]
}

/**
 * BL-142 (2026-09-25): after a settings save, delete every picture of this owner except the
 * one its SAVED record shows. Clearing an avatar, choosing an icon, or uploading a new picture
 * used to leave the old picture stored for as long as the owner lived. Pass the record as it
 * is stored now, never the browser's form: the save is what decides which picture stays.
 *
 * Only the owner's own pictures (`<type>_<id>_<digits>.jpg`) can go, since batshit-server
 * finds them by name; a legacy flat picture or another owner's picture the record shows is
 * never at risk, so it is not named. Nothing is deleted at upload time any more (BL-145; the
 * user and Groups since BL-281), so a save the form refuses leaves the saved picture in place.
 * batshit-server also leaves every picture that may still be on its way to a save (BL-288):
 * one uploaded after the kept picture, or with none kept one uploaded after the replaced
 * picture (`replacedFilename`, from the panel), or with neither one younger than ten minutes.
 */
export async function tidyOwnerAvatars(
  owner: TidyOwnerAvatarFields,
  options: { timeoutMs?: number } = {}
): Promise<OwnerAvatarTidyResult> {
  const kept = new Set<string>()
  for (const value of [owner.avatar, owner.avatar_url]) {
    const filename = avatarUploadFilename(value)
    if (filename && isOwnAvatarFilename(owner.type, owner.id, filename)) kept.add(filename)
  }
  const replaced =
    owner.replacedFilename && isOwnAvatarFilename(owner.type, owner.id, owner.replacedFilename)
      ? owner.replacedFilename
      : null
  const swept = await requestOwnerSweep(
    {
      tidy: true,
      entityType: owner.type,
      entityId: owner.id,
      keepFilenames: [...kept],
      ...(replaced ? { replacedFilename: replaced } : {})
    },
    owner.type === 'user' ? 'your old avatar pictures' : `this ${OWNER_LABELS[owner.type]}'s old avatar pictures`,
    options.timeoutMs ?? BATSHIT_SERVER_CALL_TIMEOUT_MS
  )
  return { ...swept, kept: [...kept] }
}
