import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setAgentBrowserCliTestSpawner,
  __setAgentBrowserTestShell,
  assertAgentBrowserTestShell,
  spawnAgentBrowserCliProcess,
  type AgentBrowserCliChild,
  type AgentBrowserCliSpawnOptions
} from '../agentBrowserCliProcess'

const nativeSpawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: nativeSpawn, default: { ...actual, spawn: nativeSpawn } }
})

const options: AgentBrowserCliSpawnOptions = { cwd: '/owned-fixture', env: {}, stdio: ['ignore', 'pipe', 'pipe'] }

beforeEach(() => {
  vi.stubEnv('VITEST', 'true')
  nativeSpawn.mockReset().mockImplementation(() => { throw new Error('A real spawn must stay intercepted in this suite.') })
  __setAgentBrowserCliTestSpawner(null)
  __setAgentBrowserTestShell(null)
})

afterEach(() => {
  // One case simulates normal execution; restore the test lane before disposing its seam.
  vi.stubEnv('VITEST', 'true')
  __setAgentBrowserCliTestSpawner(null)
  __setAgentBrowserTestShell(null)
  vi.unstubAllEnvs()
})

describe('BL-2340 default Vitest native Agent Browser admission', () => {
  it.each(['agent-browser', '/opt/homebrew/bin/agent-browser', '/missing/fake-agent-browser'])(
    'refuses %s before any native spawn when no owned fixture is registered',
    command => {
      expect(() => spawnAgentBrowserCliProcess(command, ['open', 'https://example.com'], options))
        .toThrow(/Vitest refuses native Agent Browser execution/)
      expect(nativeSpawn).not.toHaveBeenCalled()
    }
  )

  it('a broken owned fixture cannot authorize the discovery fallback', () => {
    const fixture = '/owned-fixture/agent-browser'
    const fixtureSpawn = vi.fn((command: string) => {
      if (command !== fixture) throw new Error('Not the exact owned fixture.')
      throw Object.assign(new Error('The fake executable is missing or malformed.'), { code: 'ENOENT' })
    })
    __setAgentBrowserCliTestSpawner(fixtureSpawn)

    expect(() => spawnAgentBrowserCliProcess(fixture, ['--version'], options)).toThrow(/missing or malformed/)
    expect(() => spawnAgentBrowserCliProcess('agent-browser', ['--version'], options)).toThrow(/exact owned fixture/)
    expect(nativeSpawn).not.toHaveBeenCalled()
  })

  it('hands unchanged runner arguments and environment to the exact fixture callback', () => {
    const child = {} as AgentBrowserCliChild
    const fixtureSpawn = vi.fn((command: string) => {
      if (command !== '/owned-fixture/agent-browser') throw new Error('Not the exact owned fixture.')
      return child
    })
    __setAgentBrowserCliTestSpawner(fixtureSpawn)

    expect(spawnAgentBrowserCliProcess('/owned-fixture/agent-browser', ['--version'], options)).toBe(child)
    expect(fixtureSpawn).toHaveBeenCalledExactlyOnceWith('/owned-fixture/agent-browser', ['--version'], options)
    expect(nativeSpawn).not.toHaveBeenCalled()
  })

  it('normal execution keeps the native spawn and cannot register a test override', () => {
    vi.stubEnv('VITEST', 'false')
    const child = {} as AgentBrowserCliChild
    nativeSpawn.mockReturnValue(child)

    expect(() => __setAgentBrowserCliTestSpawner(() => child)).toThrow(/only under Vitest/)
    expect(() => __setAgentBrowserTestShell('/owned-fixture/browser-test-shell')).toThrow(/only under Vitest/)
    expect(() => assertAgentBrowserTestShell('/bin/zsh')).not.toThrow()
    expect(spawnAgentBrowserCliProcess('agent-browser', ['--version'], options)).toBe(child)
    expect(nativeSpawn).toHaveBeenCalledExactlyOnceWith('agent-browser', ['--version'], options)
  })

  it('refuses an ordinary shell and a replaced fixture shell before browser Bash can run', () => {
    expect(() => assertAgentBrowserTestShell('/bin/zsh')).toThrow(/exact test-owned shell fixture/)
    __setAgentBrowserTestShell('/owned-fixture/browser-test-shell')
    expect(() => assertAgentBrowserTestShell('/bin/zsh')).toThrow(/exact test-owned shell fixture/)
    expect(() => assertAgentBrowserTestShell('/different-fixture/browser-test-shell')).toThrow(/exact test-owned shell fixture/)
    expect(() => assertAgentBrowserTestShell('/owned-fixture/browser-test-shell')).not.toThrow()
    expect(nativeSpawn).not.toHaveBeenCalled()
  })
})
