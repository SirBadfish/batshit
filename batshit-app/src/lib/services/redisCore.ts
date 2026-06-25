// Core Redis utilities and base operations
// Provides common functionality for all Redis-based stores

/**
 * Base class for Redis store operations
 * Provides common API call functionality
 */
export class RedisStoreBase {
  protected apiUrl = '/api'
  protected fetcher: typeof fetch | null = null

  /**
   * Allow server routes to inject the correct fetch (e.g. event.fetch) and optional base URL.
   */
  configureApi(fetcher: typeof fetch, apiUrl?: string) {
    this.fetcher = fetcher
    if (apiUrl) {
      this.apiUrl = apiUrl
    }
  }

  private resolveFetch(custom?: typeof fetch) {
    if (custom) return custom
    if (this.fetcher) return this.fetcher
    if (typeof fetch === 'function') return fetch
    throw new Error('Fetch API is not available in this environment')
  }

  /**
   * Helper method for API calls
   */
  protected async apiCall(endpoint: string, options: RequestInit = {}) {
    const isServer = typeof window === 'undefined'
    const response = await this.resolveFetch((options as any).fetcher)(`${this.apiUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(isServer ? { 'x-internal-api-request': '1' } : {}),
        ...options.headers
      }
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`API error: ${error}`)
    }

    return response.json()
  }
}
