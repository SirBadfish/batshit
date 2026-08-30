import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  resolveCodex: vi.fn(),
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
    MANAGED_CLI_RUNTIME_IDS: ['codex', 'claude'],
    ManagedCliOperationInProgressError,
    getManagedCliInstallStatus: mocks.getStatus,
    installManagedCli: mocks.install,
    uninstallManagedCli: mocks.uninstall,
    isManagedCliRuntimeId: (value: unknown) => value === 'codex' || value === 'claude',
  }
})

vi.mock('$lib/server/services/codexCliStatus', () => ({
  resolveCodexCliExecutableDetailed: mocks.resolveCodex,
}))
vi.mock('$lib/server/services/claudeCliStatus', () => ({
  resolveClaudeCliExecutableDetailed: mocks.resolveClaude,
}))
vi.mock('$lib/server/redis', () => ({
  redis: { incr: mocks.incr, expire: mocks.expire, ttl: mocks.ttl },
}))

import { GET, POST } from './+server'
import { ManagedCliOperationInProgressError } from '$lib/server/services/managedCliInstaller'

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
  mocks.resolveCodex.mockReturnValue({ executable: '', source: 'not-found' })
  mocks.resolveClaude.mockReturnValue({ executable: '', source: 'not-found' })
  mocks.incr.mockResolvedValue(1)
  mocks.expire.mockResolvedValue(true)
  mocks.ttl.mockResolvedValue(600)
})

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
      request: request('{"runtime":"codex","operation":"install"}'),
    } as any)
    expect(unauthenticated.status).toBe(401)

    const forbidden = await POST({
      locals: locals(false),
      request: request('{"runtime":"codex","operation":"install"}'),
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
    const installResponse = await POST({
      locals: locals(true),
      request: request('{"runtime":"codex","operation":"install"}'),
    } as any)
    expect(installResponse.status).toBe(200)
    expect(mocks.install).toHaveBeenCalledWith('codex', { force: false })

    const reinstallResponse = await POST({
      locals: locals(true),
      request: request('{"runtime":"codex","operation":"reinstall"}'),
    } as any)
    expect(reinstallResponse.status).toBe(200)
    expect(mocks.install).toHaveBeenLastCalledWith('codex', { force: true })

    mocks.incr.mockResolvedValueOnce(7)
    const limited = await POST({
      locals: locals(true),
      request: request('{"runtime":"claude","operation":"uninstall"}'),
    } as any)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('600')
    expect(mocks.uninstall).not.toHaveBeenCalled()
  })

  it('returns deterministic 409 operation state for a cross-request conflict', async () => {
    mocks.install.mockRejectedValueOnce(
      new ManagedCliOperationInProgressError({
        runtime: 'codex',
        operation: 'reinstall',
        phase: 'downloading',
        startedAt: '2026-08-28T00:00:00.000Z',
      }),
    )
    const response = await POST({
      locals: locals(true),
      request: request('{"runtime":"codex","operation":"install"}'),
    } as any)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'CLI_RUNTIME_OPERATION_IN_PROGRESS',
      operation: { phase: 'downloading' },
    })
  })
})
