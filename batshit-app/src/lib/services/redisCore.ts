// Core Redis utilities and base operations
// Provides common functionality for all Redis-based stores

function parseJsonBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return null
  }
}

function readableFailure(status: number, rawBody: string, payload: unknown): string {
  const unreadable = `Request failed (HTTP ${status})`
  if (typeof payload === 'string') return payload.trim() || unreadable
  if (payload !== null && typeof payload === 'object') {
    // `error` is how Batshit's routes answer; `message` is SvelteKit's own error shape.
    const { error, message } = payload as { error?: unknown; message?: unknown }
    for (const sentence of [error, message]) {
      if (typeof sentence === 'string' && sentence.trim()) return sentence.trim()
    }
    return unreadable
  }
  if (payload !== null) return unreadable
  return rawBody.trim() || unreadable
}

/**
 * A failed `apiCall` (bug sweep #3, 2026-09-18). `message` is what the server said: a JSON
 * answer's `error` sentence (or its `message`), a plain-text answer as it came, and
 * `Request failed (HTTP <status>)` when the answer holds no sentence. Never the raw JSON: the
 * message used to be `API error: <raw body>`, so the sidebar's delete toast read
 * `Failed to delete session: API error: {"error":…,"code":…}`. The answer stays on the error
 * for code that needs more than the sentence: `status`, `rawBody`, and `payload` (the parsed
 * JSON body, null when the body is not JSON).
 */
export class ApiCallError extends Error {
  readonly status: number
  readonly rawBody: string
  readonly payload: unknown

  constructor(status: number, rawBody: string) {
    const payload = parseJsonBody(rawBody)
    super(readableFailure(status, rawBody, payload))
    this.name = 'ApiCallError'
    this.status = status
    this.rawBody = rawBody
    this.payload = payload
  }
}

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
      throw new ApiCallError(response.status, await response.text())
    }

    return response.json()
  }
}
