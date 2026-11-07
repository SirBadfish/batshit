import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const conversion = vi.hoisted(() => vi.fn(async () => ({ users: 0, subjects: 0 })))
// SA-139: importing the hooks arms the Claude plan run lifecycle (boot sweep of /tmp, shutdown task).
vi.mock('$lib/server/services/claudePlanRunRegistry', () => ({ armClaudePlanRunLifecycle: vi.fn() }))
vi.mock('$lib/server/services/toolSettingsMigration', () => ({ materializeToolSettingsAtStartup: conversion }))

const backup = vi.hoisted(() => ({ complete: vi.fn(async () => {}), fail: vi.fn() }))
vi.mock('$lib/server/services/automaticBackupStartup', () => ({
  automaticBackupBuildId: (version: string, dev: boolean) => dev ? 'development' : `sveltekit:${version}`,
  beginAutomaticBackupStartup: () => ({ signal: new AbortController().signal, finish: vi.fn() }),
  completeAutomaticBackupStartup: backup.complete,
  failAutomaticBackupStartup: backup.fail
}))

// Load the existing hook dependency graph during module setup, before any test
// owns a pending migration promise. Each case reloads only its runtime state.
await import('./hooks.server')

async function startup() {
  const recovery = await import('$lib/server/services/backupRestoreService')
  const skills = await import('$lib/server/services/skillRegistry')
  const prompts = await import('$lib/server/services/systemPromptRegistry')
  const clips = await import('$lib/server/services/retiredSystemClips')
  const zipFields = await import('$lib/server/services/retiredZipControlFields')
  const zipDefaults = await import('$lib/server/services/zipDefaultsSweep')
  const indexes = await import('$lib/server/services/memory/memoryIndex')
  const media = await import('$lib/server/services/memory/memoryMediaMigration')
  const dreaming = await import('$lib/server/services/memory/memoryDreamingScheduler')
  const schedule = await import('$lib/server/services/schedules/scheduleTicker')
  const commands = await import('$lib/server/services/systemSlashCommands')
  conversion.mockReset().mockResolvedValue({ users: 0, subjects: 0 })
  const mocks = {
    recovery: vi.spyOn(recovery, 'ensureBackupRestoreRecovery').mockResolvedValue(undefined),
    skills: vi.spyOn(skills, 'ensureSkillFilesystemStartup').mockResolvedValue({ complete: true, failed: 0 }),
    commands: vi.spyOn(commands, 'initializeSystemSlashCommandsAtStartup').mockResolvedValue(undefined),
    fold: vi.spyOn(prompts, 'foldRetiredZipToolPrompts').mockResolvedValue({ carried: null, kept: [], removed: [] }),
    defaults: vi.spyOn(prompts, 'listCoreSystemPrompts').mockResolvedValue([]),
    retiredPrompts: vi.spyOn(prompts, 'removeRetiredSystemPrompts').mockResolvedValue({ removed: [] }),
    retiredClips: vi.spyOn(clips, 'removeRetiredSystemClips').mockResolvedValue(),
    retiredFields: vi.spyOn(zipFields, 'removeRetiredZipControlFields').mockResolvedValue({ records: 0, fields: 0 }),
    zipDefaults: vi.spyOn(zipDefaults, 'sweepOldZipDefaults').mockResolvedValue({ status: 'already-complete', records: 0, rows: 0, fields: 0, changed: [] }),
    indexes: vi.spyOn(indexes, 'ensureMemoryIndexes').mockResolvedValue({ status: 'ready', embeddingModel: 'test', dims: 384 }),
    media: vi.spyOn(media, 'ensureMemoryMediaMigration').mockResolvedValue({ status: 'already-complete', records: 0, media: 0, unresolved: 0 }),
    dreaming: vi.spyOn(dreaming, 'startMemoryDreamingScheduler').mockImplementation(() => {}),
    schedules: vi.spyOn(schedule, 'startScheduleTicker').mockImplementation(() => {})
  }
  const hooks = await import('./hooks.server')
  return { mocks, hooks }
}

beforeEach(() => {
  vi.resetModules()
  backup.complete.mockClear()
  backup.fail.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('the actual app startup owner hands original work to automatic backup readiness', () => {
  it('awaits filesystem readiness and explicit command initialization before request/seed/scheduler admission', async () => {
    const { mocks, hooks } = await startup()
    let finishFiles!: (value: { complete: boolean; failed: number }) => void
    let finishCommands!: () => void
    mocks.skills.mockReturnValueOnce(new Promise(resolve => { finishFiles = resolve }))
    mocks.commands.mockReturnValueOnce(new Promise(resolve => { finishCommands = resolve }))
    const resolve = vi.fn(async () => new Response('ready'))
    const url = new URL('http://127.0.0.1:5621/api/health')
    const response = hooks.startupIntegrityHandler({ event: { url, request: new Request(url), locals: {} } as any, resolve })
    await vi.waitFor(() => expect(mocks.skills).toHaveBeenCalledOnce())
    expect(mocks.commands).not.toHaveBeenCalled()
    expect(mocks.fold).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    finishFiles({ complete: true, failed: 0 })
    await vi.waitFor(() => expect(mocks.commands).toHaveBeenCalledOnce())
    expect(mocks.schedules).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    finishCommands()
    expect((await response).status).toBe(200)
    expect(mocks.fold).toHaveBeenCalledOnce()
    expect(mocks.schedules).toHaveBeenCalledOnce()
  })

  it('retains command initialization refusal on subsequent requests without exposing partial startup', async () => {
    const { mocks, hooks } = await startup()
    mocks.commands.mockRejectedValueOnce(new Error('saved plugin access unavailable'))
    const resolve = vi.fn(async () => new Response('should not resolve'))
    const url = new URL('http://127.0.0.1:5621/api/health')
    const event = { url, request: new Request(url), locals: {} } as any
    expect((await hooks.startupIntegrityHandler({ event, resolve })).status).toBe(503)
    expect((await hooks.startupIntegrityHandler({ event, resolve })).status).toBe(503)
    expect(mocks.commands).toHaveBeenCalledOnce()
    expect(mocks.fold).not.toHaveBeenCalled()
    expect(mocks.schedules).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses the hosted app before ordinary initialization and bypasses user startup for registry-only work', async () => {
    const { mocks, hooks } = await startup()
    const { env } = await import('$env/dynamic/private')
    const prior = env.VERCEL
    const enabled = env.BATSHIT_ENABLE_HOSTED_APP
    env.VERCEL = '1'
    delete env.BATSHIT_ENABLE_HOSTED_APP
    try {
      const resolve = vi.fn(async () => new Response('should not resolve'))
      const url = new URL('https://api.batshit.ai/api/health')
      // Kit 3's real sequence executes only inside its request-store owner.
      const { with_request_store } = await import('@sveltejs/kit/internal/server')
      const event = { url, request: new Request(url), locals: {} } as any
      const response = await with_request_store({ event, state: {} } as any, () => hooks.handle({ event, resolve }))
      expect(response.status).toBe(410)
      expect(resolve).not.toHaveBeenCalled()
      await hooks.ensureStartupIntegrityPass()
      expect(mocks.recovery).not.toHaveBeenCalled()
      expect(conversion).not.toHaveBeenCalled()
      expect(mocks.skills).not.toHaveBeenCalled()
      expect(mocks.commands).not.toHaveBeenCalled()
      expect(mocks.schedules).not.toHaveBeenCalled()
      expect(backup.complete).not.toHaveBeenCalled()
    } finally {
      if (prior === undefined) delete env.VERCEL; else env.VERCEL = prior
      if (enabled === undefined) delete env.BATSHIT_ENABLE_HOSTED_APP; else env.BATSHIT_ENABLE_HOSTED_APP = enabled
    }
  })
  it('does not block ordinary startup on pending background migration and preserves its original promise', async () => {
    const { mocks, hooks } = await startup()
    let finish!: (value: []) => void
    const pending = new Promise<[]>((resolve) => { finish = resolve })
    mocks.defaults.mockReturnValueOnce(pending)
    await hooks.ensureStartupIntegrityPass()
    expect(backup.complete).toHaveBeenCalledTimes(1)
    const [work, options] = backup.complete.mock.calls[0] as unknown as [Record<string, Promise<unknown>>, unknown]
    expect(work.promptDefaults).toBe(pending)
    expect(Object.keys(work)).toHaveLength(10)
    expect(options).toEqual({ buildId: 'sveltekit:test', schedulersDisabled: false, guard: expect.any(Object) })
    expect(mocks.dreaming).toHaveBeenCalledTimes(1)
    expect(mocks.schedules).toHaveBeenCalledTimes(1)
    finish([])
    await hooks.ensureStartupIntegrityPass()
    expect(backup.complete).toHaveBeenCalledTimes(1)
  })

  it('passes a rejected original fold promise even though its normal boot logger consumed the rejection', async () => {
    const { mocks, hooks } = await startup()
    const failed = Promise.reject(new Error('fold failed'))
    mocks.fold.mockReturnValueOnce(failed)
    await hooks.ensureStartupIntegrityPass()
    const [work] = backup.complete.mock.calls[0] as unknown as [Record<string, Promise<unknown>>]
    expect(work.zipPrompts).toBe(failed)
    await expect(work.zipPrompts).rejects.toThrow('fold failed')
  })

  it('retains synchronous startup security failure for every subsequent request', async () => {
    const { mocks, hooks } = await startup()
    const encryption = await import('$lib/services/encryption.server')
    vi.spyOn(encryption, 'assertApiKeyEncryptionConfigured').mockImplementation(() => { throw new Error('security admission refused') })
    const resolve = vi.fn(async () => new Response('should not resolve'))
    const url = new URL('http://127.0.0.1:5621/api/health')
    const event = { url, request: new Request(url), locals: {} } as any
    expect((await hooks.startupIntegrityHandler({ event, resolve })).status).toBe(503)
    expect((await hooks.startupIntegrityHandler({ event, resolve })).status).toBe(503)
    expect(resolve).not.toHaveBeenCalled()
    expect(mocks.recovery).not.toHaveBeenCalled()
    expect(conversion).not.toHaveBeenCalled()
    expect(mocks.skills).not.toHaveBeenCalled()
    expect(mocks.schedules).not.toHaveBeenCalled()
  })

  it('blocks requests and scheduler/seed admission when critical tool conversion refuses after recovery', async () => {
    const { mocks, hooks } = await startup()
    conversion.mockRejectedValueOnce(new Error('tool conversion refused'))
    const resolve = vi.fn(async () => new Response('should not resolve'))
    const url = new URL('http://127.0.0.1:5621/api/health')
    const response = await hooks.startupIntegrityHandler({ event: { url, request: new Request(url), locals: {} } as any, resolve })
    expect(response.status).toBe(503)
    expect(mocks.recovery).toHaveBeenCalledOnce()
    expect(conversion).toHaveBeenCalledOnce()
    expect(mocks.skills).not.toHaveBeenCalled()
    expect(mocks.schedules).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(backup.complete).not.toHaveBeenCalled()
  })

  it('reports failed restore recovery through the actual hook without starting readiness or normal schedulers', async () => {
    const { mocks, hooks } = await startup()
    mocks.recovery.mockRejectedValueOnce(new Error('recovery failed'))
    const url = new URL('http://127.0.0.1:5621/api/health')
    const response = await hooks.startupIntegrityHandler({
      event: { url, request: new Request(url), locals: {} } as any,
      resolve: vi.fn(async () => new Response('should not resolve'))
    })
    expect(response.status).toBe(503)
    expect(backup.fail).toHaveBeenCalledWith('sveltekit:test', expect.stringContaining('Startup recovery did not complete'))
    expect(backup.complete).not.toHaveBeenCalled()
    expect(mocks.schedules).not.toHaveBeenCalled()
  })
})
