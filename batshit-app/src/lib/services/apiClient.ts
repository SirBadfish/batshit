// Core HTTP client utilities for batshit
// This module provides base HTTP request/response handling
import { env as publicEnv } from '$env/dynamic/public'

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

export const BATSHIT_SERVER_URL = trimTrailingSlash(
  publicEnv.PUBLIC_BATSHIT_SERVER_URL || 'http://localhost:5600'
)
export const BATSHIT_SERVER_API_URL = trimTrailingSlash(
  publicEnv.PUBLIC_BATSHIT_SERVER_API_URL || `${BATSHIT_SERVER_URL}/api/v1`
)
export const BATSHIT_SERVER_TASK_URL = `${BATSHIT_SERVER_API_URL}/task/s`

/**
 * Base HTTP client for API communication
 * Provides common request/response handling patterns
 */
export class HttpClient {
  constructor(private baseUrl: string = '') {}

  private resolveFetch(fetcher?: typeof fetch) {
    if (fetcher) return fetcher
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
      return window.fetch.bind(window)
    }
    if (typeof fetch === 'function') {
      return fetch
    }
    throw new Error('Fetch API is not available')
  }

  /**
   * Generic fetch wrapper with error handling
   */
  async fetch<T>(url: string, options: RequestInit = {}, fetcher?: typeof fetch): Promise<T> {
    const fullUrl = this.baseUrl ? `${this.baseUrl}${url}` : url
    const fetchImpl = this.resolveFetch(fetcher)
    const isServer = typeof window === 'undefined'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (options.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          headers[key] = value
        })
      } else if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) {
          headers[key] = value
        }
      } else {
        Object.assign(headers, options.headers as Record<string, string>)
      }
    }

    if (isServer && !headers['x-internal-api-request']) {
      headers['x-internal-api-request'] = '1'
    }

    try {
      const response = await fetchImpl(fullUrl, {
        ...options,
        headers
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || `Request failed: ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      console.error(`[HttpClient] Request error for ${url}:`, error)
      throw error
    }
  }

  /**
   * POST request helper
   */
  async post<T>(url: string, data?: any, fetcher?: typeof fetch): Promise<T> {
    return this.fetch<T>(url, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined
    }, fetcher)
  }

  /**
   * GET request helper
   */
  async get<T>(url: string, fetcher?: typeof fetch): Promise<T> {
    return this.fetch<T>(url, {
      method: 'GET'
    }, fetcher)
  }

}

// Export a default client instance for general use
export const httpClient = new HttpClient()
