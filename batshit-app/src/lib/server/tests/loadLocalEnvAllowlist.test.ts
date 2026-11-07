// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeFs = vi.hoisted(() => ({ files: new Map<string, string>(), existsSync: vi.fn(), readFileSync: vi.fn() }))
vi.mock('node:fs', () => ({ default: { existsSync: fakeFs.existsSync, readFileSync: fakeFs.readFileSync } }))
import { loadLocalEnvFiles } from '../../../../scripts/lib/loadLocalEnv'

const names = ['BSTEST_KV_URL', 'BSTEST_KV_READ', 'BSTEST_KV_WRITE', 'BSTEST_PROVIDER_KEY', 'BSTEST_REDIS_URL'] as const
const base = '/virtual/voice-catalog'

beforeEach(() => {
  for (const name of names) delete process.env[name]
  fakeFs.files.clear()
  fakeFs.existsSync.mockReset().mockImplementation((filename: string) => fakeFs.files.has(filename))
  fakeFs.readFileSync.mockReset().mockImplementation((filename: string) => {
    if (!fakeFs.files.has(filename)) throw new Error('unexpected file')
    return fakeFs.files.get(filename)!
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { for (const name of names) delete process.env[name]; vi.restoreAllMocks() })

describe('local env loader selection', () => {
  it('imports only allowed names and preserves the process and local-file precedence', () => {
    fakeFs.files.set(`${base}/.env.local`, 'BSTEST_KV_URL=local-url\nBSTEST_KV_READ=local-read\nBSTEST_PROVIDER_KEY=private-provider\nBSTEST_REDIS_URL=private-redis\n')
    fakeFs.files.set(`${base}/.env`, 'BSTEST_KV_URL=base-url\nBSTEST_KV_WRITE=base-write\nBSTEST_PROVIDER_KEY=other-provider\n')
    process.env.BSTEST_KV_READ = 'process-read'
    loadLocalEnvFiles({ cwd: base, allowedNames: ['BSTEST_KV_URL', 'BSTEST_KV_READ', 'BSTEST_KV_WRITE'] })
    expect(process.env.BSTEST_KV_URL).toBe('local-url')
    expect(process.env.BSTEST_KV_READ).toBe('process-read')
    expect(process.env.BSTEST_KV_WRITE).toBe('base-write')
    expect(process.env.BSTEST_PROVIDER_KEY).toBeUndefined()
    expect(process.env.BSTEST_REDIS_URL).toBeUndefined()
    expect(fakeFs.readFileSync.mock.calls.map(call => call[0])).toEqual([`${base}/.env.local`, `${base}/.env`])
  })

  it('preserves legacy callers and treats an empty process value as an existing override', () => {
    fakeFs.files.set(`${base}/.env.local`, 'BSTEST_KV_URL=local-url\nBSTEST_PROVIDER_KEY=local-provider\n')
    fakeFs.files.set(`${base}/.env`, 'BSTEST_KV_URL=base-url\nBSTEST_REDIS_URL=base-redis\n')
    process.env.BSTEST_KV_URL = ''
    loadLocalEnvFiles({ cwd: base })
    expect(process.env.BSTEST_KV_URL).toBe('')
    expect(process.env.BSTEST_PROVIDER_KEY).toBe('local-provider')
    expect(process.env.BSTEST_REDIS_URL).toBe('base-redis')
  })

  it('treats an explicit empty allowlist as no imports', () => {
    fakeFs.files.set(`${base}/.env`, 'BSTEST_KV_URL=ignored\nBSTEST_PROVIDER_KEY=ignored\n')
    loadLocalEnvFiles({ cwd: base, allowedNames: [] })
    expect(process.env.BSTEST_KV_URL).toBeUndefined()
    expect(process.env.BSTEST_PROVIDER_KEY).toBeUndefined()
  })
})
