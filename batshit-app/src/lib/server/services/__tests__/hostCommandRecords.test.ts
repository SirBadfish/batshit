import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HostCommandRecordStore, type HostCommandRecord, type HostDeleteHolder } from '../hostCommandRecords'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-records-'))
  roots.push(root)
  return { root, store: new HostCommandRecordStore({ root }) }
}
const location = (root: string, resource: string) =>
  path.join(root, 'resources', createHash('sha256').update(resource).digest('hex'), 'ledger.sqlite')
const markerLocation = (root: string, resource: string) =>
  path.join(root, 'resource-history', `${createHash('sha256').update(resource).digest('hex')}.json`)

const holder: HostDeleteHolder = {
  instanceId: 'instance-one', bootId: 'boot-one', namespaceId: 'host',
  process: { pid: 501, parent: 1, group: 501, started: 'birth-501', state: 'S' }
}
const record = (resources = ['owner:user:agent:a', 'profile:batshit_agent_a']): HostCommandRecord => ({
  version: 1, runId: 'run-one', kind: 'codex', resources,
  bootId: 'boot-one', namespaceId: 'host', instanceId: 'instance-one', lane: 'mac',
  owner: { userId: 'user', kind: 'agent', id: 'a' }, profileId: 'batshit_agent_a',
  sessionId: 'session-one', messageId: 'message-one', program: 'codex', phase: 'prepared', processes: []
})

describe('host command records', () => {
  it('commits an admission to both resources before either delete can begin', () => {
    const { root, store } = fixture()
    const run = record()
    store.prepare(run, store.pin(run.resources))
    const separate = new HostCommandRecordStore({ root })
    expect(separate.records(run.resources)).toEqual([{ ...run, resources: [...run.resources].sort() }])
    expect(() => separate.beginDelete([run.resources[0]], { holder })).toThrow(/Unresolved host run/)
    expect(() => separate.beginDelete([run.resources[1]], { holder })).toThrow(/Unresolved host run/)
    store.complete(run)
    expect(separate.records(run.resources)).toEqual([])
  })

  it('serializes independent Node processes through the same resource database', () => {
    const { root, store } = fixture()
    const run = record(['owner:user:agent:a'])
    const pinned = store.pin(run.resources)
    const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'src/lib/server/services/hostCommandRecords.ts')).href
    const script = `import { HostCommandRecordStore } from ${JSON.stringify(moduleUrl)};
      const store = new HostCommandRecordStore({root: process.argv[1]});
      store.beginDelete(['owner:user:agent:a'], {holder:${JSON.stringify(holder)}});`
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root], {
      cwd: process.cwd(),
      stdio: 'pipe'
    })
    expect(() => store.prepare(run, pinned)).toThrow(/Stale or deleting/)
    const marker = store.deletion(run.resources)
    expect(marker?.phase).toBe('active')
    expect(marker?.holder.instanceId).toBe(holder.instanceId)
  })

  it('rejects stale generations after a delete and allows a freshly pinned run', () => {
    const { store } = fixture()
    const run = record()
    const old = store.pin(run.resources)
    const lease = store.beginDelete(run.resources, { holder })
    expect(() => store.prepare(run, old)).toThrow(/Stale or deleting/)
    store.finishDelete(lease, { success: true })
    expect(() => store.prepare(run, old)).toThrow(/Stale or deleting/)
    store.prepare(run, store.pin(run.resources))
    expect(store.records(run.resources)).toHaveLength(1)
  })

  it('keeps a failed destructive delete blocked until an explicit retry takes its marker', () => {
    const { store } = fixture()
    const resources = record().resources
    const lease = store.beginDelete(resources, { holder })
    store.finishDelete(lease, { success: false, keepBlocked: true })
    expect(store.deletion(resources)?.phase).toBe('blocked')
    expect(() => store.pin(resources)).toThrow(/delet/)
    const retry = store.beginDelete(resources, { holder })
    expect(retry.token).not.toBe(lease.token)
    expect(() => store.finishDelete(lease, { success: true })).toThrow(/Stale/)
    store.finishDelete(retry, { success: false })
    expect(store.pin(resources)[resources[0]]).toBe(1)
  })

  it('requires a verified exact token to replace an abandoned active marker', () => {
    const { store } = fixture()
    const resources = record().resources
    const lease = store.beginDelete(resources, { holder })
    expect(() => store.beginDelete(resources, { holder })).toThrow(/already active/)
    expect(() => store.beginDelete(resources, { holder, replaceToken: 'wrong' })).toThrow(/already active/)
    const replacement = store.beginDelete(resources, { holder, replaceToken: lease.token })
    expect(replacement.token).not.toBe(lease.token)
    store.finishDelete(replacement, { success: false })
  })

  it('rolls back both run copies if the second resource rejects its INSERT', () => {
    const { root, store } = fixture()
    const run = record()
    const generations = store.pin(run.resources)
    const db = new DatabaseSync(location(root, run.resources[1]))
    db.exec("CREATE TRIGGER reject_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    db.close()
    expect(() => store.prepare(run, generations)).toThrow(/injected failure/)
    expect(store.records(run.resources)).toEqual([])
  })

  it('does not lose either run copy if completion persistence fails', () => {
    const { root, store } = fixture()
    const run = record()
    store.prepare(run, store.pin(run.resources))
    const db = new DatabaseSync(location(root, run.resources[1]))
    db.exec("CREATE TRIGGER reject_complete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END")
    db.close()
    expect(() => store.complete(run)).toThrow(/injected completion failure/)
    expect(store.records(run.resources)).toHaveLength(1)
    expect(() => store.beginDelete([run.resources[0]], { holder })).toThrow(/Unresolved/)
  })

  it('rejects corrupted records only for resources being inspected', () => {
    const { root, store } = fixture()
    const bad = 'owner:user:agent:bad'
    const healthy = 'owner:user:agent:healthy'
    store.pin([bad])
    store.pin([healthy])
    const db = new DatabaseSync(location(root, bad))
    db.prepare('INSERT INTO runs(run_id,record) VALUES (?,?)').run('bad-run', '{}')
    db.close()
    expect(() => store.pin([bad])).toThrow(/malformed/i)
    expect(store.pin([healthy])[healthy]).toBe(0)
    expect(store.beginDelete([healthy], { holder })).toMatchObject({ phase: 'active' })
  })

  it('refuses an expected resource file that disappeared instead of reconstructing an empty ledger', () => {
    const { root, store } = fixture()
    const resource = 'owner:user:agent:a'
    store.pin([resource])
    unlinkSync(location(root, resource))
    expect(() => store.pin([resource])).toThrow(/ENOENT/)
  })

  it('refuses a lost committed resource directory without blocking unrelated resources', () => {
    const { root, store } = fixture()
    const affected = 'owner:user:agent:affected'
    const healthy = 'owner:user:agent:healthy'
    const run = record([affected])
    store.prepare(run, store.pin([affected]))
    store.pin([healthy])
    expect(existsSync(markerLocation(root, affected))).toBe(true)
    rmSync(path.dirname(location(root, affected)), { recursive: true, force: true })
    expect(() => store.pin([affected])).toThrow(/resource directory disappeared/)
    expect(() => store.beginDelete([affected], { holder })).toThrow(/resource directory disappeared/)
    expect(store.pin([healthy])[healthy]).toBe(0)
    expect(store.beginDelete([healthy], { holder }).phase).toBe('active')
  })

  it('adds a durable marker before using an existing database without one', () => {
    const { root, store } = fixture()
    const resource = 'owner:user:agent:a'
    store.pin([resource])
    const marker = markerLocation(root, resource)
    unlinkSync(marker)
    expect(store.pin([resource])[resource]).toBe(0)
    expect(existsSync(marker)).toBe(true)
    rmSync(path.dirname(location(root, resource)), { recursive: true, force: true })
    expect(() => store.pin([resource])).toThrow(/resource directory disappeared/)
  })

  it('rejects malformed or non-private creation markers for only their resource', () => {
    const { root, store } = fixture()
    const affected = 'owner:user:agent:affected'
    const healthy = 'owner:user:agent:healthy'
    store.pin([affected])
    store.pin([healthy])
    const marker = markerLocation(root, affected)
    const original = readFileSync(marker, 'utf8')
    writeFileSync(marker, original.replace('"version":1', '"version":2'))
    expect(() => store.pin([affected])).toThrow(/Malformed host resource creation marker/)
    writeFileSync(marker, original)
    chmodSync(marker, 0o644)
    expect(() => store.pin([affected])).toThrow(/not private/)
    expect(store.pin([healthy])[healthy]).toBe(0)
  })

  it('rejects a symlinked or world-readable resource file', () => {
    const { root, store } = fixture()
    const resource = 'owner:user:agent:a'
    store.pin([resource])
    const file = location(root, resource)
    chmodSync(file, 0o644)
    expect(() => store.pin([resource])).toThrow(/not private/)
    chmodSync(file, 0o600)
    writeFileSync(file, 'not a database')
    expect(() => store.pin([resource])).toThrow()
    const other = 'owner:user:agent:other'
    symlinkSync(path.join(root, 'missing-target'), path.dirname(location(root, other)))
    expect(() => store.pin([other])).toThrow(/not private/)
  })

  it('does not let a stale update erase an already recorded process identity', () => {
    const { store } = fixture()
    const run = record()
    store.prepare(run, store.pin(run.resources))
    const captured: HostCommandRecord = {
      ...run, phase: 'running', processes: [{ pid: 777, parent: 501, group: 777, started: 'birth-777', state: 'S' }]
    }
    store.update(captured)
    expect(() => store.update({ ...run, phase: 'unresolved' })).toThrow(/lost identity/)
    expect(() => store.complete(run)).toThrow(/Stale host run completion/)
    expect(store.records(run.resources)[0].processes).toHaveLength(1)
  })

  it('refuses accidental argv or environment fields in a durable record', () => {
    const { store } = fixture()
    const run = record()
    const generations = store.pin(run.resources)
    expect(() => store.prepare({ ...run, argv: ['secret'] } as HostCommandRecord, generations)).toThrow(/Malformed/)
    expect(() => store.prepare({ ...run, processes: [{ pid: 1, parent: 0, group: 1, started: 'birth', state: 'S', env: 'secret' }] } as HostCommandRecord, generations)).toThrow(/Malformed/)
    expect(store.records(run.resources)).toEqual([])
  })

  it('saves one scoped host notice on every run resource before completion', () => {
    const { root, store } = fixture()
    const run = record()
    store.prepare(run, store.pin(run.resources))
    store.saveRecoveryNotice(run, 'Recorded processes ended; unrecorded commands may remain.')
    expect(store.recoveryNotices(run.resources)).toEqual(['Recorded processes ended; unrecorded commands may remain.'])
    for (const resource of run.resources) {
      const db = new DatabaseSync(location(root, resource))
      expect((db.prepare('SELECT recovery_notice FROM metadata').get() as { recovery_notice: string }).recovery_notice).toMatch(/unrecorded/)
      db.close()
    }
    store.complete(run)
    const lease = store.beginDelete(run.resources, { holder })
    store.finishDelete(lease, { success: true })
    expect(store.recoveryNotices(run.resources)).toHaveLength(1)
  })

  it('rejects stale or oversized recovery notices without changing resource metadata', () => {
    const { store } = fixture()
    const run = record()
    store.prepare(run, store.pin(run.resources))
    expect(() => store.saveRecoveryNotice({ ...run, phase: 'running' }, 'wrong receipt')).toThrow(/Stale/)
    expect(() => store.saveRecoveryNotice(run, 'x'.repeat(1001))).toThrow(/Malformed/)
    expect(store.recoveryNotices(run.resources)).toEqual([])
  })

  it('rolls back every notice copy if its second resource cannot persist', () => {
    const { root, store } = fixture()
    const run = record()
    store.prepare(run, store.pin(run.resources))
    const db = new DatabaseSync(location(root, run.resources[1]))
    db.exec("CREATE TRIGGER reject_notice BEFORE UPDATE OF recovery_notice ON metadata BEGIN SELECT RAISE(ABORT, 'notice write failure'); END")
    db.close()
    expect(() => store.saveRecoveryNotice(run, 'Recorded processes ended.')).toThrow(/notice write failure/)
    expect(store.recoveryNotices(run.resources)).toEqual([])
    expect(store.records(run.resources)).toHaveLength(1)
  })
})
