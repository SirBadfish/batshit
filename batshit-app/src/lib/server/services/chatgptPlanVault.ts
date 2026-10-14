import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'

export type PlanTokens = {
  accessToken: string
  refreshToken: string
  idToken: string
  scopes: string[]
  expiresAt: number
  earliestRefreshAt?: number
}
export type PlanRegistration = {
  id: string; userId: string; issuer: string; subject: string; clientId: string; email: string
  incarnation: string; version: number; state: 'ready' | 'identity-only' | 'reconnect' | 'disconnected'
  refreshPending: boolean
  revocationStatus?: 'pending' | 'confirmed' | 'unconfirmed'
}
type StoredRegistration = PlanRegistration & { ciphertext: string | null }
export class ChatgptPlanError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ChatgptPlanError' }
}

function privateEntry(file: string, directory = false) {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (!directory && stat.nlink !== 1) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new ChatgptPlanError('vault_unsafe', 'ChatGPT credential storage permissions need repair.')
  }
}
function createPrivateFile(file: string): boolean {
  if (existsSync(file)) { privateEntry(file); return false }
  const fd = openSync(file, 'wx', 0o600)
  try { fsyncSync(fd) } finally { closeSync(fd) }
  return true
}

/** Host-only custody. No Redis, browser, env-token propagation or network code. */
export class ChatgptPlanVault {
  private owner: DatabaseSync
  private db!: DatabaseSync
  private key: Buffer
  private folder: string
  private closed = false
  private mutations = new Map<string, Set<Promise<void>>>()

  constructor(folder: string, instanceKey: string) {
    if (instanceKey.length < 32) throw new ChatgptPlanError('vault_key', 'The Mac instance encryption key is unavailable.')
    this.key = Buffer.from(hkdfSync('sha256', instanceKey, '', 'batshit-chatgpt-plan-vault-v1', 32))
    this.folder = path.resolve(folder)
    mkdirSync(this.folder, { recursive: true, mode: 0o700 })
    // realpath checks every ancestor, not just the final entry.
    if (realpathSync(this.folder) !== this.folder) throw new ChatgptPlanError('vault_unsafe', 'ChatGPT credential storage must not use links.')
    privateEntry(this.folder, true)
    const ownerFile = path.join(this.folder, 'owner.sqlite')
    createPrivateFile(ownerFile)
    this.owner = new DatabaseSync(ownerFile, { timeout: 0 })
    try { this.owner.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;') } catch {
      this.owner.close()
      throw new ChatgptPlanError('vault_owner_busy', 'Another Batshit runtime owns this ChatGPT connection. Close it before continuing.')
    }
    try {
      const file = path.join(this.folder, 'credentials.sqlite')
      const fresh = createPrivateFile(file)
      this.db = new DatabaseSync(file, { timeout: 0 })
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;')
      if (fresh) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE accounts (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
          PRAGMA user_version=1; COMMIT;`)
        this.db.prepare('INSERT INTO meta VALUES (?,?)').run('hostId', `urn:uuid:${randomUUID()}`)
        this.syncFolder()
      } else if ((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !== 1) {
        throw new ChatgptPlanError('vault_corrupt', 'ChatGPT credential storage is unreadable. Keep the existing files for recovery.')
      }
      this.checkFiles()
      // The owner OS lock is ours now; any committed refresh marker came from
      // an interrupted prior owner, never a concurrently active exchange.
      this.transaction(() => {
        for (const row of this.rows()) {
          // Detect a wrong/lost key before any operation may overwrite intact
          // ciphertext, including reconnect. No recover-by-default empty vault.
          if (row.ciphertext) this.decrypt(row)
          if (row.refreshPending || row.revocationStatus === 'pending') this.write({ ...row,
            ...(row.refreshPending ? { state: 'reconnect', refreshPending: false, ciphertext: null } : {}),
            ...(row.revocationStatus === 'pending' ? { revocationStatus: 'unconfirmed' } : {}) })
        }
      })
    } catch (error) {
      this.db?.close(); this.owner.exec('ROLLBACK'); this.owner.close(); this.key.fill(0)
      throw error instanceof ChatgptPlanError ? error : new ChatgptPlanError('vault_corrupt', 'ChatGPT credential storage is unreadable. Keep the existing files for recovery.')
    }
  }

  private syncFolder() { const fd = openSync(this.folder, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
  private checkFiles() {
    if (this.closed) throw new ChatgptPlanError('vault_closed', 'ChatGPT connection is shutting down.')
    privateEntry(this.folder, true)
    for (const base of ['owner.sqlite', 'credentials.sqlite']) {
      privateEntry(path.join(this.folder, base))
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const file = path.join(this.folder, base + suffix)
        if (existsSync(file)) privateEntry(file)
      }
    }
  }
  private rows(): StoredRegistration[] {
    return this.db.prepare('SELECT record FROM accounts').all().map(row => JSON.parse(String(row.record)))
  }
  private write(record: StoredRegistration) {
    this.db.prepare('INSERT INTO accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record))
  }
  private transaction<T>(work: () => T): T {
    this.checkFiles(); this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.db.exec('COMMIT'); this.checkFiles(); return value } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* COMMIT may already have completed. */ }
      throw error
    }
  }
  private aad(row: PlanRegistration) {
    return Buffer.from(JSON.stringify(['v1', this.hostId, row.id, row.userId, row.issuer, row.subject, row.clientId, row.incarnation, row.version]))
  }
  private encrypt(row: PlanRegistration, tokens: PlanTokens): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(this.aad(row))
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
  }
  private decrypt(row: StoredRegistration): PlanTokens {
    if (!row.ciphertext) throw new ChatgptPlanError('reconnect_required', 'Continue with ChatGPT in API Keys to reconnect this account.')
    try {
      const bytes = Buffer.from(row.ciphertext, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28)); cipher.setAAD(this.aad(row))
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'))
    } catch { throw new ChatgptPlanError('vault_key', 'ChatGPT credentials could not be decrypted. Keep the existing files for recovery.') }
  }
  get hostId(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get('hostId')
    if (!row || !/^urn:uuid:[0-9a-f-]{36}$/.test(String(row.value))) throw new ChatgptPlanError('vault_corrupt', 'ChatGPT host identity is unreadable.')
    return String(row.value)
  }
  list(userId: string): PlanRegistration[] {
    this.checkFiles()
    return this.rows().filter(row => row.userId === userId).map(({ ciphertext, ...row }) => row)
  }
  get(userId: string, id: string): StoredRegistration {
    this.checkFiles()
    const value = this.db.prepare('SELECT record FROM accounts WHERE id=?').get(id)
    const row: StoredRegistration | undefined = value ? JSON.parse(String(value.record)) : undefined
    if (!row || row.userId !== userId) throw new ChatgptPlanError('account_missing', 'This ChatGPT account is not connected on this Mac. Reconnect it in API Keys.')
    return row
  }
  binding(row: PlanRegistration): string {
    return createHash('sha256').update(this.aad({ ...row, version: 0 })).digest('hex')
  }
  /** A dispatched asynchronous consent write owns this incarnation until it settles. */
  holdMutation(userId: string, id: string, binding: string): () => void {
    const row = this.get(userId, id)
    if (row.state !== 'ready' || this.binding(row) !== binding) throw new ChatgptPlanError('account_changed', 'The ChatGPT connection changed. Start a new turn.')
    let done!: () => void
    const settled = new Promise<void>(resolve => { done = resolve })
    const owners = this.mutations.get(id) ?? new Set<Promise<void>>()
    owners.add(settled); this.mutations.set(id, owners)
    return () => {
      owners.delete(settled); done()
      if (!owners.size) this.mutations.delete(id)
    }
  }
  hasMutations(id: string): boolean { return Boolean(this.mutations.get(id)?.size) }
  async drainMutations(id: string): Promise<void> { await Promise.all([...(this.mutations.get(id) ?? [])]) }
  private assertNoMutations(id: string) {
    if (this.hasMutations(id)) throw new ChatgptPlanError('requests_stopping', 'A ChatGPT approval save is still finishing. Wait before changing this connection.')
  }
  tokens(userId: string, id: string, binding: string): PlanTokens {
    const row = this.get(userId, id)
    if (row.state !== 'ready' || this.binding(row) !== binding || row.refreshPending) throw new ChatgptPlanError('connection_changed', 'This ChatGPT session changed or needs reconnection. Start a new turn after reconnecting.')
    return this.decrypt(row)
  }
  epoch(userId: string): string {
    return String(this.db.prepare('SELECT value FROM meta WHERE key=?').get(`epoch:${userId}`)?.value ?? '')
  }
  cleanupUnconfirmed(userId: string): boolean { this.checkFiles(); return this.db.prepare('SELECT value FROM meta WHERE key=?').get(`cleanup:${userId}`)?.value === 'unconfirmed' }
  recordUnconfirmedCleanup(userId: string) { this.transaction(() => { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`cleanup:${userId}`, 'unconfirmed') }) }
  beginAuthorization(userId: string): string {
    return this.transaction(() => {
      const epoch = randomUUID()
      this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`epoch:${userId}`, epoch)
      return epoch
    })
  }
  connect(identity: Pick<PlanRegistration, 'userId' | 'issuer' | 'subject' | 'clientId' | 'email'>, tokens: PlanTokens, epoch: string, selected?: PlanRegistration): PlanRegistration {
    return this.transaction(() => {
      if (this.epoch(identity.userId) !== epoch) throw new ChatgptPlanError('attempt_stale', 'This sign-in attempt was cancelled or replaced.')
      if (selected && (selected.issuer !== identity.issuer || selected.subject !== identity.subject || selected.clientId !== identity.clientId || this.get(identity.userId, selected.id).incarnation !== selected.incarnation)) {
        throw new ChatgptPlanError('account_mismatch', 'The selected ChatGPT account does not match this sign-in.')
      }
      const previous = this.rows().find(row => row.userId === identity.userId && row.issuer === identity.issuer && row.subject === identity.subject && row.clientId === identity.clientId)
      if (previous) this.assertNoMutations(previous.id)
      if (previous?.revocationStatus === 'pending') throw new ChatgptPlanError('disconnect_pending', 'Wait for ChatGPT disconnect to finish before signing in again.')
      if (previous?.ciphertext || previous?.refreshPending) throw new ChatgptPlanError('disconnect_required', 'Disconnect the existing ChatGPT account before signing in again. This preserves explicit cleanup of its renewable credentials.')
      const row: PlanRegistration = { ...identity, id: previous?.id ?? randomUUID(), incarnation: randomUUID(), version: 1,
        state: ['resource.invoke', 'chatgpt.tokens.use.direct'].every(scope => tokens.scopes.includes(scope)) ? 'ready' : 'identity-only', refreshPending: false }
      this.write({ ...row, ciphertext: this.encrypt(row, tokens) })
      return row
    })
  }
  beginRefresh(userId: string, id: string, binding: string): { registration: PlanRegistration; tokens: PlanTokens } {
    return this.transaction(() => {
      const tokens = this.tokens(userId, id, binding)
      const row = this.get(userId, id)
      this.write({ ...row, refreshPending: true })
      const { ciphertext, ...registration } = row
      return { registration, tokens }
    })
  }
  finishRefresh(registration: PlanRegistration, tokens: PlanTokens | null): boolean {
    return this.transaction(() => {
      const current = this.get(registration.userId, registration.id)
      if (current.incarnation !== registration.incarnation || current.version !== registration.version || !current.refreshPending) return false
      if (!tokens) this.assertNoMutations(registration.id)
      const row = { ...current, version: current.version + 1, refreshPending: false, state: tokens ? current.state : 'reconnect' as const }
      this.write({ ...row, ciphertext: tokens ? this.encrypt(row, tokens) : null })
      return true
    })
  }
  invalidateRenewal(registration: PlanRegistration) {
    this.transaction(() => {
      const current = this.get(registration.userId, registration.id)
      if (current.incarnation !== registration.incarnation) return
      this.assertNoMutations(registration.id)
      this.write({ ...current, version: current.version + 1, state: 'reconnect', refreshPending: false, ciphertext: null })
    })
  }
  disconnect(userId: string, id: string): { registration: PlanRegistration; refreshToken: string | null } {
    return this.transaction(() => {
      this.assertNoMutations(id)
      const current = this.get(userId, id)
      const refreshToken = current.ciphertext ? this.decrypt(current).refreshToken : null
      this.beginEpochWrite(userId)
      // Admission dies durably before any asynchronous stop/drain/revocation.
      const row: StoredRegistration = { ...current, incarnation: randomUUID(), state: 'disconnected', refreshPending: false, ciphertext: null, revocationStatus: 'pending' }
      this.write(row)
      const { ciphertext, ...registration } = row
      return { registration, refreshToken }
    })
  }
  finishRevocation(registration: PlanRegistration, confirmed: boolean) {
    this.transaction(() => {
      // Cleanup evidence belongs to the user/host, independently of whether a
      // newer account incarnation has already replaced this record.
      if (!confirmed) this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`cleanup:${registration.userId}`, 'unconfirmed')
      const row = this.get(registration.userId, registration.id)
      if (row.incarnation !== registration.incarnation || row.state !== 'disconnected') return
      this.write({ ...row, revocationStatus: confirmed ? 'confirmed' : 'unconfirmed' })
    })
  }
  private beginEpochWrite(userId: string) {
    this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`epoch:${userId}`, randomUUID())
  }
  cancelAuthorization(userId: string) { this.transaction(() => this.beginEpochWrite(userId)) }
  close() {
    if (this.closed) return
    if (this.mutations.size) throw new ChatgptPlanError('requests_stopping', 'ChatGPT approval saves have not finished shutting down.')
    this.db.close(); this.owner.exec('ROLLBACK'); this.owner.close(); this.key.fill(0); this.closed = true
  }
}
