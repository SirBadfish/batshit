import type { AgentBrowserOperationalSettings, ToolOperationalSettings } from './toolOperationalSettings'
export interface ToolOperationsClientSnapshot {
  revision: string
  values: ToolOperationalSettings
  containerized?: boolean
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const member = (value: unknown, values: readonly string[]) => typeof value === 'string' && values.includes(value)
/** A failed/malformed wire response never becomes a factory/default writable baseline. */
export function parseToolOperationsResponse(input: unknown): ToolOperationsClientSnapshot {
  const group = object(input) ? input.toolOperations : undefined
  if (!object(group) || typeof group.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(group.revision) || !object(group.values)) throw new Error('Saved global tool options could not be read.')
  const value = group.values, browser = value.agentBrowser
  if (!member(value.webSearchProvider, ['duckduckgo-html', 'exa', 'perplexity']) || !member(value.webSearchExaSearchType, ['auto', 'fast', 'neural', 'deep']) ||
      !integer(value.webSearchPerplexityMaxTokensPerPage, 64, 4096) || !object(browser) || typeof browser.liveViewEnabled !== 'boolean' ||
      !member(browser.runtimeMode, ['chromium', 'chrome-cdp']) || !member(browser.provider, ['local', 'browserbase', 'browseruse', 'kernel']) ||
      !integer(browser.cdpPort, 1, 65535) || !integer(browser.timeoutMs, 1000, 120000) || !Array.isArray(browser.extraFlags) || browser.extraFlags.some(item => typeof item !== 'string') ||
      ['executablePath', 'session', 'profilePath'].some(key => browser[key] !== undefined && typeof browser[key] !== 'string')) throw new Error('Saved global tool options were incomplete or malformed.')
  const knownBrowser: AgentBrowserOperationalSettings = {
    liveViewEnabled: browser.liveViewEnabled, runtimeMode: browser.runtimeMode as AgentBrowserOperationalSettings['runtimeMode'],
    provider: browser.provider as AgentBrowserOperationalSettings['provider'], cdpPort: browser.cdpPort as number, timeoutMs: browser.timeoutMs as number,
    extraFlags: [...browser.extraFlags] as string[],
    ...(typeof browser.executablePath === 'string' ? { executablePath: browser.executablePath } : {}),
    ...(typeof browser.session === 'string' ? { session: browser.session } : {}),
    ...(typeof browser.profilePath === 'string' ? { profilePath: browser.profilePath } : {})
  }
  const host = group.host
  if (host !== undefined && (!object(host) || typeof host.containerized !== 'boolean')) throw new Error('Global tool runtime facts were unavailable.')
  return { revision: group.revision, values: {
    webSearchProvider: value.webSearchProvider as ToolOperationalSettings['webSearchProvider'],
    webSearchExaSearchType: value.webSearchExaSearchType as ToolOperationalSettings['webSearchExaSearchType'],
    webSearchPerplexityMaxTokensPerPage: value.webSearchPerplexityMaxTokensPerPage as number, agentBrowser: knownBrowser
  }, ...(object(host) ? { containerized: host.containerized as boolean } : {}) }
}
