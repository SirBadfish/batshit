import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { nativeToolService } from '../nativeTools'
import { __setAgentBrowserCliTestSpawner, __setAgentBrowserTestShell } from '../agentBrowserCliProcess'
import { resolveToolOperationalSettings } from '$lib/utils/toolOperationalSettings'

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  resolveShell: vi.fn(),
  starts: {
    spawn: vi.fn(), spawnSync: vi.fn(), fork: vi.fn(), exec: vi.fn(), execSync: vi.fn(),
    execFile: vi.fn(), execFileSync: vi.fn(), owned: vi.fn()
  }
}))

// These negatives execute the actual service entrypoints. Every process door is intercepted,
// so removing either guard produces a safe assertion failure, never a browser or guardian.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { owned: _, ...starts } = mocks.starts
  return { ...actual, ...starts, default: { ...actual, ...starts } }
})
vi.mock('../ownedCommandGroup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ownedCommandGroup')>()),
  spawnOwnedCommandGroup: mocks.starts.owned
}))
vi.mock('../localCommandShell', () => ({ resolveLocalCommandShell: mocks.resolveShell }))
vi.mock('$lib/server/toolOperationalSettingsOwner', () => ({ readToolOperationalSettings: mocks.readSettings }))

let workspace: string | null = null

beforeEach(() => {
  vi.stubEnv('VITEST', 'true')
  vi.stubEnv('BATSHIT_AGENT_BROWSER_BIN', undefined)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '0')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', 'native')
  __setAgentBrowserCliTestSpawner(null)
  __setAgentBrowserTestShell(null)
  nativeToolService.__setAgentBrowserCliRunnerForTests(null)
  mocks.readSettings.mockReset().mockResolvedValue(resolveToolOperationalSettings(null))
  mocks.resolveShell.mockReset().mockResolvedValue('/bin/zsh')
  for (const start of Object.values(mocks.starts)) {
    start.mockReset().mockImplementation(() => { throw new Error('Process start intercepted by browser-isolation negative.') })
  }
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in browser-isolation negatives.') }))
})

afterEach(async () => {
  __setAgentBrowserCliTestSpawner(null)
  __setAgentBrowserTestShell(null)
  nativeToolService.__setAgentBrowserCliRunnerForTests(null)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (workspace) await rm(workspace, { recursive: true, force: true })
  workspace = null
})

function expectNoProcessStart() {
  for (const start of Object.values(mocks.starts)) expect(start).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
}

async function callOperationalBoundary(boundary: 'web' | 'browser' | 'browser-bash', signal: AbortSignal) {
  if (boundary === 'web') return nativeToolService.nativeWebSearch({
    userId: 'browser-isolation-test', query: 'stopped fixture', provider: 'duckduckgo-html', abortSignal: signal
  })
  if (boundary === 'browser') return nativeToolService.nativeAgentBrowserUse({
    userId: 'browser-isolation-test', toolName: 'open', params: { url: 'https://example.com' }, abortSignal: signal
  })
  workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-ab-isolation-negative-'))
  return nativeToolService.nativeBashExecute({
    userId: 'browser-isolation-test', command: 'agent-browser open https://example.com',
    workspaceRoot: workspace, cwd: workspace, backend: 'local', accessMode: 'dangerous',
    requireApproval: false, agentBrowserSettings: { enabled: true }, abortSignal: signal
  })
}

describe('BL-2340 the actual native browser entrypoints refuse unowned test execution', () => {
  it.each([undefined, '/missing/owned-agent-browser'])(
    'direct browser discovery refuses a missing fixture (%s), including its PATH fallback',
    async configured => {
      vi.stubEnv('BATSHIT_AGENT_BROWSER_BIN', configured)
      const result = await nativeToolService.nativeAgentBrowserUse({
        userId: 'browser-isolation-test', toolName: 'open', params: { url: 'https://example.com' }
      })

      expect(result).toMatchObject({ success: false })
      expect(result.error).toMatch(/Vitest refuses native Agent Browser execution/)
      expectNoProcessStart()
    }
  )

  it.each([
    { admittedShell: null, agentBrowserSettings: undefined, label: 'no shell, absent Browser settings' },
    { admittedShell: null, agentBrowserSettings: { enabled: false }, label: 'no shell, disabled Browser defaults' },
    { admittedShell: null, agentBrowserSettings: { enabled: true }, label: 'no shell, enabled Browser defaults' },
    { admittedShell: '/different-fixture/browser-test-shell', agentBrowserSettings: undefined, label: 'replaced shell, absent Browser settings' },
    { admittedShell: '/different-fixture/browser-test-shell', agentBrowserSettings: { enabled: false }, label: 'replaced shell, disabled Browser defaults' },
    { admittedShell: '/different-fixture/browser-test-shell', agentBrowserSettings: { enabled: true }, label: 'replaced shell, enabled Browser defaults' }
  ])(
    'recognized local browser Bash refuses $label',
    async ({ admittedShell, agentBrowserSettings }) => {
      workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-ab-isolation-negative-'))
      __setAgentBrowserTestShell(admittedShell)
      const result = await nativeToolService.nativeBashExecute({
        userId: 'browser-isolation-test', command: 'agent-browser open https://example.com',
        workspaceRoot: workspace, cwd: workspace, backend: 'local', accessMode: 'dangerous',
        requireApproval: false, agentBrowserSettings
      })

      expect(result).toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE' })
      expect(result.reason).toMatch(/Vitest refuses Agent Browser Bash without the exact test-owned shell fixture/)
      expectNoProcessStart()
    }
  )
})

describe('Stop while the strict operational owner is pending', () => {
  it.each(['web', 'browser', 'browser-bash'] as const)('%s keeps its stopped result after a successful read', async boundary => {
    let release!: (value: ReturnType<typeof resolveToolOperationalSettings>) => void
    const read = new Promise<ReturnType<typeof resolveToolOperationalSettings>>(resolve => { release = resolve })
    mocks.readSettings.mockReturnValueOnce(read)
    const stop = new AbortController()
    const call = callOperationalBoundary(boundary, stop.signal)
    await vi.waitFor(() => expect(mocks.readSettings).toHaveBeenCalledOnce())
    stop.abort('user')
    release(resolveToolOperationalSettings(null))

    const result = await call
    expect(result).toMatchObject({ success: false, stopped: true })
    if (boundary === 'web') expect(result.error).toBe('Search stopped.')
    else expect(result.reason).toBe('The command was stopped.')
    expectNoProcessStart()
  })

  it.each(['web', 'browser', 'browser-bash'] as const)('%s preserves a rejected read when Stop arrives during it', async boundary => {
    let refuse!: (reason: Error) => void
    const read = new Promise<never>((_, reject) => { refuse = reject })
    mocks.readSettings.mockReturnValueOnce(read)
    const stop = new AbortController()
    const call = callOperationalBoundary(boundary, stop.signal)
    await vi.waitFor(() => expect(mocks.readSettings).toHaveBeenCalledOnce())
    stop.abort('user')
    refuse(new Error('Strict operational fixture read failed.'))

    await expect(call).rejects.toThrow('Strict operational fixture read failed.')
    expectNoProcessStart()
  })
})
