import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, chmodSync, symlinkSync, unlinkSync, linkSync } from 'node:fs'
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
})
