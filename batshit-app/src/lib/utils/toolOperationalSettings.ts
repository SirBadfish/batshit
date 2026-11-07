/** Global operational choices only. Per-agent enable/host/Bash grants are separate owners. */
export type GlobalWebSearchProvider = 'duckduckgo-html' | 'exa' | 'perplexity'
export type GlobalExaSearchType = 'auto' | 'fast' | 'neural' | 'deep'
export interface AgentBrowserOperationalSettings {
  liveViewEnabled: boolean
  runtimeMode: 'chromium' | 'chrome-cdp'
  provider: 'local' | 'browserbase' | 'browseruse' | 'kernel'
  cdpPort: number
  timeoutMs: number
  executablePath?: string
  session?: string
  profilePath?: string
  extraFlags: string[]
}
export interface ToolOperationalSettings {
  webSearchProvider: GlobalWebSearchProvider
  webSearchExaSearchType: GlobalExaSearchType
  webSearchPerplexityMaxTokensPerPage: number
  agentBrowser: AgentBrowserOperationalSettings
}
export const AGENT_BROWSER_OPERATIONAL_FIELDS = Object.freeze([
  'liveViewEnabled', 'runtimeMode', 'provider', 'cdpPort', 'timeoutMs',
  'executablePath', 'session', 'profilePath', 'extraFlags'
] as const)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const integer = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const bool = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  const normalized = text(value)?.toLowerCase()
  if (normalized && ['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (normalized && ['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
  return undefined
}
const webProviders: Record<string, GlobalWebSearchProvider> = { ddg: 'duckduckgo-html', duckduckgo: 'duckduckgo-html', 'duckduckgo-html': 'duckduckgo-html', exa: 'exa', perplexity: 'perplexity' }
const runtimes: Record<string, AgentBrowserOperationalSettings['runtimeMode']> = { chromium: 'chromium', 'separate-chromium': 'chromium', separate_chromium: 'chromium', 'chrome-cdp': 'chrome-cdp', chrome_cdp: 'chrome-cdp', cdp: 'chrome-cdp', chrome: 'chrome-cdp' }
const providers: Record<string, AgentBrowserOperationalSettings['provider']> = { local: 'local', browserbase: 'browserbase', browseruse: 'browseruse', browser_use: 'browseruse', 'browser-use': 'browseruse', kernel: 'kernel' }
const lookup = <T>(values: Record<string, T>, value: unknown): T | undefined => { const key = text(value)?.toLowerCase() ?? ''; return Object.hasOwn(values, key) ? values[key] : undefined }
const flags = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [])
  .filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))]

/** Receives a successfully read settings snapshot; callers must not turn read errors into null. */
export function resolveToolOperationalSettings(userSettings: unknown): ToolOperationalSettings {
  if (userSettings !== undefined && userSettings !== null && !object(userSettings)) throw new Error('Global tool settings are unavailable.')
  const source = (userSettings ?? {}) as Record<string, unknown>
  const rawAdmin = source.admin_settings
  if (rawAdmin !== undefined && rawAdmin !== null && !object(rawAdmin)) throw new Error('Global tool settings are unavailable.')
  const admin = (rawAdmin ?? {}) as Record<string, unknown>
  const rawBrowser = admin.agent_browser
  if (rawBrowser !== undefined && rawBrowser !== null && !object(rawBrowser)) throw new Error('Global Agent Browser settings are unavailable.')
  const browser = (rawBrowser ?? {}) as Record<string, unknown>
  const exa = text(admin.web_search_exa_type ?? admin.webSearchExaType)?.toLowerCase()
  return {
    webSearchProvider: lookup(webProviders, admin.web_search_default_provider ?? admin.webSearchDefaultProvider) ?? 'duckduckgo-html',
    webSearchExaSearchType: exa && ['auto', 'fast', 'neural', 'deep'].includes(exa) ? exa as GlobalExaSearchType : 'auto',
    webSearchPerplexityMaxTokensPerPage: clamp(integer(admin.web_search_perplexity_max_tokens_per_page ?? admin.webSearchPerplexityMaxTokensPerPage) ?? 1024, 64, 4096),
    agentBrowser: {
      liveViewEnabled: bool(browser.liveViewEnabled) ?? true,
      runtimeMode: lookup(runtimes, browser.runtimeMode) ?? 'chromium',
      provider: lookup(providers, browser.provider) ?? 'local',
      cdpPort: clamp(integer(browser.cdpPort) ?? 9222, 1, 65535),
      timeoutMs: clamp(integer(browser.timeoutMs) ?? 45000, 1000, 120000),
      ...(text(browser.executablePath) ? { executablePath: text(browser.executablePath) } : {}),
      ...(text(browser.session) ? { session: text(browser.session) } : {}),
      ...(text(browser.profilePath) ? { profilePath: text(browser.profilePath) } : {}),
      extraFlags: flags(browser.extraFlags)
    }
  }
}

/** Finite human-save patch validation; unknown stored siblings remain outside the patch. */
export function validateAgentBrowserOperationalPatch(value: unknown): string | null {
  if (!object(value)) return 'Agent Browser settings must be an object.'
  for (const [key, field] of Object.entries(value)) {
    if (!(AGENT_BROWSER_OPERATIONAL_FIELDS as readonly string[]).includes(key)) return `Unknown Agent Browser setting: ${key}.`
    if (key === 'liveViewEnabled' && typeof field !== 'boolean') return 'Live view must be on or off.'
    if (key === 'runtimeMode' && (typeof field !== 'string' || !['chromium', 'chrome-cdp'].includes(field))) return 'Choose Chromium or Chrome CDP.'
    if (key === 'provider' && (typeof field !== 'string' || !['local', 'browserbase', 'browseruse', 'kernel'].includes(field))) return 'Choose a supported Agent Browser provider.'
    if (key === 'cdpPort' && (typeof field !== 'number' || !Number.isInteger(field) || field < 1 || field > 65535)) return 'CDP port must be an integer from 1 to 65535.'
    if (key === 'timeoutMs' && (typeof field !== 'number' || !Number.isInteger(field) || field < 1000 || field > 120000)) return 'Timeout must be 1000 to 120000 ms.'
    if (['executablePath', 'session', 'profilePath'].includes(key) && field !== null && typeof field !== 'string') return `${key} must be text or null.`
    if (key === 'extraFlags' && (!Array.isArray(field) || field.some(item => typeof item !== 'string'))) return 'Extra flags must be a list of text values.'
  }
  return null
}
