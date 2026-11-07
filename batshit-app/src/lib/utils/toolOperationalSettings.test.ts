import { describe, expect, it } from 'vitest'
import { resolveToolOperationalSettings as resolve, validateAgentBrowserOperationalPatch as validate } from './toolOperationalSettings'
describe('global operational tool choices', () => {
  it('uses the existing factory Web and Agent Browser defaults without reading per-agent grants', () => {
    expect(resolve(null)).toEqual({ webSearchProvider: 'duckduckgo-html', webSearchExaSearchType: 'auto',
      webSearchPerplexityMaxTokensPerPage: 1024, agentBrowser: { liveViewEnabled: true, runtimeMode: 'chromium', provider: 'local', cdpPort: 9222, timeoutMs: 45000, extraFlags: [] } })
    expect(resolve({ provider_specific_settings: { nativeTools: { webSearchProvider: 'exa', agentBrowserProvider: 'kernel', bashEnabled: false } } })).toEqual(resolve(null))
  })
  it('preserves valid saved global Web preferences including legacy global aliases', () => {
    expect(resolve({ admin_settings: { webSearchDefaultProvider: 'exa', webSearchExaType: 'neural', webSearchPerplexityMaxTokensPerPage: 2500 } }))
      .toMatchObject({ webSearchProvider: 'exa', webSearchExaSearchType: 'neural', webSearchPerplexityMaxTokensPerPage: 2500 })
  })
  it('resolves one finite Browser group and keeps explicit false while normalizing supported values', () => {
    const source = { admin_settings: { agent_browser: { liveViewEnabled: false, runtimeMode: 'cdp', provider: 'browser-use', cdpPort: '9300', timeoutMs: 8000,
      executablePath: ' /owned/chrome ', session: 'work', profilePath: '/owned/profile', extraFlags: ['--first', '--first', '--second'] } } }
    expect(resolve(source).agentBrowser).toEqual({ liveViewEnabled: false, runtimeMode: 'chrome-cdp', provider: 'browseruse', cdpPort: 9300, timeoutMs: 8000,
      executablePath: '/owned/chrome', session: 'work', profilePath: '/owned/profile', extraFlags: ['--first', '--second'] })
    expect(source.admin_settings.agent_browser.executablePath).toBe(' /owned/chrome ')
  })
  it('bounds runtime numbers by the existing limits and refuses malformed source containers', () => {
    expect(resolve({ admin_settings: { agent_browser: { timeoutMs: 1, cdpPort: 99999 } } }).agentBrowser).toMatchObject({ timeoutMs: 1000, cdpPort: 65535 })
    expect(() => resolve({ admin_settings: [] })).toThrow(/unavailable/)
    expect(() => resolve({ admin_settings: { agent_browser: 'bad' } })).toThrow(/unavailable/)
  })
  it('validates only finite editable leaves, retaining optional clear and real execution gates elsewhere', () => {
    expect(validate({ liveViewEnabled: false, runtimeMode: 'chrome-cdp', provider: 'local', executablePath: null, extraFlags: [] })).toBeNull()
    for (const value of [{ token: 'no' }, { enabled: true }, { timeoutMs: 10 }, { cdpPort: 1.5 }, { extraFlags: [1] }, { provider: 'unknown' }, { provider: ['browserbase'] }, { runtimeMode: ['chrome-cdp'] }]) expect(validate(value)).toBeTypeOf('string')
  })
})
