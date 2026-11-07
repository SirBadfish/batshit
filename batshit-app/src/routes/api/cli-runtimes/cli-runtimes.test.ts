import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  resolveClaude: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
}))

vi.mock('$lib/server/services/managedCliInstaller', () => {
  class ManagedCliOperationInProgressError extends Error {
    code = 'CLI_RUNTIME_OPERATION_IN_PROGRESS'
    constructor(readonly operationStatus: any) {
      super('CLI operation already in progress.')
    }
  }
  return {
    MANAGED_CLI_RUNTIME_IDS: ['claude'],
    ManagedCliOperationInProgressError,
    getManagedCliInstallStatus: mocks.getStatus,
    installManagedCli: mocks.install,
    uninstallManagedCli: mocks.uninstall,
    isManagedCliRuntimeId: (value: unknown) => value === 'claude',
  }
})

vi.mock('$lib/server/services/claudeCliStatus', () => ({
  resolveClaudeCliExecutableDetailed: mocks.resolveClaude,
}))
vi.mock('$lib/server/redis', () => ({
  redis: { incr: mocks.incr, expire: mocks.expire, ttl: mocks.ttl },
}))

import { GET, POST } from './+server'
import { ManagedCliOperationInProgressError } from '$lib/server/services/managedCliInstaller'
import { claudeCodeChangeCount } from '$lib/server/services/claudeCodeChanges'

const status = {
  installed: false,
  version: null,
  pinnedVersion: '1.0.0',
  executablePath: null,
  supported: true,
  unsupportedReason: null,
  displayName: 'CLI',
  operation: null,
}

function locals(admin: boolean | null) {
  return admin === null ? {} : { user: { id: admin ? 'admin-1' : 'user-1', is_admin: admin } }
}

function request(body: string, contentType = 'application/json', extraHeaders: HeadersInit = {}) {
  return new Request('http://localhost/api/cli-runtimes', {
    method: 'POST',
    headers: { 'content-type': contentType, ...extraHeaders },
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getStatus.mockResolvedValue(status)
  mocks.resolveClaude.mockReturnValue({ executable: '', source: 'not-found' })
  mocks.incr.mockResolvedValue(1)
  mocks.expire.mockResolvedValue(true)
  mocks.ttl.mockResolvedValue(600)
})
afterEach(() => { vi.unstubAllEnvs() })

describe('/api/cli-runtimes', () => {
  it('keeps status readable by authenticated users and exposes admin capability', async () => {
    const userResponse = await GET({ locals: locals(false) } as any)
    expect(userResponse.status).toBe(200)
    await expect(userResponse.json()).resolves.toMatchObject({ canManage: false })

    const adminResponse = await GET({ locals: locals(true) } as any)
    await expect(adminResponse.json()).resolves.toMatchObject({ canManage: true })
  })

  it('rejects unauthenticated and non-admin mutations before invoking the installer', async () => {
    const unauthenticated = await POST({
      locals: locals(null),
      request: request('{"runtime":"claude","operation":"install"}'),
    } as any)
    expect(unauthenticated.status).toBe(401)

    const forbidden = await POST({
      locals: locals(false),
      request: request('{"runtime":"claude","operation":"install"}'),
    } as any)
    expect(forbidden.status).toBe(403)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('requires JSON and rejects declared or streamed oversized bodies', async () => {
    const wrongType = await POST({
      locals: locals(true),
      request: request('{}', 'text/plain'),
    } as any)
    expect(wrongType.status).toBe(415)

    const declaredOversize = await POST({
      locals: locals(true),
      request: request('{}', 'application/json', { 'content-length': '2048' }),
    } as any)
    expect(declaredOversize.status).toBe(413)

    const streamedOversize = await POST({
      locals: locals(true),
      request: request(JSON.stringify({ padding: 'x'.repeat(2048) })),
    } as any)
    expect(streamedOversize.status).toBe(413)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('makes install idempotent, keeps reinstall explicit, and rate-limits mutations', async () => {
    const changesAtStart = claudeCodeChangeCount()
    const installResponse = await POST({
      locals: locals(true),
      request: request('{"runtime":"claude","operation":"install"}'),
    } as any)
    expect(installResponse.status).toBe(200)
    expect(mocks.install).toHaveBeenCalledWith('claude', { force: false })

    const reinstallResponse = await POST({
      locals: locals(true),
      request: request('{"runtime":"claude","operation":"reinstall"}'),
    } as any)
    expect(reinstallResponse.status).toBe(200)
    expect(mocks.install).toHaveBeenLastCalledWith('claude', { force: true })

    mocks.incr.mockResolvedValueOnce(7)
    const limited = await POST({
      locals: locals(true),
      request: request('{"runtime":"claude","operation":"uninstall"}'),
    } as any)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('600')
    expect(mocks.uninstall).not.toHaveBeenCalled()

    // SA-139: only a Claude Code change, even a failed one, makes the Claude plan's shared status read look again:
    // the install and the reinstall above counted; the rate-limited request did not run, so it did not.
    const before = claudeCodeChangeCount()
    expect(before).toBe(changesAtStart + 2)
    expect((await POST({ locals: locals(true), request: request('{"runtime":"claude","operation":"install"}') } as any)).status).toBe(200)
    expect(claudeCodeChangeCount()).toBe(before + 1)
    mocks.uninstall.mockRejectedValueOnce(new Error('uninstall failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await POST({ locals: locals(true), request: request('{"runtime":"claude","operation":"uninstall"}') } as any)).status).toBe(500)
    expect(claudeCodeChangeCount()).toBe(before + 2)
  })

  // SA-139 R1: Codex CLI was removed; no install, reinstall or uninstall of it runs.
  it.each(['install', 'reinstall', 'uninstall'])('refuses a Codex CLI %s with 409 codex_cli_retired and runs nothing', async operation => {
    const changesAtStart = claudeCodeChangeCount()
    const response = await POST({
      locals: locals(true),
      request: request(JSON.stringify({ runtime: 'codex', operation })),
    } as any)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'codex_cli_retired', error: 'Codex CLI agents were removed from Batshit.' })
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.uninstall).not.toHaveBeenCalled()
    expect(mocks.incr).not.toHaveBeenCalled()
    // Not a Claude Code change: the Claude plan's shared status read does not look again.
    expect(claudeCodeChangeCount()).toBe(changesAtStart)
  })

  it('returns deterministic 409 operation state for a cross-request conflict', async () => {
    mocks.install.mockRejectedValueOnce(
      new ManagedCliOperationInProgressError({
        runtime: 'claude',
        operation: 'reinstall',
        phase: 'downloading',
        startedAt: '2026-08-28T00:00:00.000Z',
      }),
    )
    const response = await POST({
      locals: locals(true),
      request: request('{"runtime":"claude","operation":"install"}'),
    } as any)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'CLI_RUNTIME_OPERATION_IN_PROGRESS',
      operation: { phase: 'downloading' },
    })
  })

  // BL-268: the found CLI's own version, and whether it is older than the version Batshit
  // installs, so Agent Settings can say that newer models may be refused.
  it('reports the found CLI version and whether it is older than the pinned one', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zccli-bl268-'))
    try {
      const claude = path.join(dir, 'claude')
      await writeFile(claude, '#!/bin/sh\necho "2.1.280 (Claude Code)"\n')
      await chmod(claude, 0o755)
      mocks.resolveClaude.mockReturnValue({ executable: claude, source: 'well-known' })

      mocks.getStatus.mockResolvedValue({ ...status, pinnedVersion: '2.1.185' })
      const current = await (await GET({ locals: locals(false) } as any)).json()
      // Only the Claude CLI is listed: Codex CLI was removed (SA-139 R1).
      expect(Object.keys(current.runtimes)).toEqual(['claude'])
      expect(current.runtimes.claude.resolution).toMatchObject({
        version: '2.1.280 (Claude Code)',
        olderThanPinned: false
      })

      mocks.getStatus.mockResolvedValue({ ...status, pinnedVersion: '2.1.300' })
      const older = await (await GET({ locals: locals(false) } as any)).json()
      expect(older.runtimes.claude.resolution).toMatchObject({
        version: '2.1.280 (Claude Code)',
        olderThanPinned: true
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

