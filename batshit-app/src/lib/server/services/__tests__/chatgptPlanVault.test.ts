import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, chmodSync, symlinkSync, unlinkSync, linkSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import { ChatgptPlanVault, type PlanTokens } from '../chatgptPlanVault'

const KEY = 'synthetic-instance-key-for-sa130-tests-only'
const identity = { userId: 'u_fixture', issuer: 'https://auth.openai.com', subject: 'Subject-A', clientId: 'oaiapp_Fixture', email: 'fixture@example.invalid' }
const tokens: PlanTokens = { accessToken: 'ACCESS_SECRET_SENTINEL', refreshToken: 'REFRESH_SECRET_SENTINEL', idToken: 'ID_SECRET_SENTINEL', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: 123456789 }
const folders: string[] = []
const vaults: ChatgptPlanVault[] = []
function open(folder?: string, key = KEY) {
  if (!folder) { folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-vault-'))); folders.push(folder) }
  const vault = new ChatgptPlanVault(folder, key); vaults.push(vault)
  return { vault, folder }
}
afterEach(() => { for (const vault of vaults.splice(0)) vault.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

describe('ChatGPT host-local vault', () => {
  it('encrypts credentials, preserves host identity, and admits one actual SQLite owner', () => {
    const { vault, folder } = open()
    const host = vault.hostId
    const row = vault.connect(identity, tokens, vault.beginAuthorization(identity.userId))
    expect(vault.tokens(identity.userId, row.id, vault.binding(row))).toEqual(tokens)
    const bytes = readFileSync(path.join(folder, 'credentials.sqlite')).toString('utf8')
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.idToken]) expect(bytes).not.toContain(secret)
    expect(JSON.stringify(vault.list(identity.userId))).not.toContain('SECRET_SENTINEL')
    expect(() => open(folder)).toThrow(/Another Batshit runtime/)
    vault.close()
    const next = open(folder).vault
    expect(next.hostId).toBe(host)
    expect(next.tokens(identity.userId, row.id, next.binding(row))).toEqual(tokens)
    expect(() => next.get('another-user', row.id)).toThrow(/not connected/)
  })
  it('commits an orphan refresh marker and refuses rotated-token reuse after owner loss', () => {
    const { vault, folder } = open()
    const row = vault.connect(identity, tokens, vault.beginAuthorization(identity.userId))
    const binding = vault.binding(row)
    vault.beginRefresh(identity.userId, row.id, binding)
    vault.close() // exact durable state left by a crash before response persistence
    const next = open(folder).vault
    expect(next.get(identity.userId, row.id).state).toBe('reconnect')
    expect(() => next.tokens(identity.userId, row.id, binding)).toThrow(/changed or needs reconnection/)
  })
  it('refresh keeps binding, disconnect fences late refresh and OAuth completion', () => {
    const { vault } = open()
    const row = vault.connect(identity, tokens, vault.beginAuthorization(identity.userId))
    const binding = vault.binding(row)
    const refresh = vault.beginRefresh(identity.userId, row.id, binding)
    expect(vault.finishRefresh(refresh.registration, { ...tokens, accessToken: 'ROTATED_SENTINEL' })).toBe(true)
    expect(vault.binding(vault.get(identity.userId, row.id))).toBe(binding)
    const nextRefresh = vault.beginRefresh(identity.userId, row.id, binding)
    const epoch = vault.beginAuthorization(identity.userId)
    const disconnected = vault.disconnect(identity.userId, row.id)
    expect(vault.finishRefresh(nextRefresh.registration, tokens)).toBe(false)
    expect(() => vault.connect(identity, tokens, epoch, row)).toThrow(/cancelled or replaced/)
    expect(() => vault.tokens(identity.userId, row.id, binding)).toThrow(/changed or needs reconnection/)
    vault.finishRevocation(disconnected.registration, false)
    expect(vault.list(identity.userId)[0].revocationStatus).toBe('unconfirmed')
  })
  it('rejects a returning different subject without replacing the working registration', () => {
    const { vault } = open()
    const row = vault.connect(identity, tokens, vault.beginAuthorization(identity.userId))
    expect(() => vault.connect({ ...identity, subject: 'subject-a' }, tokens, vault.beginAuthorization(identity.userId), row)).toThrow(/does not match/)
    expect(vault.tokens(identity.userId, row.id, vault.binding(row))).toEqual(tokens)
  })
  it('lost keys and unsafe files block instead of clearing ciphertext', () => {
    const { vault, folder } = open()
    vault.connect(identity, tokens, vault.beginAuthorization(identity.userId)); vault.close()
    const before = readFileSync(path.join(folder, 'credentials.sqlite'))
    expect(() => open(folder, 'different-synthetic-instance-key-000000')).toThrow(/could not be decrypted/)
    expect(readFileSync(path.join(folder, 'credentials.sqlite'))).toEqual(before)
    chmodSync(path.join(folder, 'credentials.sqlite'), 0o644)
    expect(() => open(folder)).toThrow(/permissions/)
    chmodSync(path.join(folder, 'credentials.sqlite'), 0o600)
    const hardlink = path.join(folder, 'credentials-copy.sqlite')
    linkSync(path.join(folder, 'credentials.sqlite'), hardlink)
    expect(() => open(folder)).toThrow(/permissions/)
    unlinkSync(hardlink)
    const link = folder + '-link'; symlinkSync(folder, link)
    try { expect(() => open(link)).toThrow(/must not use links/) } finally { unlinkSync(link) }
  })
  it('owns a private Docker key exclusively, persists it across restart, and refuses a second actual process', () => {
    const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-private-key-'))); folders.push(folder)
    const vault = new ChatgptPlanVault(folder, { privateKeyFile: true }); vaults.push(vault)
    const row = vault.connect(identity, tokens, vault.beginAuthorization(identity.userId)), hostId = vault.hostId
    const keyPath = path.join(folder, 'vault.key'), digest = () => createHash('sha256').update(readFileSync(keyPath)).digest('hex')
    const before = digest()
    expect(statSync(keyPath).mode & 0o777).toBe(0o600); expect(statSync(keyPath).nlink).toBe(1)
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e',
      `import { ChatgptPlanVault } from ${JSON.stringify(pathToFileURL(path.resolve('src/lib/server/services/chatgptPlanVault.ts')).href)};
       try { new ChatgptPlanVault(process.argv[1], { privateKeyFile: true }); process.exitCode=2 }
       catch (error) { process.exitCode=error.code==='vault_owner_busy'?0:3 }`, folder], { encoding: 'utf8', timeout: 10_000 })
    expect(child.status, child.stderr).toBe(0); expect(digest()).toBe(before)
    vault.close()
    const next = new ChatgptPlanVault(folder, { privateKeyFile: true }); vaults.push(next)
    expect(next.hostId).toBe(hostId); expect(digest()).toBe(before)
    expect(next.tokens(identity.userId, row.id, next.binding(row))).toEqual(tokens)
  })
  it('never regenerates a lost private key or adopts unsafe/wrong key files; releases failed initialization ownership', () => {
    const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-private-key-refusal-'))); folders.push(folder)
    const vault = new ChatgptPlanVault(folder, { privateKeyFile: true }); vaults.push(vault)
    vault.connect(identity, tokens, vault.beginAuthorization(identity.userId)); vault.close()
    const keyPath = path.join(folder, 'vault.key'), key = readFileSync(keyPath), before = readFileSync(path.join(folder, 'credentials.sqlite'))
    const denied = () => expect(() => new ChatgptPlanVault(folder, { privateKeyFile: true })).toThrow()
    chmodSync(keyPath, 0o644); denied(); chmodSync(keyPath, 0o600)
    const alias = path.join(folder, 'key-alias'); linkSync(keyPath, alias); denied(); unlinkSync(alias)
    unlinkSync(keyPath); denied(); expect(existsSync(keyPath)).toBe(false)
    writeFileSync(keyPath, 'a'.repeat(64), { mode: 0o600 }); denied()
    expect(readFileSync(path.join(folder, 'credentials.sqlite'))).toEqual(before)
    unlinkSync(keyPath); symlinkSync(path.join(folder, 'credentials.sqlite'), keyPath); denied(); unlinkSync(keyPath)
    writeFileSync(keyPath, key, { mode: 0o600 })
    const reopened = new ChatgptPlanVault(folder, { privateKeyFile: true }); vaults.push(reopened)
    expect(reopened.list(identity.userId)).toHaveLength(1)
    const uncertain = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-uncertain-key-'))); folders.push(uncertain)
    writeFileSync(path.join(uncertain, 'credentials.sqlite-journal'), 'synthetic existing sidecar', { mode: 0o600 })
    expect(() => new ChatgptPlanVault(uncertain, { privateKeyFile: true })).toThrow(/missing/)
    expect(existsSync(path.join(uncertain, 'vault.key'))).toBe(false)
  })
  it.each([false, true])('refuses a different private key with no retained ciphertext (disconnected=%s)', disconnected => {
    const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-empty-private-key-'))); folders.push(folder)
    const vault = new ChatgptPlanVault(folder, { privateKeyFile: true }); vaults.push(vault)
    if (disconnected) {
      const row = vault.connect(identity, tokens, vault.beginAuthorization(identity.userId))
      const removed = vault.disconnect(identity.userId, row.id); vault.finishRevocation(removed.registration, true)
    }
    vault.close()
    writeFileSync(path.join(folder, 'vault.key'), 'b'.repeat(64), { mode: 0o600 })
    expect(() => new ChatgptPlanVault(folder, { privateKeyFile: true })).toThrow(/does not match/)
  })
  it('refuses an existing Docker database without a verifier instead of adopting its supplied key', () => {
    const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-missing-verifier-'))); folders.push(folder)
    const vault = new ChatgptPlanVault(folder, { privateKeyFile: true }); vaults.push(vault); vault.close()
    const db = new DatabaseSync(path.join(folder, 'credentials.sqlite'))
    try { db.prepare('DELETE FROM meta WHERE key=?').run('privateKeyVerifier') } finally { db.close() }
    const before = readFileSync(path.join(folder, 'credentials.sqlite'))
    expect(() => new ChatgptPlanVault(folder, { privateKeyFile: true })).toThrow(/does not match/)
    expect(readFileSync(path.join(folder, 'credentials.sqlite'))).toEqual(before)
  })
  it('refuses a missing credential database after Docker key/owner persistence without inventing a new host', () => {
    const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-missing-private-db-'))); folders.push(folder)
    const vault = new ChatgptPlanVault(folder, { privateKeyFile: true }); vaults.push(vault); vault.close()
    const keyPath = path.join(folder, 'vault.key'), keyDigest = createHash('sha256').update(readFileSync(keyPath)).digest('hex')
    const dbPath = path.join(folder, 'credentials.sqlite'); unlinkSync(dbPath)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => new ChatgptPlanVault(folder, { privateKeyFile: true })).toThrow(/incomplete/)
      expect(existsSync(dbPath)).toBe(false)
      expect(createHash('sha256').update(readFileSync(keyPath)).digest('hex')).toBe(keyDigest)
    }
  })
})
