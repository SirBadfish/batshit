/**
 * SA-104 episode ledger (preflight §6.3; DL-104-07).
 *
 * Episodes are session-scoped work chapters for Infinite Sessions: at most one open episode
 * per session, closed by an explicit boundary signal, graduated later by nap/dreaming.
 * The whiteboard rides the open episode and is dissolved at close — kept on the record,
 * no longer compiled (DL-104-02: nothing is silently destroyed).
 *
 * Lifecycle obligations (DL-104-13): `episode:{sessionId}:{episodeId}` and
 * `session:{sessionId}:episodes` are enumerated by `redis.deleteSession` and belong to
 * the Backup/Restore `memory` group.
 *
 * Write contract (SA-110 DL-110-04): only `openEpisode` may write the whole document.
 * Every updater writes ONLY its own field(s) via path-scoped JSON.SET, because episode
 * updaters are broker tools that models emit as PARALLEL tool calls — Bob's overnight
 * drift was `hold_episode` full-doc-writing a pre-rewrite read 52 ms after
 * `sys.memory.whiteboard` landed, silently restoring the old board. A full-document
 * read-modify-write here is a data-loss bug, not a style choice.
 */

import { redis } from '$lib/server/redis'
import { isFixedSession } from '$lib/utils/fixedSession'
import { resolveMemoryIdleGapHours } from '$lib/utils/memoryControl'
import { MEMORY_SCHEMA_VERSION } from './memoryTypes'

export type EpisodeState = 'open' | 'closed' | 'graduated'

export type EpisodeBoundarySignal =
  | 'agent_mark'
  | 'idle_gap'
  | 'continue_tomorrow_hold'
  | 'nap'
  | 'dreaming'

export interface EpisodeRecord {
  id: string
  session_id: string
  agent_id: string
  state: EpisodeState
  opened_at: string
  closed_at?: string | null
  boundary_signal?: EpisodeBoundarySignal | null
  /** A "continue tomorrow" hold keeps the episode OPEN past idle gaps. */
  hold_until?: string | null
  first_message_id?: string | null
  last_message_id?: string | null
  /**
   * SA-104 P6: stamped at every accepted send by `ensureFixedSessionOpenEpisode` so
   * idle-gap boundary detection has a cheap truth source (additive; absent falls back
   * to `opened_at`).
   */
  last_activity_at?: string | null
  whiteboard?: { content: string; updated_at: string } | null
  schema_version: typeof MEMORY_SCHEMA_VERSION
}

export function episodeKey(sessionId: string, episodeId: string): string {
  return `episode:${sessionId}:${episodeId}`
}

export function sessionEpisodesKey(sessionId: string): string {
  return `session:${sessionId}:episodes`
}

function randomIdSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

export async function getEpisode(sessionId: string, episodeId: string): Promise<EpisodeRecord | null> {
  return (await redis.json.get(episodeKey(sessionId, episodeId))) as EpisodeRecord | null
}

/** Ledger order (oldest first, from the session's episode list). */
export async function listEpisodes(sessionId: string): Promise<EpisodeRecord[]> {
  return redis.execute(async (client) => {
    const ids = await client.lRange(sessionEpisodesKey(sessionId), 0, -1)
    const records: EpisodeRecord[] = []
    for (const id of ids) {
      const record = (await client.json.get(episodeKey(sessionId, id))) as unknown as EpisodeRecord | null
      if (record) records.push(record)
    }
    return records
  })
}

export async function getOpenEpisode(sessionId: string): Promise<EpisodeRecord | null> {
  const episodes = await listEpisodes(sessionId)
  return episodes.find((episode) => episode.state === 'open') ?? null
}

export async function openEpisode(input: {
  session_id: string
  agent_id: string
  first_message_id?: string | null
}): Promise<EpisodeRecord> {
  if (!input.session_id?.trim()) throw new Error('Episodes require session_id.')
  if (!input.agent_id?.trim()) throw new Error('Episodes require agent_id.')

  const alreadyOpen = await getOpenEpisode(input.session_id)
  if (alreadyOpen) {
    throw new Error(
      `Session ${input.session_id} already has open episode ${alreadyOpen.id}; close it before opening another.`
    )
  }

  const now = new Date()
  const record: EpisodeRecord = {
    id: `ep_${now.getTime()}_${randomIdSuffix()}`,
    session_id: input.session_id,
    agent_id: input.agent_id,
    state: 'open',
    opened_at: now.toISOString(),
    first_message_id: input.first_message_id ?? null,
    last_message_id: input.first_message_id ?? null,
    last_activity_at: now.toISOString(),
    whiteboard: null,
    schema_version: MEMORY_SCHEMA_VERSION
  }

  await redis.json.set(episodeKey(record.session_id, record.id), '$', record as never)
  await redis.rPush(sessionEpisodesKey(record.session_id), record.id)
  return record
}

async function requireEpisode(sessionId: string, episodeId: string): Promise<EpisodeRecord> {
  const record = await getEpisode(sessionId, episodeId)
  if (!record) throw new Error(`Episode ${episodeId} not found for session ${sessionId}.`)
  return record
}

export async function updateEpisodeBounds(
  sessionId: string,
  episodeId: string,
  updates: { last_message_id?: string; hold_until?: string | null }
): Promise<EpisodeRecord> {
  const record = await requireEpisode(sessionId, episodeId)
  if (record.state !== 'open') {
    throw new Error(`Episode ${episodeId} is ${record.state}; only open episodes accept bound updates.`)
  }
  const key = episodeKey(sessionId, episodeId)
  if (updates.last_message_id !== undefined) {
    record.last_message_id = updates.last_message_id
    await redis.json.set(key, '$.last_message_id', updates.last_message_id as never)
  }
  if (updates.hold_until !== undefined) {
    if (updates.hold_until !== null && !Number.isFinite(new Date(updates.hold_until).getTime())) {
      throw new Error(`Episode hold_until is not a valid timestamp: '${updates.hold_until}'.`)
    }
    record.hold_until = updates.hold_until
    await redis.json.set(key, '$.hold_until', updates.hold_until as never)
  }
  return record
}

/** The whiteboard lives only on the OPEN episode; closing dissolves it (kept, not compiled). */
export async function updateEpisodeWhiteboard(
  sessionId: string,
  episodeId: string,
  content: string | null
): Promise<EpisodeRecord> {
  const record = await requireEpisode(sessionId, episodeId)
  if (record.state !== 'open') {
    throw new Error(`Episode ${episodeId} is ${record.state}; the whiteboard belongs to the open episode.`)
  }
  record.whiteboard = content === null ? null : { content, updated_at: new Date().toISOString() }
  await redis.json.set(episodeKey(sessionId, episodeId), '$.whiteboard', record.whiteboard as never)
  return record
}

export async function closeEpisode(
  sessionId: string,
  episodeId: string,
  boundarySignal: EpisodeBoundarySignal
): Promise<EpisodeRecord> {
  const record = await requireEpisode(sessionId, episodeId)
  if (record.state !== 'open') {
    throw new Error(`Episode ${episodeId} is already ${record.state}.`)
  }
  record.state = 'closed'
  record.closed_at = new Date().toISOString()
  record.boundary_signal = boundarySignal
  record.hold_until = null
  // One MULTI so the close transition lands whole — a crash between field writes
  // must not leave a closed episode still carrying its hold.
  const key = episodeKey(sessionId, episodeId)
  await redis.execute(async (client) => {
    await client
      .multi()
      .json.set(key, '$.state', 'closed' as never)
      .json.set(key, '$.closed_at', record.closed_at as never)
      .json.set(key, '$.boundary_signal', boundarySignal as never)
      .json.set(key, '$.hold_until', null as never)
      .exec()
  })
  return record
}

/**
 * SA-104 P5/P6 — lazy episode lifecycle at the accepted-send boundary. An Infinite Session
 * always has one open episode while it is being lived in; the first send opens
 * episode 1, and the send after an agent-marked close opens the next. P6 adds the
 * idle-gap boundary (design §1.3 "sleep/idle gaps"): when the open episode's last
 * activity is older than the agent's idle gap and no future "continue tomorrow" hold
 * is set, the episode closes (`boundary_signal: 'idle_gap'`) and a fresh one opens.
 * Closing never graduates — graduation stays a nap/dreaming decision (DL-104-07).
 * Every call stamps `last_activity_at` on the open episode. Regular sessions never
 * get episodes (returns null without touching Redis). Callers pass the
 * already-loaded session record so this helper never re-reads it.
 */
export async function ensureFixedSessionOpenEpisode(options: {
  session: unknown
  sessionId: string
  agentId: string
  firstMessageId?: string | null
  /** Injectable clock for deterministic tests. */
  now?: Date
}): Promise<EpisodeRecord | null> {
  if (!isFixedSession(options.session)) return null
  if (!options.sessionId?.trim() || !options.agentId?.trim()) return null

  const now = options.now ?? new Date()
  let open = await getOpenEpisode(options.sessionId)

  // 2026-08-29: an Infinite Session belongs to ONE agent. The chat-bar picker is
  // frozen client-side; this backstop refuses a side-door send from a different
  // agent instead of silently splicing a second brain into the episode stream.
  if (open && open.agent_id !== options.agentId) {
    throw new Error(
      `This Infinite Session belongs to agent ${open.agent_id}; sends from agent ${options.agentId} are refused.`
    )
  }

  if (open) {
    const agent = (await redis.get(`agent:${options.agentId}`).catch(() => null)) as
      | Record<string, any>
      | null
    const idleGapMs = resolveMemoryIdleGapHours(agent) * 3_600_000
    const holdTs = open.hold_until ? new Date(open.hold_until).getTime() : Number.NaN
    const holdActive = Number.isFinite(holdTs) && holdTs > now.getTime()
    const lastActivityTs = new Date(open.last_activity_at ?? open.opened_at).getTime()
    if (
      !holdActive &&
      Number.isFinite(lastActivityTs) &&
      now.getTime() - lastActivityTs > idleGapMs
    ) {
      await closeEpisode(options.sessionId, open.id, 'idle_gap')
      open = null
    }
  }

  if (!open) {
    open = await openEpisode({
      session_id: options.sessionId,
      agent_id: options.agentId,
      first_message_id: options.firstMessageId ?? null
    })
  }

  open.last_activity_at = now.toISOString()
  await redis.json.set(
    episodeKey(options.sessionId, open.id),
    '$.last_activity_at',
    open.last_activity_at as never
  )
  return open
}

/** Graduation marks a CLOSED episode whose content was written to a memory segment. */
export async function markEpisodeGraduated(sessionId: string, episodeId: string): Promise<EpisodeRecord> {
  const record = await requireEpisode(sessionId, episodeId)
  if (record.state !== 'closed') {
    throw new Error(
      `Episode ${episodeId} is ${record.state}; only closed episodes graduate (open episodes never graduate).`
    )
  }
  record.state = 'graduated'
  await redis.json.set(episodeKey(sessionId, episodeId), '$.state', 'graduated' as never)
  return record
}
