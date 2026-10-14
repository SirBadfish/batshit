import { AsyncLocalStorage } from 'node:async_hooks'
import { redis } from '$lib/server/redis'

export type ManagedProfileRunOwner = {
  userId: string
  kind: 'agent' | 'subagent' | 'host'
  id: string
}

export class ManagedProfileRunRefusedError extends Error {
  readonly code = 'MANAGED_PROFILE_RUN_REFUSED'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagedProfileRunRefusedError'
  }
}

export function isManagedProfileRunRefusal(error: unknown): error is ManagedProfileRunRefusedError {
  return (error as { code?: unknown } | null)?.code === 'MANAGED_PROFILE_RUN_REFUSED'
}

/**
 * BL-745 (2026-09-28): a Primary Agent's profile folder (`~/.batshit/agents/<profile id>`) is
 * written by the Codex and Claude profile syncs and removed by the agent's delete. A sync reads
 * every agent first and writes each folder only after other awaits (gateways, MCP selections),
 * so a delete that finished in that gap was followed by the sync making the deleted agent's
 * folder again.
 *
 * The profile syncs' folder writes and the deletes' folder removals run through this gate, one at a
 * time per profile id, in this process. A write is admitted only when the agent's record still
 * exists when its turn comes, read then, never from the sync's first read. The agent delete
 * removes the record before it removes the folders (`routes/api/agents/[id]`), so either the
 * write sees no record and writes nothing, or it finishes first and the removal that waited
 * behind it takes the folder away.
 *
 * BL-753 (2026-09-28): the same for a CLI Subagent's folder (`subagent_cli-<slug>`). Its delete
 * removes the folder BEFORE the record (BL-157: a failure keeps the Subagent for a retry), so the
 * delete holds the folder's turn (`holdAgentProfileFolder`) from the removal until the record is
 * gone; the folder removal inside that hold runs at once instead of queueing behind it. A
 * Subagent profile write is admitted only when `subagent:<id>` exists at its turn.
 *
 * BL-761 (2026-09-28): the CLI Subagent managed-config viewer
 * (`routes/api/subagents/[id]/managed-config/+server.ts`) also reads the record, then after
 * other awaits (the gateway list, the MCP selections) calls the same profile-writing functions;
 * its write now goes through `writeSubagentProfileFolderIfSubagentExists` too, and the route
 * answers 404 when the write finds no record.
 *
 * BL-754 (2026-09-28): a run-start write takes the same folder turn and re-reads its exact
 * server-vouched owner. Missing, foreign, or unreadable records refuse that run. Whole-user
 * syncs log a single agent's failure and continue, but a run requiring that profile fails
 * rather than launching from an older config file.
 *
 * In-process only, like `codexHomeStartGate.ts`: a second Batshit process sharing the agents
 * folder is not serialized by it. Separate from the command ownership guard
 * (`hostCommandOwnership.ts`), which decides whether a delete may start at all.
 */
type GateGlobal = typeof globalThis & { __batshitAgentProfileFolderGateV1?: Map<string, Promise<void>> }

function gates(): Map<string, Promise<void>> {
  return ((globalThis as GateGlobal).__batshitAgentProfileFolderGateV1 ??= new Map())
}

/** The profile ids a `holdAgentProfileFolder` call running this code holds. */
const heldTurns = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Runs `action` after every earlier write or removal of this profile folder has finished. Inside
 * a `holdAgentProfileFolder` of the same folder it runs at once: the hold is its turn.
 */
export async function withAgentProfileFolder<T>(profileId: string, action: () => Promise<T>): Promise<T> {
  if (heldTurns.getStore()?.has(profileId)) return action()
  return takeTurn(profileId, action)
}

/**
 * Holds this profile folder's turn for all of `action`, a delete's several steps: every write
 * queued meanwhile waits until `action` has finished, and the folder removals `action` makes
 * itself do not wait for the hold. Only for a delete's own steps; never start other work inside.
 */
export async function holdAgentProfileFolder<T>(profileId: string, action: () => Promise<T>): Promise<T> {
  const held = heldTurns.getStore()
  if (held?.has(profileId)) return action()
  return takeTurn(profileId, () => heldTurns.run(new Set([...(held ?? []), profileId]), action))
}

/**
 * Admit one run-start folder write in the same turn as profile syncs and deletion. The owner
 * comes from the server's run identity, never from a profile id supplied by stored settings.
 * A missing, foreign, or unreadable record refuses the run before any folder work begins.
 */
export async function withManagedProfileRunWrite<T>(
  owner: ManagedProfileRunOwner,
  profileId: string,
  action: () => Promise<T>
): Promise<T> {
  if (!owner || (owner.kind !== 'agent' && owner.kind !== 'subagent') ||
      !owner.userId || !owner.id) {
    throw new ManagedProfileRunRefusedError('A managed profile run needs a stored Agent or Subagent owner.')
  }
  return withAgentProfileFolder(profileId, async () => {
    let current: { user_id?: string } | null
    try {
      current = await redis.json.get(`${owner.kind}:${owner.id}`) as { user_id?: string } | null
    } catch (error) {
      throw new ManagedProfileRunRefusedError('The managed profile run owner could not be verified.', { cause: error })
    }
    if (!current || current.user_id !== owner.userId) {
      throw new ManagedProfileRunRefusedError('The managed profile run owner was deleted or is unavailable.')
    }
    return action()
  })
}

async function takeTurn<T>(profileId: string, action: () => Promise<T>): Promise<T> {
  const queue = gates()
  const previous = queue.get(profileId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => mine)
  queue.set(profileId, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (queue.get(profileId) === tail) queue.delete(profileId)
  }
}

/**
 * A profile sync's write for one agent: runs `write` in the folder's turn, and only when the
 * agent's record still exists then. Answers whether it wrote.
 */
export async function writeAgentProfileFolderIfAgentExists(
  agentId: string,
  profileId: string,
  write: () => Promise<void>
): Promise<boolean> {
  return writeProfileFolderIfRecordExists(`agent:${agentId}`, profileId, write)
}

/** The same for a CLI Subagent's profile write, admitted only while `subagent:<id>` exists (BL-753). */
export async function writeSubagentProfileFolderIfSubagentExists(
  subagentId: string,
  profileId: string,
  write: () => Promise<void>
): Promise<boolean> {
  return writeProfileFolderIfRecordExists(`subagent:${subagentId}`, profileId, write)
}

async function writeProfileFolderIfRecordExists(
  recordKey: string,
  profileId: string,
  write: () => Promise<void>
): Promise<boolean> {
  return withAgentProfileFolder(profileId, async () => {
    const current = await redis.json.get(recordKey)
    if (!current) return false
    await write()
    return true
  })
}
