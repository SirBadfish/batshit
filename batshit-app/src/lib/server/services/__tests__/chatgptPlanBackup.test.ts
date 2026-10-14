// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, zipSync } from 'fflate/node'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createBackupBundle, preflightBackupRestore } from '../backupRestoreService'
import { ChatgptPlanVault } from '../chatgptPlanVault'
import { ChatgptPlanRuntime, PLAN_AGENT } from '../chatgptPlanRuntime'
import { ChatgptPlanOAuth } from '../chatgptPlanOAuth'
useRedisTestServer()
const USER = 'sa130-backup-user'
let root: string, vault: ChatgptPlanVault, id: string
beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-backup-')))
  vi.stubEnv('UPLOADS_DIR', path.join(root, 'uploads')); vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', path.join(root, 'staging'))
  vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app'); vi.stubEnv('BATSHIT_MAC_DATA_DIR', root)
  vault = new ChatgptPlanVault(path.join(root, 'config', 'chatgpt-plan'), 'sa130-backup-synthetic-instance-key-0123456789')
  const row = vault.connect({ userId: USER, issuer: 'https://auth.openai.com', subject: 'Backup-fixture', clientId: 'oaiapp_Backupfixture', email: '' }, { accessToken: 'BACKUP_ACCESS_SENTINEL', refreshToken: 'BACKUP_REFRESH_SENTINEL', idToken: 'BACKUP_ID_SENTINEL', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }, vault.beginAuthorization(USER))
  id = row.id
  await redis.set('model:sa130-backup-preset', { id: 'sa130-backup-preset', provider: 'openai', modelId: 'fixture-model', connection: { id: `chatgpt-plan:${id}`, type: 'direct', service: 'chatgpt-plan' }, settings: {}, pricing: {} })
  await redis.execute(client => client.sAdd(`user:${USER}:models`, 'sa130-backup-preset'))
})
afterEach(() => { vault.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
describe('host-only ChatGPT custody does not travel with backup metadata', () => {
  it.each([false, true])('excludes the whole vault even with includeSecrets=%s; refuses a forged config payload', async includeSecrets => {
    const bundle = await createBackupBundle(USER, { includeSecrets })
    const entries = unzipSync(bundle.bytes), encoder = new TextEncoder(), decoder = new TextDecoder()
    const names = Object.keys(entries), contents = names.map(name => decoder.decode(entries[name])).join('\n')
    expect(contents).toContain(`chatgpt-plan:${id}`) // A selector is portable metadata, not a grant.
    for (const forbidden of ['BACKUP_ACCESS_SENTINEL', 'BACKUP_REFRESH_SENTINEL', 'BACKUP_ID_SENTINEL', 'oaiapp_Backupfixture', 'credentials.sqlite', 'owner.sqlite', root]) expect(contents + names.join('\n')).not.toContain(forbidden)
    expect(names.some(name => name.includes('chatgpt-plan/') || name.includes('config/'))).toBe(false)
    entries['files/host/config/chatgpt-plan/credentials.sqlite'] = encoder.encode('FORGED_VAULT_SENTINEL')
    await expect(preflightBackupRestore(USER, zipSync(entries))).rejects.toThrow(/place Batshit does not restore/)
  })
  it('a restored selector cannot authorize another instance, even with the same user and instance key', () => {
    const another = new ChatgptPlanVault(path.join(root, 'another-instance', 'config', 'chatgpt-plan'), 'sa130-backup-synthetic-instance-key-0123456789')
    const http = vi.fn() as typeof fetch, oauth = new ChatgptPlanOAuth(another, async () => true, http), runtime = new ChatgptPlanRuntime(another, oauth, http)
    try { expect(() => runtime.acquire(USER, id, PLAN_AGENT)).toThrow(/account/); expect(http).not.toHaveBeenCalled(); expect(another.hostId).not.toBe(vault.hostId) }
    finally { oauth.close(); another.close() }
  })
})
