import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HostCommandRecordStore, type HostCommandRecord } from './hostCommandRecords'
import { readHostBootIdentity, readHostProcessTable, type HostProcessIdentity } from './hostProcessIdentity'
import { assertManagedCodexProfileId, MANAGED_CODEX_ROOT_DIR } from './codexManagedHome'

export type HostCommandOwner = { userId: string; kind: 'agent' | 'subagent' | 'host'; id: string }
export type HostCommandPin = {
  owner: HostCommandOwner
  profileId: string | null
  resources: string[]
  generations: Record<string, number>
  store: HostCommandRecordStore
}
type LiveCleanup = () => Promise<void>
type RuntimeState = { instanceId: string; live: Map<string, LiveCleanup> }
type RuntimeGlobal = typeof globalThis & { __batshitHostCommandOwnershipV1?: RuntimeState }
function runtime() {
  return ((globalThis as RuntimeGlobal).__batshitHostCommandOwnershipV1 ??= { instanceId: randomUUID(), live: new Map() })
}

export class HostCommandDeleteRefusedError extends Error {
  readonly code = 'host_command_cleanup_unverified'
  readonly status = 409
}

function recordStore() {
  if (process.env.VITEST === 'true' && !process.env.BATSHIT_COMMAND_RECORDS_DIR?.trim()) {
    throw new Error('Tests require an explicit temporary command-record root; the user home is forbidden.')
  }
  const root = process.env.BATSHIT_COMMAND_RECORDS_DIR?.trim() || (
    process.env.BATSHIT_CONTAINERIZED === '1'
      ? '/runtime/command-ownership/v1'
      : path.join(os.homedir(), '.batshit/runtime/command-ownership/v1')
  )
  return new HostCommandRecordStore({ root })
}

export function hostOwnerResource(owner: HostCommandOwner): string {
  if (!owner.userId || !owner.id || !['agent', 'subagent', 'host'].includes(owner.kind)) throw new Error('Command ownership needs a server-vouched owner.')
  return JSON.stringify(['owner', owner.userId, owner.kind, owner.id])
}
export function hostProfileResource(profileId: string, root = MANAGED_CODEX_ROOT_DIR): string {
  // Different runtime roots are different physical profiles; aliases of an existing root
  // must still share one gate. Resolve the nearest existing ancestor for first-run folders.
  let ancestor = path.resolve(root)
  const tail: string[] = []
  for (;;) {
    try { ancestor = realpathSync.native(ancestor); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error
      tail.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
  }
  return JSON.stringify(['profile', path.join(ancestor, ...tail, assertManagedCodexProfileId(profileId))])
}

/** Pin before asynchronous profile/setup work. Deletion changes the generation permanently. */
export function pinHostCommandOwner(owner: HostCommandOwner, profileId: string | null = null): HostCommandPin {
  const resources = [hostOwnerResource(owner), ...(profileId ? [hostProfileResource(profileId)] : [])]
  const store = recordStore()
  return { owner, profileId, resources, store, generations: store.pin(resources) }
}

export class HostCommandLease {
  private attemptedSpawn = false
  private completed = false
  constructor(readonly pin: HostCommandPin, readonly record: HostCommandRecord) {}
  observe(processes: HostProcessIdentity[], guardianGroup?: number): void {
    const next = { ...this.record, phase: this.record.phase === 'unresolved' ? 'unresolved' as const : 'running' as const, processes, ...(guardianGroup ? { guardianGroup } : {}) }
    this.pin.store.update(next)
    Object.assign(this.record, next)
  }
  onCleanup(cleanup: LiveCleanup): void { runtime().live.set(this.record.runId, cleanup) }
  markSpawnAttempt(): void { this.attemptedSpawn = true }
  abortBeforeSpawn(): void { if (!this.attemptedSpawn) this.complete() }
  complete(): void {
    if (this.completed) return
    this.pin.store.complete(this.record)
    this.completed = true
    runtime().live.delete(this.record.runId)
  }
  unresolved(): void {
    if (this.completed) return
    const next = { ...this.record, phase: 'unresolved' as const }
    this.pin.store.update(next)
    this.record.phase = 'unresolved'
  }
  lostController(): void { runtime().live.delete(this.record.runId) }
}

/** Commit before spawn; an empty prepared record is unknown after a crash, never proof of exit. */
export async function prepareHostCommand(pin: HostCommandPin, input: {
  kind: 'codex' | 'guardian'
  program: string
  sessionId?: string | null
  messageId?: string | null
}): Promise<HostCommandLease> {
  const boot = await readHostBootIdentity()
  const lane = createHash('sha256').update(JSON.stringify([
    process.cwd(), process.env.PORT ?? '', process.env.REDIS_URL ?? '', process.env.REDIS_DB ?? ''
  ])).digest('hex')
  const record: HostCommandRecord = {
    version: 1, runId: randomUUID(), kind: input.kind, resources: pin.resources,
    ...boot, instanceId: runtime().instanceId, lane, owner: pin.owner, profileId: pin.profileId,
    sessionId: input.sessionId ?? null, messageId: input.messageId ?? null,
    program: path.basename(input.program).slice(0, 80), phase: 'prepared', processes: []
  }
  pin.store.prepare(record, pin.generations)
  return new HostCommandLease(pin, record)
}

export async function validateHostCommandOwner(owner: HostCommandOwner): Promise<void> {
  if (owner.kind === 'host') return
  const { redis } = await import('$lib/server/redis')
  const row = await redis.json.get(`${owner.kind}:${owner.id}`) as { user_id?: string } | null
  if (!row || row.user_id !== owner.userId) throw new Error('The command owner was deleted or is no longer available.')
}

const recoveryNotice = 'Batshit verified that each program it recorded for the old run has ended. Commands that the old run started without a record may still run until they end or the computer restarts.'

async function reconcileRecords(store: HostCommandRecordStore, resources: string[], cleanupOwners: Set<string>): Promise<string[]> {
  const notices: string[] = []
  const boot = await readHostBootIdentity()
  let table: Awaited<ReturnType<typeof readHostProcessTable>> | undefined
  for (const record of store.records(resources)) {
    const live = runtime().live.get(record.runId)
    if (record.instanceId === runtime().instanceId && live && cleanupOwners.has(hostOwnerResource(record.owner))) {
      await live()
      if (!store.records(resources).some(row => row.runId === record.runId)) continue
      throw new HostCommandDeleteRefusedError('The running command has not confirmed cleanup. The agent and its profile were kept; retry once it ends.')
    }
    if (record.bootId !== boot.bootId) {
      store.complete(record)
      continue
    }
    if (record.namespaceId !== boot.namespaceId) throw new HostCommandDeleteRefusedError('An old command belongs to another process namespace, so this app cannot verify it ended. Its owner and profile were kept.')
    if (record.processes.length === 0) throw new HostCommandDeleteRefusedError('A previous command start was interrupted before its process identity was recorded. Batshit cannot verify cleanup. Restart the computer, then retry deletion.')
    table ??= await readHostProcessTable()
    const alive = record.processes.filter(before => {
      const now = table!.get(before.pid)
      return now && now.started === before.started && !now.state.startsWith('Z')
    })
    if (alive.length > 0) {
      const programs = alive.map(row => `${row.program || record.program} (process ${row.pid}, started ${row.started})`).join('; ')
      throw new HostCommandDeleteRefusedError(`These recorded programs are still running: ${programs}. End them yourself and retry, or restart the computer. The agent and its profile were kept.`)
    }
    if (record.kind === 'guardian') {
      if (!record.guardianGroup || [...table.values()].some(row => row.group === record.guardianGroup && !row.state.startsWith('Z'))) {
        throw new HostCommandDeleteRefusedError('The old command group is not verified empty. Batshit will not signal a saved process number. Restart the computer and retry deletion.')
      }
    } else {
      // The host notice exists even when this run had no chat/reply, or its reply was deleted.
      // Publish and persist before forgetting the process evidence. A removed reply is not
      // recreated, and a failed write leaves the run record for a later retry.
      store.saveRecoveryNotice(record, recoveryNotice)
      if (record.sessionId && record.messageId) {
        const { recordRecoveredCodexCleanupWarning } = await import('./codexCleanupWarnings')
        await recordRecoveredCodexCleanupWarning({ userId: record.owner.userId, sessionId: record.sessionId, messageId: record.messageId })
      }
      notices.push(recoveryNotice)
    }
    store.complete(record)
  }
  return [...new Set(notices)]
}

// A route's owner guard and its nested physical-profile guards share the same lifetime.
// Profile deletes can run concurrently (Codex and Claude); one promise acquires that lease.
type DeleteContext = {
  leases: Map<string, Promise<{ store: HostCommandRecordStore; lease: ReturnType<HostCommandRecordStore['beginDelete']> }>>
  notices: string[]
  cleanupOwners: Set<string>
}
const deleteContext = new AsyncLocalStorage<DeleteContext>()

async function acquireDeletion(resources: string[], context: DeleteContext) {
  const key = JSON.stringify([...resources].sort())
  const existing = context.leases.get(key)
  if (existing) return existing
  const promise = (async () => {
    const store = recordStore()
    context.notices.push(...store.recoveryNotices(resources).filter(notice => !context.notices.includes(notice)))
    context.notices.push(...(await reconcileRecords(store, resources, context.cleanupOwners)).filter(notice => !context.notices.includes(notice)))
    const boot = await readHostBootIdentity()
    const table = await readHostProcessTable()
    const self = table.get(process.pid)
    if (!self) throw new Error('Cannot verify this deletion controller.')
    const holder = { ...boot, instanceId: runtime().instanceId, process: self }
    const previous = store.deletion(resources)
    if (previous?.phase === 'active' && previous.holder.bootId === boot.bootId) {
      if (previous.holder.namespaceId !== boot.namespaceId) {
        throw new HostCommandDeleteRefusedError('Another process namespace holds this deletion. Its completion cannot be verified here; the affected owner or profile was kept.')
      }
      const current = table.get(previous.holder.process.pid)
      if (current && current.started === previous.holder.process.started && !current.state.startsWith('Z')) {
        throw new HostCommandDeleteRefusedError('Another deletion is still running for this owner or profile. Wait for it to finish, then retry.')
      }
    }
    // The store serializes admission with this marker and rejects any newly admitted run.
    return { store, lease: store.beginDelete(resources, { holder, replaceToken: previous?.token }) }
  })()
  context.leases.set(key, promise)
  return promise
}

export async function withHostCommandDeletion<T>(resources: string[], action: (notices: string[]) => Promise<T>): Promise<T> {
  const acquire = async (context: DeleteContext) => {
    try {
      // A shared physical profile permits refusing its deletion, not stopping another
      // owner's live run. Only owners explicitly included by this delete may be stopped.
      for (const resource of resources) {
        if (resource.startsWith('["owner",')) context.cleanupOwners.add(resource)
      }
      // One lease per resource lets nested profile deletes reuse an outer owner's
      // reservation. No destructive action starts until every requested lease is held.
      for (const resource of [...new Set(resources)].sort()) await acquireDeletion([resource], context)
    }
    catch (error) {
      if (error instanceof HostCommandDeleteRefusedError) throw error
      throw new HostCommandDeleteRefusedError(`Batshit could not verify command cleanup: ${error instanceof Error ? error.message : String(error)}. The affected deletion did not start.`)
    }
  }
  const active = deleteContext.getStore()
  if (active) {
    await acquire(active)
    return action(active.notices)
  }
  const context: DeleteContext = { leases: new Map(), notices: [], cleanupOwners: new Set() }
  return deleteContext.run(context, async () => {
    let succeeded = false
    try {
      await acquire(context)
      const result = await action(context.notices)
      succeeded = !(result instanceof Response) || result.status < 400
      return result
    } finally {
      const failures: unknown[] = []
      for (const pending of context.leases.values()) {
        // A rejected acquisition never obtained a lease and needs no release.
        const acquired = await pending.catch(() => null)
        if (!acquired) continue
        try {
          const { store, lease } = acquired
          // A completed delete attempt invalidates already pinned starts even on a partial
          // failure. Fresh requests may regenerate the managed profile under existing rules.
          store.finishDelete(lease, { success: succeeded })
        } catch (error) { failures.push(error) }
      }
      if (failures.length) {
        console.error('[Command ownership] Deletion lease could not be released:', failures)
        throw new HostCommandDeleteRefusedError('The deletion attempt finished, but Batshit could not save its final ownership receipt. The affected profile remains blocked from new commands; restart the app and retry cleanup.')
      }
    }
  })
}
