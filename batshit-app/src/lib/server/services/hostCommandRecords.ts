import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HostProcessIdentity } from './hostProcessIdentity'

/** Diagnostic receipts only. A persisted PID or group never grants signal authority. */
export interface HostCommandRecord {
  version: 1
  runId: string
  kind: 'codex' | 'guardian'
  resources: string[]
  bootId: string
  namespaceId: string
  instanceId: string
  lane: string
  owner: { userId: string; kind: 'agent' | 'subagent' | 'host'; id: string }
  profileId: string | null
  sessionId: string | null
  messageId: string | null
  program: string
  phase: 'prepared' | 'running' | 'unresolved'
  processes: HostProcessIdentity[]
  guardianGroup?: number
}

export interface HostDeleteHolder {
  instanceId: string
  bootId: string
  namespaceId: string
  process: HostProcessIdentity
}

export interface HostDeleteMarker {
  token: string
  phase: 'active' | 'blocked'
  resources: string[]
  holder: HostDeleteHolder
}

export type HostDeleteLease = HostDeleteMarker

const SCHEMA_VERSION = 1
const BUSY_TIMEOUT_MS = 2_000
const textField = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const nullableText = (value: unknown): value is string | null => value === null || textField(value)
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const onlyKeys = (value: object, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

function resourcesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10 || !value.every((item) => textField(item))) {
    throw new Error('Host record resources are missing or malformed.')
  }
  const sorted = [...value].sort()
  if (new Set(sorted).size !== sorted.length) throw new Error('Host record resources must be unique.')
  return sorted
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validProcess(value: unknown): value is HostProcessIdentity {
  if (!value || typeof value !== 'object') return false
  const process = value as Partial<HostProcessIdentity>
  return onlyKeys(value, ['pid', 'parent', 'group', 'started', 'state', 'program']) &&
    positiveInt(process.pid) && Number.isSafeInteger(process.parent) && (process.parent ?? -1) >= 0 &&
    positiveInt(process.group) && textField(process.started) && textField(process.state, 32) &&
    (process.program === undefined || textField(process.program, 80))
}

function validateRecord(value: unknown): HostCommandRecord {
  if (!value || typeof value !== 'object') throw new Error('Malformed host command record.')
  const row = value as Partial<HostCommandRecord>
  const resources = resourcesOf(row.resources)
  const owner = row.owner
  if (!onlyKeys(value, ['version', 'runId', 'kind', 'resources', 'bootId', 'namespaceId', 'instanceId',
    'lane', 'owner', 'profileId', 'sessionId', 'messageId', 'program', 'phase', 'processes', 'guardianGroup']) ||
    row.version !== 1 || !textField(row.runId) || !['codex', 'guardian'].includes(row.kind ?? '') ||
    !textField(row.bootId) || !textField(row.namespaceId) || !textField(row.instanceId) ||
    !textField(row.lane) || !owner || !onlyKeys(owner, ['userId', 'kind', 'id']) || !textField(owner.userId) ||
    !['agent', 'subagent', 'host'].includes(owner.kind ?? '') || !textField(owner.id) ||
    !nullableText(row.profileId) || !nullableText(row.sessionId) || !nullableText(row.messageId) ||
    !textField(row.program, 80) || !['prepared', 'running', 'unresolved'].includes(row.phase ?? '') ||
    !Array.isArray(row.processes) || !row.processes.every(validProcess) ||
    (row.guardianGroup !== undefined && !positiveInt(row.guardianGroup))) {
    throw new Error('Malformed or unsupported host command record.')
  }
  const identities = row.processes.map((process) => `${process.pid}:${process.started}`)
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate host process identity.')
  return { ...row, resources } as HostCommandRecord
}

function validateMarker(value: unknown): HostDeleteMarker {
  if (!value || typeof value !== 'object') throw new Error('Malformed host deletion marker.')
  const marker = value as Partial<HostDeleteMarker>
  const holder = marker.holder
  const resources = resourcesOf(marker.resources)
  if (!onlyKeys(value, ['token', 'phase', 'resources', 'holder']) ||
    !textField(marker.token) || !['active', 'blocked'].includes(marker.phase ?? '') ||
    !holder || !onlyKeys(holder, ['instanceId', 'bootId', 'namespaceId', 'process']) ||
    !textField(holder.instanceId) || !textField(holder.bootId) ||
    !textField(holder.namespaceId) || !validProcess(holder.process)) {
    throw new Error('Malformed host deletion marker.')
  }
  return { ...marker, resources } as HostDeleteMarker
}

function privateDirectory(dir: string): void {
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Host command record directory is not private: ${dir}`)
  }
}

function pathEntryExists(entry: string): boolean {
  try { lstatSync(entry); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function privateFile(file: string): void {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Host command record file is not private: ${file}`)
  }
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function dbSchema(db: DatabaseSync, resource: string): void {
  db.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=EXTRA;
    CREATE TABLE metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      resource TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      deletion TEXT,
      recovery_notice TEXT
    ) STRICT;
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
    PRAGMA user_version=${SCHEMA_VERSION};
  `)
  db.prepare('INSERT INTO metadata(singleton,resource,generation,deletion,recovery_notice) VALUES (1,?,0,NULL,NULL)').run(resource)
}

interface ResourceConnection { resource: string; alias: string; dbPath: string }

/**
 * A small host-only write-ahead admission gate. Each resource owns its own SQLite file, so a
 * damaged profile cannot make unrelated owners undeletable. Multi-file mutations use SQLite's
 * rollback/super-journal: WAL is deliberately forbidden because ATTACH+WAL is not crash-atomic.
 * No method signals a saved PID or decides that observed processes have exited.
 */
export class HostCommandRecordStore {
  private readonly resourceRoot: string
  private readonly historyRoot: string

  constructor(options: { root: string }) {
    if (!path.isAbsolute(options.root)) throw new Error('Host command record root must be absolute.')
    this.resourceRoot = path.join(options.root, 'resources')
    this.historyRoot = path.join(options.root, 'resource-history')
    mkdirSync(options.root, { recursive: true, mode: 0o700 })
    privateDirectory(options.root)
    mkdirSync(this.resourceRoot, { recursive: true, mode: 0o700 })
    privateDirectory(this.resourceRoot)
    mkdirSync(this.historyRoot, { recursive: true, mode: 0o700 })
    privateDirectory(this.historyRoot)
  }

  private location(resource: string): { dir: string; dbPath: string; markerPath: string; markerContent: string } {
    if (!textField(resource)) throw new Error('Malformed host command resource.')
    const digest = createHash('sha256').update(resource).digest('hex')
    const dir = path.join(this.resourceRoot, digest)
    return {
      dir,
      dbPath: path.join(dir, 'ledger.sqlite'),
      markerPath: path.join(this.historyRoot, `${digest}.json`),
      markerContent: JSON.stringify({ version: SCHEMA_VERSION, digest, resource }) + '\n'
    }
  }

  private validateCreationMarker(markerPath: string, expected: string): void {
    privateFile(markerPath)
    if (lstatSync(markerPath).size !== Buffer.byteLength(expected) || readFileSync(markerPath, 'utf8') !== expected) {
      throw new Error(`Malformed host resource creation marker: ${markerPath}`)
    }
  }

  private ensureCreationMarker(markerPath: string, expected: string): void {
    if (pathEntryExists(markerPath)) {
      this.validateCreationMarker(markerPath, expected)
      return
    }
    const temporary = path.join(this.historyRoot, `.create-${randomUUID()}`)
    try {
      writeFileSync(temporary, expected, { flag: 'wx', mode: 0o600 })
      const fd = openSync(temporary, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      try { linkSync(temporary, markerPath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        this.validateCreationMarker(markerPath, expected)
      }
      syncDirectory(this.historyRoot)
    } finally {
      if (pathEntryExists(temporary)) unlinkSync(temporary)
    }
  }

  private ensure(resource: string): string {
    const { dir, dbPath, markerPath, markerContent } = this.location(resource)
    const knownResource = pathEntryExists(markerPath)
    if (knownResource) this.validateCreationMarker(markerPath, markerContent)
    if (!pathEntryExists(dir)) {
      if (knownResource) throw new Error(`Host resource directory disappeared: ${dir}`)
      const temporary = path.join(this.resourceRoot, `.create-${randomUUID()}`)
      mkdirSync(temporary, { mode: 0o700 })
      const tempDb = path.join(temporary, 'ledger.sqlite')
      try {
        closeSync(openSync(tempDb, 'wx', 0o600))
        const db = new DatabaseSync(tempDb, { timeout: BUSY_TIMEOUT_MS })
        try { dbSchema(db, resource) } finally { db.close() }
        chmodSync(tempDb, 0o600)
        syncDirectory(temporary)
        try {
          renameSync(temporary, dir)
          syncDirectory(this.resourceRoot)
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
      }
    }
    privateDirectory(dir)
    // An existing resource directory without its DB is evidence loss, never a fresh empty DB.
    privateFile(dbPath)
    // Publish the independent marker before pin/prepare can admit a command. A committed
    // resource directory that later disappears must not be mistaken for a first use.
    this.ensureCreationMarker(markerPath, markerContent)
    return dbPath
  }

  private transaction<T>(resources: string[], fn: (db: DatabaseSync, aliases: ResourceConnection[]) => T): T {
    const names = resourcesOf(resources)
    const aliases = names.map((resource, index) => ({ resource, alias: `r${index}`, dbPath: this.ensure(resource) }))
    const db = new DatabaseSync(aliases[0].dbPath, { timeout: BUSY_TIMEOUT_MS })
    let begun = false
    try {
      for (const entry of aliases.slice(1)) db.prepare(`ATTACH DATABASE ? AS ${entry.alias}`).run(entry.dbPath)
      for (const entry of aliases) {
        const mode = db.prepare(`PRAGMA ${entry.alias === 'r0' ? 'main' : entry.alias}.journal_mode`).get()
        if (Object.values(mode ?? {})[0] !== 'delete') throw new Error('Host record DB must use DELETE journaling.')
        // DELETE+FULL can lose the last committed transaction on power loss; EXTRA syncs the
        // journal directory too. A vanished pre-exec admission would be a false empty ledger.
        db.exec(`PRAGMA ${entry.alias === 'r0' ? 'main' : entry.alias}.synchronous=EXTRA`)
        const version = db.prepare(`PRAGMA ${entry.alias === 'r0' ? 'main' : entry.alias}.user_version`).get()
        if (Object.values(version ?? {})[0] !== SCHEMA_VERSION) throw new Error('Unsupported host record DB schema.')
        const integrity = db.prepare(`PRAGMA ${entry.alias === 'r0' ? 'main' : entry.alias}.quick_check`).get()
        if (Object.values(integrity ?? {})[0] !== 'ok') throw new Error('Corrupt host record DB.')
        const meta = db.prepare(`SELECT resource,generation,deletion,recovery_notice FROM ${entry.alias === 'r0' ? 'main' : entry.alias}.metadata WHERE singleton=1`).get() as
          { resource?: unknown; generation?: unknown; deletion?: unknown; recovery_notice?: unknown } | undefined
        if (meta?.resource !== entry.resource || !Number.isSafeInteger(meta.generation) || (meta.generation as number) < 0 ||
          (meta.deletion !== null && typeof meta.deletion !== 'string') ||
          (meta.recovery_notice !== null && !textField(meta.recovery_notice, 1000))) {
          throw new Error('Malformed host record DB metadata.')
        }
        if (meta.deletion !== null && !validateMarker(JSON.parse(meta.deletion as string)).resources.includes(entry.resource)) {
          throw new Error('Misfiled host deletion marker.')
        }
        for (const row of db.prepare(`SELECT run_id,record FROM ${entry.alias === 'r0' ? 'main' : entry.alias}.runs`).all() as
          Array<{ run_id: string; record: string }>) {
          if (typeof row.record !== 'string') throw new Error('Malformed host run row.')
          const record = validateRecord(JSON.parse(row.record))
          if (row.run_id !== record.runId || !record.resources.includes(entry.resource)) throw new Error('Misfiled host run record.')
        }
      }
      db.exec('BEGIN IMMEDIATE')
      begun = true
      const result = fn(db, aliases)
      db.exec('COMMIT')
      begun = false
      return result
    } catch (error) {
      if (begun) { try { db.exec('ROLLBACK') } catch { /* retain original failure */ } }
      throw error
    } finally { db.close() }
  }

  private metadata(db: DatabaseSync, alias: string): { generation: number; deletion: HostDeleteMarker | null } {
    const row = db.prepare(`SELECT generation,deletion FROM ${alias}.metadata WHERE singleton=1`).get() as
      { generation: number; deletion: string | null } | undefined
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) throw new Error('Malformed host record metadata.')
    return { generation: row.generation, deletion: row.deletion === null ? null : validateMarker(JSON.parse(row.deletion)) }
  }

  pin(resources: string[]): Record<string, number> {
    return this.transaction(resources, (db, aliases) => {
      const result: Record<string, number> = Object.create(null)
      for (const { resource, alias } of aliases) {
        const meta = this.metadata(db, alias === 'r0' ? 'main' : alias)
        if (meta.deletion) throw new Error(`Host resource is being deleted: ${resource}`)
        result[resource] = meta.generation
      }
      return result
    })
  }

  prepare(input: HostCommandRecord, generations: Record<string, number>): void {
    const record = validateRecord(input)
    this.transaction(record.resources, (db, aliases) => {
      for (const { resource, alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        const meta = this.metadata(db, schema)
        if (meta.deletion || meta.generation !== generations[resource]) throw new Error(`Stale or deleting host resource: ${resource}`)
        db.prepare(`INSERT INTO ${schema}.runs(run_id,record) VALUES (?,?)`).run(record.runId, JSON.stringify(record))
      }
    })
  }

  private existing(db: DatabaseSync, aliases: ResourceConnection[], record: HostCommandRecord): HostCommandRecord {
    let first: HostCommandRecord | undefined
    for (const { alias, resource } of aliases) {
      const schema = alias === 'r0' ? 'main' : alias
      const row = db.prepare(`SELECT record FROM ${schema}.runs WHERE run_id=?`).get(record.runId) as { record?: unknown } | undefined
      if (typeof row?.record !== 'string') throw new Error(`Missing host run copy for ${resource}.`)
      const stored = validateRecord(JSON.parse(row.record))
      if (!sameStrings(stored.resources, record.resources) || !stored.resources.includes(resource) ||
        (first && JSON.stringify(first) !== JSON.stringify(stored))) throw new Error('Inconsistent host run copies.')
      first = stored
    }
    return first!
  }

  private fixedIdentity(row: HostCommandRecord): string {
    return JSON.stringify([
      row.version, row.runId, row.kind, row.resources, row.bootId, row.namespaceId,
      row.instanceId, row.lane, row.owner.userId, row.owner.kind, row.owner.id,
      row.profileId, row.sessionId, row.messageId, row.program
    ])
  }

  private sameReceipt(left: HostCommandRecord, right: HostCommandRecord): boolean {
    return this.fixedIdentity(left) === this.fixedIdentity(right) && left.phase === right.phase &&
      left.guardianGroup === right.guardianGroup &&
      JSON.stringify(left.processes.map((p) => [p.pid, p.parent, p.group, p.started, p.state, p.program ?? null])) ===
      JSON.stringify(right.processes.map((p) => [p.pid, p.parent, p.group, p.started, p.state, p.program ?? null]))
  }

  update(input: HostCommandRecord): void {
    const record = validateRecord(input)
    this.transaction(record.resources, (db, aliases) => {
      const old = this.existing(db, aliases, record)
      if (this.fixedIdentity(old) !== this.fixedIdentity(record) ||
        (old.guardianGroup !== undefined && old.guardianGroup !== record.guardianGroup) ||
        (old.phase === 'running' && record.phase === 'prepared') ||
        (old.phase === 'unresolved' && record.phase !== 'unresolved') ||
        old.processes.some((prior) => !record.processes.some((next) => prior.pid === next.pid && prior.started === next.started && prior.group === next.group))) {
        throw new Error('Host run update lost identity, process evidence, or lifecycle state.')
      }
      for (const { alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        db.prepare(`UPDATE ${schema}.runs SET record=? WHERE run_id=?`).run(JSON.stringify(record), record.runId)
      }
    })
  }

  /** Call only after live cleanup or a separately verified recovery; never infer exit here. */
  complete(input: HostCommandRecord): void {
    const record = validateRecord(input)
    this.transaction(record.resources, (db, aliases) => {
      const stored = this.existing(db, aliases, record)
      if (!this.sameReceipt(stored, record)) throw new Error('Stale host run completion receipt.')
      for (const { alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        db.prepare(`DELETE FROM ${schema}.runs WHERE run_id=?`).run(record.runId)
      }
    })
  }

  /** Persist one bounded host-only notice while this exact recovery receipt still exists. */
  saveRecoveryNotice(input: HostCommandRecord, notice: string): void {
    const record = validateRecord(input)
    if (!textField(notice, 1000)) throw new Error('Malformed host recovery notice.')
    this.transaction(record.resources, (db, aliases) => {
      const stored = this.existing(db, aliases, record)
      if (!this.sameReceipt(stored, record)) throw new Error('Stale host recovery notice receipt.')
      for (const { alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        db.prepare(`UPDATE ${schema}.metadata SET recovery_notice=? WHERE singleton=1`).run(notice)
      }
    })
  }

  /** One latest notice per resource; retained across run completion and owner deletion. */
  recoveryNotices(resources: string[]): string[] {
    return this.transaction(resources, (db, aliases) => {
      const notices = new Set<string>()
      for (const { alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        const row = db.prepare(`SELECT recovery_notice FROM ${schema}.metadata WHERE singleton=1`).get() as
          { recovery_notice: string | null }
        if (row.recovery_notice !== null) {
          if (!textField(row.recovery_notice, 1000)) throw new Error('Malformed host recovery notice.')
          notices.add(row.recovery_notice)
        }
      }
      return [...notices]
    })
  }

  records(resources: string[]): HostCommandRecord[] {
    return this.transaction(resources, (db, aliases) => {
      const byRun = new Map<string, { record: HostCommandRecord; seen: Set<string> }>()
      for (const { alias, resource } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        const rows = db.prepare(`SELECT run_id,record FROM ${schema}.runs`).all() as Array<{ run_id: string; record: string }>
        for (const row of rows) {
          if (typeof row.record !== 'string') throw new Error('Malformed host run row.')
          const record = validateRecord(JSON.parse(row.record))
          if (row.run_id !== record.runId || !record.resources.includes(resource)) throw new Error('Misfiled host run record.')
          const existing = byRun.get(record.runId)
          if (existing) {
            if (JSON.stringify(existing.record) !== JSON.stringify(record)) throw new Error('Inconsistent host run copies.')
            existing.seen.add(resource)
          } else byRun.set(record.runId, { record, seen: new Set([resource]) })
        }
      }
      for (const { record, seen } of byRun.values()) {
        for (const resource of record.resources) {
          if (aliases.some((entry) => entry.resource === resource) && !seen.has(resource)) throw new Error('Missing host run copy.')
        }
      }
      return [...byRun.values()].map(({ record }) => record)
    })
  }

  deletion(resources: string[]): HostDeleteMarker | null {
    return this.transaction(resources, (db, aliases) => {
      const markers = aliases.map(({ alias }) => this.metadata(db, alias === 'r0' ? 'main' : alias).deletion)
      const first = markers[0]
      if (markers.some((marker) => JSON.stringify(marker) !== JSON.stringify(first))) throw new Error('Conflicting host deletion markers.')
      return first
    })
  }

  /** A caller may replace an active marker only after independently verifying its holder ended. */
  beginDelete(resources: string[], options: { holder: HostDeleteHolder; replaceToken?: string }): HostDeleteLease {
    const names = resourcesOf(resources)
    if (!validProcess(options.holder.process) || !textField(options.holder.instanceId) ||
      !textField(options.holder.bootId) || !textField(options.holder.namespaceId)) throw new Error('Malformed delete holder.')
    return this.transaction(names, (db, aliases) => {
      const current = aliases.map(({ alias }) => this.metadata(db, alias === 'r0' ? 'main' : alias).deletion)
      const previous = current[0]
      if (current.some((marker) => JSON.stringify(marker) !== JSON.stringify(previous))) throw new Error('Conflicting host deletion markers.')
      if (previous && (!sameStrings(previous.resources, names) ||
        (previous.phase === 'active' && previous.token !== options.replaceToken))) {
        throw new Error('Host deletion is already active.')
      }
      for (const { alias, resource } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        if (db.prepare(`SELECT 1 FROM ${schema}.runs LIMIT 1`).get()) throw new Error(`Unresolved host run blocks deletion of ${resource}.`)
      }
      const marker: HostDeleteMarker = { token: randomUUID(), phase: 'active', resources: names, holder: options.holder }
      for (const { alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        db.prepare(`UPDATE ${schema}.metadata SET deletion=? WHERE singleton=1`).run(JSON.stringify(marker))
      }
      return marker
    })
  }

  /** Releasing any attempted delete advances generations; blocked keeps its durable marker. */
  finishDelete(lease: HostDeleteLease, result: { success: boolean; keepBlocked?: boolean }): void {
    const marker = validateMarker(lease)
    this.transaction(marker.resources, (db, aliases) => {
      for (const { alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        const current = this.metadata(db, schema).deletion
        if (!current || current.token !== marker.token || current.phase !== 'active' ||
          !sameStrings(current.resources, marker.resources)) throw new Error('Stale host deletion lease.')
        if (db.prepare(`SELECT 1 FROM ${schema}.runs LIMIT 1`).get()) throw new Error('Unresolved run blocks deletion finish.')
      }
      for (const { alias } of aliases) {
        const schema = alias === 'r0' ? 'main' : alias
        if (!result.success && result.keepBlocked) {
          db.prepare(`UPDATE ${schema}.metadata SET deletion=? WHERE singleton=1`).run(JSON.stringify({ ...marker, phase: 'blocked' }))
        } else {
          db.prepare(`UPDATE ${schema}.metadata SET generation=generation+1,deletion=NULL WHERE singleton=1`).run()
        }
      }
    })
  }
}
