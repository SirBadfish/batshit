import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostCommandRecordStore, type HostCommandRecord, type HostDeleteHolder } from '../hostCommandRecords'
import type { HostProcessIdentity } from '../hostProcessIdentity'

const mocks = vi.hoisted(() => ({
  boot: vi.fn(), table: vi.fn(), warning: vi.fn()
}))
vi.mock('../hostProcessIdentity', () => ({
  readHostBootIdentity: mocks.boot,
  readHostProcessTable: mocks.table
}))
vi.mock('../codexCleanupWarnings', () => ({
  recordRecoveredCodexCleanupWarning: mocks.warning
}))

import {
  hostOwnerResource, hostProfileResource, pinHostCommandOwner, prepareHostCommand,
  withHostCommandDeletion
} from '../hostCommandOwnership'

const ownerA = { userId: 'user-one', kind: 'agent' as const, id: 'agent-a' }
const ownerB = { userId: 'user-one', kind: 'agent' as const, id: 'agent-b' }
const observed: HostProcessIdentity = { pid: 73001, parent: 1, group: 73001, started: 'birth-73001', state: 'S', program: 'old-cli' }
const self: HostProcessIdentity = { pid: process.pid, parent: 1, group: process.pid, started: 'this-process', state: 'S', program: 'node' }
const boot = { bootId: 'boot-current', namespaceId: 'host' }

let root: string
let previousRoot: string | undefined
let store: HostCommandRecordStore

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'host-ownership-'))
  previousRoot = process.env.BATSHIT_COMMAND_RECORDS_DIR
  process.env.BATSHIT_COMMAND_RECORDS_DIR = root
  store = new HostCommandRecordStore({ root })
  ;(globalThis as any).__batshitHostCommandOwnershipV1 = { instanceId: 'current-app', live: new Map() }
  mocks.boot.mockReset().mockResolvedValue(boot)
  mocks.table.mockReset().mockImplementation(async () => new Map([[self.pid, self]]))
  mocks.warning.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  if (previousRoot === undefined) delete process.env.BATSHIT_COMMAND_RECORDS_DIR
  else process.env.BATSHIT_COMMAND_RECORDS_DIR = previousRoot
  delete (globalThis as any).__batshitHostCommandOwnershipV1
  rmSync(root, { recursive: true, force: true })
})

function saved(options: Partial<HostCommandRecord> = {}): HostCommandRecord {
  const resources = options.resources ?? [hostOwnerResource(ownerA)]
  return {
    version: 1, runId: 'old-run', kind: 'codex', resources,
    bootId: boot.bootId, namespaceId: boot.namespaceId, instanceId: 'previous-app', lane: 'mac',
    owner: ownerA, profileId: null, sessionId: 'session-a', messageId: 'message-a',
    program: 'codex', phase: 'running', processes: [observed], ...options
  }
}
function persist(run: HostCommandRecord): void { store.prepare(run, store.pin(run.resources)) }
const resourceDb = (resource: string) => path.join(root, 'resources', createHash('sha256').update(resource).digest('hex'), 'ledger.sqlite')
function liveTable(...rows: HostProcessIdentity[]) {
  mocks.table.mockImplementation(async () => new Map([[self.pid, self], ...rows.map((row) => [row.pid, row] as const)]))
}
const holder = (process: HostProcessIdentity): HostDeleteHolder => ({ ...boot, instanceId: 'old-deleter', process })

describe('host command ownership recovery and deletion', () => {
  it('refuses to use the user home when a test loses its command-record root', () => {
    const caseRoot = process.env.BATSHIT_COMMAND_RECORDS_DIR
    expect(process.env.VITEST).toBe('true')
    delete process.env.BATSHIT_COMMAND_RECORDS_DIR
    try {
      expect(() => pinHostCommandOwner(ownerA)).toThrow(/explicit temporary command-record root/)
    } finally {
      if (caseRoot === undefined) delete process.env.BATSHIT_COMMAND_RECORDS_DIR
      else process.env.BATSHIT_COMMAND_RECORDS_DIR = caseRoot
    }
  })

  it('refuses a recorded still-live old run while allowing an unrelated owner deletion', async () => {
    const run = saved()
    persist(run)
    liveTable(observed)
    await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).rejects.toMatchObject({
      code: 'host_command_cleanup_unverified', status: 409
    })
    expect(store.records(run.resources)).toHaveLength(1)
    expect(mocks.warning).not.toHaveBeenCalled()
    const other = [hostOwnerResource(ownerB)]
    await expect(withHostCommandDeletion(other, async () => 'deleted')).resolves.toBe('deleted')
    expect(store.pin(other)[other[0]]).toBe(1)
  })

  it('writes the limited Codex warning before completing a gone or birth-changed record', async () => {
    const run = saved()
    persist(run)
    mocks.warning.mockImplementation(async () => {
      expect(store.records(run.resources)).toHaveLength(1)
    })
    liveTable({ ...observed, started: 'replacement-birth' })
    const notices = await withHostCommandDeletion(run.resources, async (received) => [...received])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/without a record may still run/)
    expect(mocks.warning).toHaveBeenCalledWith({
      userId: ownerA.userId, sessionId: run.sessionId, messageId: run.messageId
    })
    expect(store.records(run.resources)).toEqual([])
  })

  it('also warns before clearing an absent recorded Codex process', async () => {
    const run = saved()
    persist(run)
    liveTable()
    const notices = await withHostCommandDeletion(run.resources, async (received) => [...received])
    expect(notices).toHaveLength(1)
    expect(mocks.warning).toHaveBeenCalledOnce()
    expect(store.records(run.resources)).toEqual([])
  })

  it('persists a host warning for a recorded Codex run with no chat or reply', async () => {
    const run = saved({ sessionId: null, messageId: null })
    persist(run)
    liveTable()
    const notices = await withHostCommandDeletion(run.resources, async (received) => [...received])
    expect(notices).toHaveLength(1)
    expect(store.recoveryNotices(run.resources)).toEqual(notices)
    expect(mocks.warning).not.toHaveBeenCalled()
    expect(store.records(run.resources)).toEqual([])
    // A lost REST response does not lose the host's most recent warning.
    const retried = await withHostCommandDeletion(run.resources, async (received) => [...received])
    expect(retried).toEqual(notices)
  })

  it('keeps a same-boot prepared run with no recorded process', async () => {
    const run = saved({ phase: 'prepared', processes: [] })
    persist(run)
    await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).rejects.toThrow(/identity was recorded/)
    expect(store.records(run.resources)).toHaveLength(1)
  })

  it('clears an old-boot record without signalling or a same-boot descendant warning', async () => {
    const run = saved({ bootId: 'previous-boot', phase: 'prepared', processes: [] })
    persist(run)
    const signal = vi.spyOn(process, 'kill')
    try {
      await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).resolves.toBe('deleted')
      expect(signal).not.toHaveBeenCalled()
    } finally { signal.mockRestore() }
    expect(store.records(run.resources)).toEqual([])
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('refuses same-boot records from another process namespace', async () => {
    const run = saved({ namespaceId: 'pid:[99]' })
    persist(run)
    await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).rejects.toThrow(/another process namespace/)
    expect(store.records(run.resources)).toHaveLength(1)
  })

  it('clears a guardian only after its recorded process is gone and its group is empty', async () => {
    const run = saved({ kind: 'guardian', guardianGroup: 78000, processes: [{ ...observed, group: 78000 }] })
    persist(run)
    liveTable({ pid: 78003, parent: 1, group: 78000, started: 'member-birth', state: 'S' })
    await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).rejects.toThrow(/group is not verified empty/)
    expect(store.records(run.resources)).toHaveLength(1)
    liveTable()
    await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).resolves.toBe('deleted')
    expect(store.records(run.resources)).toEqual([])
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('retains the record when the durable warning cannot be written', async () => {
    const run = saved()
    persist(run)
    mocks.warning.mockRejectedValueOnce(new Error('warning disk failure'))
    await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).rejects.toThrow(/could not verify command cleanup/i)
    expect(store.records(run.resources)).toHaveLength(1)
    expect(store.recoveryNotices(run.resources)).toHaveLength(1)
  })

  it('retains the run if the host notice cannot be durably saved', async () => {
    const run = saved()
    persist(run)
    const db = new DatabaseSync(resourceDb(run.resources[0]))
    db.exec("CREATE TRIGGER reject_notice BEFORE UPDATE OF recovery_notice ON metadata BEGIN SELECT RAISE(ABORT, 'host notice write failure'); END")
    db.close()
    await expect(withHostCommandDeletion(run.resources, async () => 'deleted')).rejects.toThrow(/host notice write failure/)
    expect(store.records(run.resources)).toHaveLength(1)
    expect(store.recoveryNotices(run.resources)).toEqual([])
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('refuses a live holder of an active deletion marker', async () => {
    const resources = [hostOwnerResource(ownerA)]
    const old = { ...observed, pid: 81001, group: 81001, started: 'deleter-birth' }
    store.beginDelete(resources, { holder: holder(old) })
    liveTable(old)
    await expect(withHostCommandDeletion(resources, async () => 'deleted')).rejects.toThrow(/Another deletion is still running/)
    expect(store.deletion(resources)?.phase).toBe('active')
  })

  it('refuses to adopt a same-boot marker from another process namespace', async () => {
    const resources = [hostOwnerResource(ownerA)]
    store.beginDelete(resources, { holder: { ...holder(observed), namespaceId: 'pid:[99]' } })
    await expect(withHostCommandDeletion(resources, async () => 'deleted')).rejects.toThrow(/Another process namespace/)
    expect(store.deletion(resources)?.phase).toBe('active')
  })

  it('replaces an abandoned active deletion marker only after its holder is absent', async () => {
    const resources = [hostOwnerResource(ownerA)]
    const old = { ...observed, pid: 81001, group: 81001, started: 'deleter-birth' }
    const abandoned = store.beginDelete(resources, { holder: holder(old) })
    liveTable()
    await expect(withHostCommandDeletion(resources, async () => 'deleted')).resolves.toBe('deleted')
    expect(store.deletion(resources)).toBeNull()
    expect(store.pin(resources)[resources[0]]).toBe(1)
    expect(abandoned.token).toBeTruthy()
  })

  it('replaces an active marker from a previous boot without trusting its saved PID', async () => {
    const resources = [hostOwnerResource(ownerA)]
    store.beginDelete(resources, { holder: { ...holder(observed), bootId: 'previous-boot' } })
    liveTable(observed)
    await expect(withHostCommandDeletion(resources, async () => 'deleted')).resolves.toBe('deleted')
    expect(store.deletion(resources)).toBeNull()
  })

  it('keeps a durable active marker when final lease persistence fails', async () => {
    const resources = [hostOwnerResource(ownerA)]
    store.pin(resources)
    const originalError = console.error
    console.error = vi.fn()
    try {
      await expect(withHostCommandDeletion(resources, async () => {
        const db = new DatabaseSync(resourceDb(resources[0]))
        db.exec("CREATE TRIGGER reject_finish BEFORE UPDATE OF generation ON metadata BEGIN SELECT RAISE(ABORT, 'finish write failure'); END")
        db.close()
        return 'deleted'
      })).rejects.toThrow(/could not save its final ownership receipt/)
    } finally { console.error = originalError }
    expect(store.deletion(resources)?.phase).toBe('active')
    expect(() => store.pin(resources)).toThrow(/being deleted/)
  })

  it('rejects a command pinned before an owner deletion', async () => {
    const pin = pinHostCommandOwner(ownerA)
    await withHostCommandDeletion(pin.resources, async () => 'deleted')
    await expect(prepareHostCommand(pin, { kind: 'guardian', program: '/bin/echo' })).rejects.toThrow(/Stale or deleting/)
    expect(store.records(pin.resources)).toEqual([])
  })

  it('keeps concurrent nested physical-profile deletion guards under one outer owner lifetime', async () => {
    const owner = hostOwnerResource(ownerA)
    const profile = hostProfileResource('batshit_agent_agent-a')
    const entered: string[] = []
    await withHostCommandDeletion([owner], async () => {
      await Promise.all([
        withHostCommandDeletion([profile], async () => { entered.push('codex'); return 'ok' }),
        withHostCommandDeletion([profile], async () => { entered.push('claude'); return 'ok' })
      ])
      return 'ok'
    })
    expect(entered.sort()).toEqual(['claude', 'codex'])
    expect(store.pin([owner])[owner]).toBe(1)
    expect(store.pin([profile])[profile]).toBe(1)
  })

  it('a shared profile guard cannot stop another owner, but that owner can clean its live run', async () => {
    const profileId = 'batshit_agent_shared'
    const pin = pinHostCommandOwner(ownerB, profileId)
    const lease = await prepareHostCommand(pin, { kind: 'codex', program: 'codex' })
    lease.observe([observed])
    liveTable(observed)
    const cleanup = vi.fn(async () => lease.complete())
    lease.onCleanup(cleanup)
    const profile = hostProfileResource(profileId)

    await expect(withHostCommandDeletion([profile], async () => 'deleted')).rejects.toMatchObject({
      code: 'host_command_cleanup_unverified', status: 409
    })
    expect(cleanup).not.toHaveBeenCalled()
    expect(store.records([profile])).toHaveLength(1)

    await expect(withHostCommandDeletion([hostOwnerResource(ownerB), profile], async () => 'deleted'))
      .resolves.toBe('deleted')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(store.records([profile])).toEqual([])
  })
})
