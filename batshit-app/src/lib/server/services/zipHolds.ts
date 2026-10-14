/**
 * SA-129 P2 — the server's writer for zip state an AGENT changes at the end of a reply, and for
 * the countdown of temporary holds.
 *
 * - **Hold and release (DL-02).** An agent holds a file by its path in the Tool Notes block
 *   (`"hold": ["src/app.ts"]`). The hold is the existing manual state, an `unzipped_item` with
 *   `source: 'agent'`, `permanent: true`, and two optional fields, `path` (the dead-copy ledger's
 *   key for the file) and `agentId`, on the NEWEST WHOLE READ of that file by that agent. At every
 *   reply end the hold follows the file: it moves to a newer whole read, and the older copy then
 *   compresses as a dead copy (DL-01). `release` clears it, exactly like the Zip Manager's return
 *   to automatic. The user wins: an agent never releases, overrides, or re-holds what the user
 *   holds or zipped by hand.
 * - **The parked zip-control actions (DL-06).** `unzip` / `zip` by zip id, applied only when the
 *   hidden zip-control permission is ON, with the chat page's old rules.
 * - **The countdown (DL-08).** One count per message the chat gains (`advanceZipCountdowns`).
 *
 * It writes the very keys the `/api/unzipping` routes and `zipStateInferred.ts` write, in the
 * same shapes, so the compiler, the badges, the Zip Manager, session deletion, and backup need no
 * new key and no new sweep:
 *
 *   unzipped:{sessionId}                 set of zip ids held open
 *   unzipped_item:{sessionId}:{zipId}    { zipId, sessionId, permanent, source, path?, agentId?, … }
 *   rezipped:{sessionId}                 set of zip ids forced compressed
 *   rezipped_item:{sessionId}:{zipId}    { zipId, sessionId, source, rezippedAt }
 *
 * Keys use the NORMALIZED zip id, the id `compileForAI` looks zip state up by.
 */

import { redis } from '$lib/server/redis'
import { listCompilableZips } from '$lib/services/messageCompiler'
import { countOneMoreMessage, isZipStateSource, type UnzippedItem, type ZipStateSource } from '$lib/services/zipping'
import { buildControlErrorRecord, type ControlErrorRecord } from '$lib/utils/controlTags'
import { parseCoolToolPayload } from '$lib/utils/coolToolAiContent'
import { normalizeId } from '$lib/utils/idNormalizer'
import { TOOL_NOTES_BLOCK_HINT } from '$lib/utils/replyControl'
import type { ToolNotesHoldBlock } from '$lib/utils/zipControl'
import {
  describeHeldPath,
  describeToolResultFiles,
  holdPathKeys,
  type DeadCopyToolResult
} from '$lib/utils/zipDeadCopies'
import { resolveZipControlZipIds } from '$lib/utils/zipControl'
import { collectTrustedZipIdsFromMetadata } from '$lib/utils/zipReferenceSafety'
import { withZipStateLock } from './zipStateLock'
import { tooLargeCoolToolHoldTokens } from './toolResultHoldAdmission'
import { resolveSessionZipForHold } from './resolveSessionZipForHold'

const HOLD_TAG = 'batshit-tool-notes'

// ---------------------------------------------------------------------------------------------
// Session zip state

async function loadUnzippedItems(sessionId: string): Promise<UnzippedItem[]> {
  const ids = (await redis.sMembers(`unzipped:${sessionId}`)) ?? []
  const items: UnzippedItem[] = []
  for (const zipId of ids) {
    const raw = (await redis.get(`unzipped_item:${sessionId}:${zipId}`)) as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') continue
    items.push({ permanent: false, unzippedAt: 0, ...(raw as any), zipId, sessionId })
  }
  return items
}

async function readRezipSource(sessionId: string, zipId: string): Promise<ZipStateSource | null> {
  const raw = (await redis.get(`rezipped_item:${sessionId}:${zipId}`)) as { source?: unknown } | null
  if (!raw) {
    const marked = ((await redis.sMembers(`rezipped:${sessionId}`)) ?? []).includes(zipId)
    return marked ? 'user' : null
  }
  // A marker with no readable source predates sources and was always the user's.
  return isZipStateSource(raw.source) ? raw.source : 'user'
}

/**
 * Clears every manual record of one zip: the automatic rules decide again ("Release").
 *
 * One MULTI (BL-537): a lost connection or a queueing error lands none of the four writes (an
 * error inside EXEC, a WRONGTYPE say, still applies the others). As four separate writes, a
 * Redis error after the first left an item record with no set member (a hold no reader sees, and
 * no Release can reach), and the step reported nothing written.
 */
async function returnToAutomatic(sessionId: string, zipId: string): Promise<void> {
  await redis.execute(async (client) => {
    await client
      .multi()
      .sRem(`unzipped:${sessionId}`, zipId)
      .del(`unzipped_item:${sessionId}:${zipId}`)
      .sRem(`rezipped:${sessionId}`, zipId)
      .del(`rezipped_item:${sessionId}:${zipId}`)
      .exec()
  })
}

/** A hold's four writes, one MULTI for the same reason (BL-537): a set member never lacks its record. */
async function writeUnzippedItem(sessionId: string, item: UnzippedItem): Promise<void> {
  await redis.execute(async (client) => {
    await client
      .multi()
      .sAdd(`unzipped:${sessionId}`, item.zipId)
      .sRem(`rezipped:${sessionId}`, item.zipId)
      .del(`rezipped_item:${sessionId}:${item.zipId}`)
      .json.set(`unzipped_item:${sessionId}:${item.zipId}`, '$', item as any)
      .exec()
  })
}

function zipLabels(zipData: any): Pick<UnzippedItem, 'name' | 'description' | 'tokens'> {
  const name = zipData?.metadata?.toolName ?? zipData?.name
  const description = zipData?.description ?? zipData?.metadata?.description
  const tokens =
    typeof zipData?.tokens === 'number'
      ? zipData.tokens
      : typeof zipData?.metadata?.tokens === 'number'
        ? zipData.metadata.tokens
        : undefined
  return {
    ...(typeof name === 'string' && name ? { name } : {}),
    ...(typeof description === 'string' && description ? { description } : {}),
    ...(typeof tokens === 'number' ? { tokens } : {})
  }
}

function isUserOwned(source: unknown): boolean {
  // An item with no readable source predates sources and was always the user's.
  return source === 'user' || !isZipStateSource(source)
}

// ---------------------------------------------------------------------------------------------
// An agent being deleted holds nothing (BL-606)

/**
 * The agents whose delete is under way in this process, counted (two deletes of one agent can
 * overlap). `redis.deleteAgent` marks the agent BEFORE `releaseDeletedAgentHolds` and lets go only
 * after the record is deleted (`markAgentBeingDeleted`), because the release goes chat by chat: a
 * turn of the agent still running (in a group chat, a kept locked chat, or any chat when "Also
 * delete its chats" is off) could finish in a chat the release had already passed and hold a file
 * there for an agent that no longer exists, and nothing would ever release it.
 *
 * In-process, like the zip state lock the check runs under: Batshit is one app process per
 * instance, and a turn can only run in the process that deletes its agent.
 */
const agentsBeingDeleted = new Map<string, number>()

/** Marks an agent as being deleted until the returned function is called (once). */
export function markAgentBeingDeleted(agentId: string): () => void {
  agentsBeingDeleted.set(agentId, (agentsBeingDeleted.get(agentId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (agentsBeingDeleted.get(agentId) ?? 1) - 1
    if (left > 0) agentsBeingDeleted.set(agentId, left)
    else agentsBeingDeleted.delete(agentId)
  }
}

/**
 * May this agent write zip state (a hold, a release, a parked zip action)? Not while its delete is
 * under way, and not once its record is gone (a turn that outlived the delete). Read under the
 * chat's zip state lock, which the release takes chat by chat too, so a step either lands before
 * the release reaches its chat (and is released there) or sees the mark.
 */
async function agentMayWriteZipState(agentId: string): Promise<boolean> {
  if (agentsBeingDeleted.has(agentId)) return false
  return redis.exists(`agent:${agentId}`)
}

const DELETED_AGENT_HOLD_ERROR =
  'This agent is being deleted, so its holds and releases were not applied.'

// ---------------------------------------------------------------------------------------------
// One agent's reads, newest first

/**
 * The reply being finalized: not stored yet when its control blocks are applied. On an approval
 * resume it is only the continuation (the stream starts empty), and the words and reads before
 * the card are the stored record of the SAME message id.
 */
export interface ReplyForHolds {
  messageId: string
  content: string
  zipIds: string[]
}

interface AuthorMessage {
  content: string
  metadata: Record<string, any> | null
}

/**
 * One agent's whole reads in this chat, looked up newest first and loaded lazily: a hold that
 * already sits on the newest read loads only the zips after it.
 *
 * A stored record with the reply's own id is read like any other message, and the reply comes
 * after it (BL-350). On an approval resume that record is the part before the card, so a file
 * read before the card can be held, and a hold that moved to that read at the pause stays
 * there. For an ordinary reply a stored record with its id can only be an earlier copy of the
 * same words, so its reads are the reply's own and change nothing.
 */
class AuthorReads {
  private messages: AuthorMessage[] | null = null
  private readonly zips = new Map<string, Promise<any | null>>()

  constructor(
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly projectPath: string | null,
    private readonly currentReply: ReplyForHolds | null
  ) {}

  private async authorMessages(): Promise<AuthorMessage[]> {
    if (this.messages) return this.messages
    const stored = await redis.getSessionMessages(this.sessionId)
    const mine: AuthorMessage[] = []
    for (const message of stored as any[]) {
      if (message?.role !== 'assistant' || typeof message.content !== 'string') continue
      const author =
        (typeof message.agent_id === 'string' && message.agent_id.trim()) ||
        (typeof message.agentId === 'string' && message.agentId.trim()) ||
        null
      if (author !== this.agentId) continue
      mine.push({ content: message.content, metadata: message.metadata ?? null })
    }
    if (this.currentReply) {
      mine.push({
        content: this.currentReply.content,
        metadata: { zipIds: this.currentReply.zipIds }
      })
    }
    this.messages = mine
    return mine
  }

  private zip(zipId: string): Promise<any | null> {
    if (!this.zips.has(zipId)) {
      this.zips.set(
        zipId,
        redis.getZip(zipId).catch(() => null)
      )
    }
    return this.zips.get(zipId)!
  }

  /** The zip id of the newest whole read of any of `keys`, and the key it matched; null if none. */
  async newestWholeRead(keys: string[]): Promise<{ zipId: string; rawZipId: string; key: string; zipData: any } | null> {
    if (keys.length === 0) return null
    const messages = await this.authorMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      const refs = listCompilableZips(message.content, { metadata: message.metadata ?? undefined })
      for (let refIndex = refs.length - 1; refIndex >= 0; refIndex -= 1) {
        const zipId = refs[refIndex].id
        const zipData = await this.zip(zipId)
        if (!zipData || zipData.type !== 'cool_tool') continue
        const result: Pick<DeadCopyToolResult, 'operationKind' | 'payload'> = {
          operationKind: typeof zipData.metadata?.operationKind === 'string' ? zipData.metadata.operationKind : null,
          payload: parseCoolToolPayload(zipData.content)
        }
        const effect = describeToolResultFiles(result, { projectPath: this.projectPath })
        if (effect.kind !== 'read') continue
        for (const key of keys) {
          if (effect.files.get(key) === 'whole') return { zipId: normalizeId(zipId), rawZipId: zipId, key, zipData }
        }
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Hold and release

export interface AgentHoldChanges {
  held: Array<{ path: string; zipId: string }>
  released: Array<{ path: string; zipId: string }>
  moved: Array<{ path: string; from: string; to: string }>
  errors: ControlErrorRecord[]
  /**
   * Set when an error (a Redis failure) stopped the step part way (BL-353). The lists above are
   * exactly what WAS written before it; nothing after it was.
   */
  failure?: string
}

function holdError(error: string): ControlErrorRecord {
  return buildControlErrorRecord(HOLD_TAG, error, TOOL_NOTES_BLOCK_HINT)
}

interface AgentHoldInput {
  sessionId: string
  agentId: string
  projectPath: string | null
  /**
   * The reply's holds and releases, one entry per Tool Notes block, in order (BL-538). Each
   * block runs its releases, then its holds; paths are compared by file (`holdPathKeys`), so a
   * later block's `release ./src/a.ts` undoes an earlier block's `hold src/a.ts`.
   */
  blocks: ToolNotesHoldBlock[]
  currentReply: ReplyForHolds | null
}

/**
 * Applies one reply's `hold` and `release` paths for the agent that wrote it, then moves every
 * hold of that agent to the newest whole read of its file (the hold follows the file). Inside a
 * block release runs first, so a block that releases and holds the same path ends with it held;
 * several blocks run in order, so the last block to name a FILE decides (BL-538). Every path that
 * could not be applied is a loud `controlErrors` record, never a silent drop.
 *
 * It reads the chat's zip state and writes it under the chat's zip state lock (BL-352), so a
 * user's click never lands between the read and the write. It never throws: an error part way
 * returns what was written before it, with `failure` set (BL-353).
 */
export async function applyAgentHoldChanges(input: AgentHoldInput): Promise<AgentHoldChanges> {
  const changes: AgentHoldChanges = { held: [], released: [], moved: [], errors: [] }
  try {
    await withZipStateLock(input.sessionId, () => applyAgentHoldChangesLocked(input, changes))
  } catch (error) {
    changes.failure = error instanceof Error ? error.message : String(error)
  }
  return changes
}

async function applyAgentHoldChangesLocked(input: AgentHoldInput, changes: AgentHoldChanges): Promise<void> {
  const { sessionId, agentId, projectPath } = input
  const items = await loadUnzippedItems(sessionId)
  // Set members already are state IDs. normalizeId is not idempotent for all-digit zip tails.
  const itemsByZip = new Map(items.map((item) => [item.zipId, item]))
  let myHolds = items.filter(
    (item) => item.source === 'agent' && typeof item.path === 'string' && item.path && item.agentId === agentId
  )
  const asked = input.blocks.some((block) => block.hold.length > 0 || block.release.length > 0)
  if (!asked && myHolds.length === 0) return
  if (!(await agentMayWriteZipState(agentId))) {
    // BL-606: loud when the reply asked; the hold that follows the file just stops following it.
    if (asked) changes.errors.push(holdError(DELETED_AGENT_HOLD_ERROR))
    return
  }

  const reads = new AuthorReads(sessionId, agentId, projectPath, input.currentReply)
  const keysOf = (path: string) => holdPathKeys(path, { projectPath })

  for (const block of input.blocks) {
    for (const path of block.release) {
      const keys = keysOf(path)
      const mine = myHolds.filter((hold) => keys.includes(hold.path as string))
      if (mine.length > 0) {
        for (const hold of mine) {
          await returnToAutomatic(sessionId, hold.zipId)
          itemsByZip.delete(hold.zipId)
          changes.released.push({ path: describeHeldPath(hold.path as string), zipId: hold.zipId })
        }
        myHolds = myHolds.filter((hold) => !mine.includes(hold))
        continue
      }
      const newest = await reads.newestWholeRead(keys)
      const holder = newest ? itemsByZip.get(newest.zipId) : undefined
      changes.errors.push(
        holdError(
          holder && isUserOwned(holder.source)
            ? `The user holds ${path}; only the user can release it.`
            : `You do not hold ${path}; there was nothing to release.`
        )
      )
    }

    for (const path of block.hold) {
      const keys = keysOf(path)
      if (keys.length === 0) {
        changes.errors.push(holdError(`${path} is not a file path Batshit can compare; nothing was held.`))
        continue
      }
      const alreadyHeld = myHolds.find((hold) => keys.includes(hold.path as string))
      if (alreadyHeld) {
        const resolved = await resolveSessionZipForHold(sessionId, alreadyHeld.zipId)
        if (resolved.status !== 'found') {
          changes.errors.push(holdError(`Cannot verify the existing Hold of ${path}: its zip is ${resolved.status}; nothing was changed.`))
          continue
        }
        const tooLargeTokens = await tooLargeCoolToolHoldTokens(resolved.zipData)
        if (tooLargeTokens !== null) {
          changes.errors.push(
            holdError(`Cannot hold ${path}: this result is about ${Math.ceil(tooLargeTokens).toLocaleString('en-US')} tokens and is too large to open. Fetch it in parts.`)
          )
        }
        continue
      }
      const newest = await reads.newestWholeRead(keys)
      if (!newest) {
        changes.errors.push(
          holdError(`You have no whole read of ${path} in this chat, so nothing was held. Read the whole file, then hold it.`)
        )
        continue
      }
      const resolved = await resolveSessionZipForHold(sessionId, newest.rawZipId)
      if (resolved.status !== 'found') {
        changes.errors.push(holdError(`Cannot hold ${path}: its zip is ${resolved.status}; nothing was changed.`))
        continue
      }
      const tooLargeTokens = await tooLargeCoolToolHoldTokens(newest.zipData)
      if (tooLargeTokens !== null) {
        changes.errors.push(
          holdError(`Cannot hold ${path}: this result is about ${Math.ceil(tooLargeTokens).toLocaleString('en-US')} tokens and is too large to open. Fetch it in parts.`)
        )
        continue
      }
      const current = itemsByZip.get(newest.zipId)
      if (current && isUserOwned(current.source)) {
        changes.errors.push(holdError(`The user already holds ${path}; your hold was not needed.`))
        continue
      }
      if ((await readRezipSource(sessionId, newest.zipId)) === 'user') {
        changes.errors.push(holdError(`The user zipped ${path} by hand, so it stays compressed; ask the user if you need it open.`))
        continue
      }
      const hold: UnzippedItem = {
        zipId: newest.zipId,
        sessionId,
        permanent: true,
        unzippedAt: Date.now(),
        ...zipLabels(newest.zipData),
        source: 'agent',
        path: newest.key,
        agentId
      }
      await writeUnzippedItem(sessionId, hold)
      itemsByZip.set(newest.zipId, hold)
      myHolds.push(hold)
      changes.held.push({ path: describeHeldPath(newest.key), zipId: newest.zipId })
    }
  }

  // The hold follows the file: a newer whole read takes it, and the older copy compresses as a
  // dead copy (DL-01). A newer copy the user holds or zipped keeps the user's state.
  for (const hold of myHolds) {
    const newest = await reads.newestWholeRead([hold.path as string])
    const from = hold.zipId
    if (!newest || newest.zipId === from) continue
    const tooLargeTokens = await tooLargeCoolToolHoldTokens(newest.zipData)
    if (tooLargeTokens !== null) {
      // Only the reply that made this read should report its refusal. Later replies still keep
      // the old Hold but must not replay the same control error indefinitely (BL-656).
      if (input.currentReply?.zipIds.includes(newest.rawZipId)) {
        changes.errors.push(
          holdError(`Your hold of ${describeHeldPath(hold.path as string)} stayed on the earlier read. The newer whole read is about ${Math.ceil(tooLargeTokens).toLocaleString('en-US')} tokens and is too large to hold open. Fetch it in parts; a later whole read under the limit can take the hold.`)
        )
      }
      continue
    }
    const resolved = await resolveSessionZipForHold(sessionId, newest.rawZipId)
    if (resolved.status !== 'found') {
      if (input.currentReply?.zipIds.includes(newest.rawZipId)) {
        changes.errors.push(holdError(`Your hold of ${describeHeldPath(hold.path as string)} stayed on the earlier read: the newer zip is ${resolved.status}.`))
      }
      continue
    }
    const current = itemsByZip.get(newest.zipId)
    if (current && isUserOwned(current.source)) continue
    if ((await readRezipSource(sessionId, newest.zipId)) === 'user') continue
    await returnToAutomatic(sessionId, from)
    itemsByZip.delete(from)
    const moved: UnzippedItem = {
      ...hold,
      zipId: newest.zipId,
      unzippedAt: Date.now(),
      ...zipLabels(newest.zipData)
    }
    await writeUnzippedItem(sessionId, moved)
    itemsByZip.set(newest.zipId, moved)
    changes.moved.push({ path: describeHeldPath(hold.path as string), from, to: newest.zipId })
  }
}

/**
 * BL-351: deleting an agent releases its holds in every chat. A hold is the agent's own
 * `unzipped_item` (`source: 'agent'`, `agentId`), and no other agent can release it, so it
 * would otherwise stay open for good against Josh's rule that deleting an agent deletes
 * everything about it (2026-09-19). Each hold returns to the automatic rules, exactly like a
 * Release (all four key families of that zip). A hold of an agent that is only no longer the
 * chat's agent is NOT this: it stays until the user releases it. The parked zip-control unzip
 * carries the agent too since BL-539, so it goes as well (one written before BL-539 has no
 * `agentId` and stays until the user releases it).
 *
 * It reads the chats of the agent's user (`user:{userId}:sessions`, the list every chat is
 * created into, archived ones included) and each chat's held set, the set every reader of zip
 * state reads (BL-539): the old sweep ran `KEYS unzipped_item:*` over the whole keyspace. An
 * item record with no set member is not a hold anyone reads, and the chat's delete sweeps it by
 * pattern. Like the other agent sweeps it reads `agent.user_id`, so `redis.deleteAgent` calls it
 * BEFORE the record delete; an error stops the delete. Returns the chats and zips it released;
 * the delete route tells open tabs (`zip_state_changed`), which keeps `redis.ts` free of the
 * publisher.
 */
export async function releaseDeletedAgentHolds(agentId: string): Promise<Array<{ sessionId: string; zipId: string }>> {
  const released: Array<{ sessionId: string; zipId: string }> = []
  if (!agentId) return released
  // BL-608: `redis.json.get`, not `redis.get`. `redis.get` answers a failed read with null, the
  // same answer as a missing record, so a read error released nothing and the delete went on.
  // Both records are RedisJSON; a failed read now throws and stops `redis.deleteAgent` before
  // the agent record goes.
  const agent = (await redis.json.get(`agent:${agentId}`)) as { user_id?: unknown } | null
  const userId = typeof agent?.user_id === 'string' ? agent.user_id : null
  if (!userId) return released
  const sessionIds = ((await redis.sMembers(`user:${userId}:sessions`)) ?? []).slice().sort()
  for (const sessionId of sessionIds) {
    await withZipStateLock(sessionId, async () => {
      const zipIds = ((await redis.sMembers(`unzipped:${sessionId}`)) ?? []).slice().sort()
      for (const zipId of zipIds) {
        const item = (await redis.json.get(`unzipped_item:${sessionId}:${zipId}`)) as Partial<UnzippedItem> | null
        if (!item || item.source !== 'agent' || item.agentId !== agentId) continue
        await returnToAutomatic(sessionId, zipId)
        released.push({ sessionId, zipId })
      }
    })
  }
  return released
}

// ---------------------------------------------------------------------------------------------
// The parked zip-control actions (DL-06)

export interface LegacyZipActionOutcome {
  unzipped: string[]
  zipped: string[]
  /** Refused unzip actions that must reach the reply's visible controlErrors. */
  errors?: ControlErrorRecord[]
  /** Set when an error stopped the step part way (BL-353); the lists are what WAS written. */
  failure?: string
}

const ZIP_CONTROL_TAG = 'batshit-zip-control'
const ZIP_CONTROL_REFUSED_HINT = 'Check Current Zip State; only the user changes what the user holds or zipped.'

function zipControlError(error: string, hint = ZIP_CONTROL_REFUSED_HINT): ControlErrorRecord {
  return buildControlErrorRecord(ZIP_CONTROL_TAG, error, hint)
}

/**
 * The legacy `unzip` / `zip` actions of a `<batshit-zip-control>` block, with the rules the chat
 * page applied: ids resolve through `tool_result_N` aliases and the chat's trusted zip ids; a
 * user's unzip is a lock the agent can neither zip nor re-unzip; an agent's unzip is permanent.
 * Called only when the hidden zip-control permission is ON. Never throws: an error part way
 * returns what was written before it, with `failure` set (BL-353).
 *
 * BL-360: the user wins here exactly as on the hold path. The user's "Zip now" (a rezip marker
 * with `source: 'user'`) is a lock too: an `unzip` would delete it (`writeUnzippedItem`) and a
 * `zip` would rewrite it as the agent's, so both are refused. Every refused action, an id that
 * matches nothing in this chat included, is a loud `controlErrors` line that names the reason;
 * none is skipped without a word. An `unzip` of a result an agent already holds open changes
 * nothing and asks for nothing, so it is not a refusal.
 */
export async function applyLegacyAgentZipActions(input: {
  sessionId: string
  /** The agent that wrote the reply; its unzips carry it, so deleting it releases them (BL-539). */
  agentId: string
  unzip: string[]
  zip: string[]
  currentReply: ReplyForHolds
  currentToolZipIds: string[]
}): Promise<LegacyZipActionOutcome> {
  const outcome: LegacyZipActionOutcome = { unzipped: [], zipped: [] }
  if (input.unzip.length === 0 && input.zip.length === 0) return outcome
  try {
    await applyLegacyAgentZipActionsInto(input, outcome)
  } catch (error) {
    outcome.failure = error instanceof Error ? error.message : String(error)
  }
  if (outcome.errors?.length === 0) delete outcome.errors
  return outcome
}

async function applyLegacyAgentZipActionsInto(
  input: Parameters<typeof applyLegacyAgentZipActions>[0],
  outcome: LegacyZipActionOutcome
): Promise<void> {
  const { sessionId } = input

  const sessionZipIds = new Set<string>(input.currentReply.zipIds)
  for (const message of (await redis.getSessionMessages(sessionId)) as any[]) {
    for (const id of collectTrustedZipIdsFromMetadata(message?.metadata)) sessionZipIds.add(id)
    if (typeof message?.content === 'string' && message.content.includes('{{batshit-zip:')) {
      for (const zip of listCompilableZips(message.content, message)) sessionZipIds.add(zip.id)
    }
  }
  const available = Array.from(sessionZipIds)
  const resolveOptions = { currentToolZipIds: input.currentToolZipIds }
  const unzipIds = resolveZipControlZipIds(input.unzip, available, resolveOptions)
  const zipIds = resolveZipControlZipIds(input.zip, available, resolveOptions)
  const errors = (outcome.errors ??= [])
  // BL-360: an id that matches no result in this chat used to vanish without a word.
  for (const [action, requested] of [['unzip', input.unzip], ['zip', input.zip]] as const) {
    for (const id of requested) {
      if (typeof id !== 'string' || !id.trim()) continue
      if (resolveZipControlZipIds([id], available, resolveOptions).length > 0) continue
      errors.push(
        zipControlError(
          `Nothing in this chat matches ${id.trim()}, so nothing was ${action === 'unzip' ? 'unzipped' : 'zipped'}.`,
          'Use tool_result_N (from 1) for this reply\'s results, or a zip ID from <zip_index>.'
        )
      )
    }
  }

  await withZipStateLock(sessionId, async () => {
    // BL-606: an agent being deleted writes no zip state; the step's failure line says so.
    if (!(await agentMayWriteZipState(input.agentId))) {
      throw new Error(DELETED_AGENT_HOLD_ERROR)
    }
    const items = await loadUnzippedItems(sessionId)
    const byZip = new Map(items.map((item) => [item.zipId, item]))

    for (const raw of zipIds) {
      const zipId = normalizeId(raw)
      const current = byZip.get(zipId)
      if (current && isUserOwned(current.source)) {
        errors.push(zipControlError(`The user holds ${raw}, so it stays open; only the user can zip it.`))
        continue
      }
      // The user's "Zip now" stays the user's: rewriting its marker as the agent's would let a
      // later agent unzip undo it.
      if ((await readRezipSource(sessionId, zipId)) === 'user') {
        errors.push(zipControlError(`The user already zipped ${raw} by hand; your zip was not needed.`))
        continue
      }
      // One MULTI, like a Release (BL-537).
      await redis.execute(async (client) => {
        await client
          .multi()
          .sRem(`unzipped:${sessionId}`, zipId)
          .del(`unzipped_item:${sessionId}:${zipId}`)
          .sAdd(`rezipped:${sessionId}`, zipId)
          .json.set(`rezipped_item:${sessionId}:${zipId}`, '$', {
            zipId,
            sessionId,
            source: 'agent',
            rezippedAt: Date.now()
          } as any)
          .exec()
      })
      byZip.delete(zipId)
      outcome.zipped.push(raw)
    }

    for (const raw of unzipIds) {
      const zipId = normalizeId(raw)
      const current = byZip.get(zipId)
      const zipData = await redis.getZip(raw).catch(() => null)
      const tooLargeTokens = await tooLargeCoolToolHoldTokens(zipData)
      if (tooLargeTokens !== null) {
        errors.push(
          zipControlError(
            `Cannot unzip ${raw}: this result is about ${Math.ceil(tooLargeTokens).toLocaleString('en-US')} tokens and is too large to open.`,
            'Fetch the result in parts instead.'
          )
        )
        continue
      }
      if (current && isUserOwned(current.source)) {
        errors.push(zipControlError(`The user already holds ${raw}; your unzip was not needed.`))
        continue
      }
      // Already open through an agent's hold: nothing changes and nothing was refused.
      if (current && current.source === 'agent') continue
      // BL-360: the user's "Zip now" is a lock. `writeUnzippedItem` deletes the rezip marker, so
      // without this check a legacy unzip undid it.
      if ((await readRezipSource(sessionId, zipId)) === 'user') {
        errors.push(
          zipControlError(`The user zipped ${raw} by hand, so it stays compressed; ask the user if you need it open.`)
        )
        continue
      }
      const item: UnzippedItem = {
        zipId,
        sessionId,
        permanent: true,
        unzippedAt: Date.now(),
        messageCount: 0,
        ...zipLabels(zipData),
        source: 'agent',
        agentId: input.agentId
      }
      await writeUnzippedItem(sessionId, item)
      byZip.set(zipId, item)
      outcome.unzipped.push(raw)
    }
  })
}

// ---------------------------------------------------------------------------------------------
// The countdown (DL-08)

/**
 * One more message in the chat: every temporary hold (a user's "Hold for N messages", a Judge
 * Juice open) counts it, and one whose count reaches its duration returns to the automatic rules.
 * Called once per accepted user message and once per finished reply. Returns what changed.
 *
 * Under the chat's zip state lock (BL-352): the write-back of a counted item can no longer land
 * after a user's Release of it (which left an item record with no set member) or over a user's
 * Hold made in between (which turned it back into a countdown).
 */
export async function advanceZipCountdowns(sessionId: string): Promise<{ counted: string[]; ended: string[] }> {
  return withZipStateLock(sessionId, async () => {
    const items = await loadUnzippedItems(sessionId)
    const temporary = items.filter((item) => !item.permanent && typeof item.duration === 'number')
    if (temporary.length === 0) return { counted: [], ended: [] }
    const { kept, ended } = countOneMoreMessage(temporary)
    for (const item of ended) await returnToAutomatic(sessionId, item.zipId)
    for (const item of kept) await redis.set(`unzipped_item:${sessionId}:${item.zipId}`, item)
    return { counted: kept.map((item) => item.zipId), ended: ended.map((item) => item.zipId) }
  })
}
