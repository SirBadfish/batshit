// Zip API operations for Batshit message rendering and compilation.

import { httpClient } from './apiClient'

export interface ZipData {
  id: string
  content: string
  type: string
  tokens: number
  description?: string
  sessionId: string
  messageId: string
  metadata?: any
}

export class UploadApiService {
  /**
   * Create a new zip in Redis
   */
  async createZip(zipData: ZipData, fetcher?: typeof fetch) {
    try {
      return await httpClient.post('/api/zips', {
        id: zipData.id,
        content: zipData.content,
        type: zipData.type,
        tokens: zipData.tokens,
        description: zipData.description || '',
        sessionId: zipData.sessionId,
        messageId: zipData.messageId,
        metadata: {
          source: 'ai',
          ...(zipData.metadata || {})
        }
      }, fetcher)
    } catch (error) {
      console.error('[UploadAPI] Create zip error:', error)
      throw error
    }
  }

  /**
   * Get a zip by ID from Redis
   */
  async getZip(zipId: string, fetcher?: typeof fetch) {
    const fetchImpl = fetcher
      ?? (typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : fetch)
    const isServer = typeof window === 'undefined'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (isServer) {
      headers['x-internal-api-request'] = '1'
    }

    const response = await fetchImpl(`/api/zips/${zipId}`, {
      method: 'GET',
      headers,
      credentials: 'include'
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || `Request failed: ${response.status}`)
    }

    const data = await response.json()
    return {
      id: data.id,
      content: data.content,
      type: data.type || 'text',
      tokens: data.tokens || 0,
      description: data.description || '',
      name: data.metadata?.name || '',
      metadata: data.metadata || {}
    }
  }

  /**
   * Get multiple zips (batch fetch from Redis)
   */
  async getZips(zipIds: string[], fetcher?: typeof fetch) {
    if (zipIds.length === 0) {
      return new Map()
    }

    try {
      const data = await httpClient.get<Record<string, any>>(
        `/api/zips?ids=${zipIds.join(',')}`,
        fetcher
      )
      const results = new Map()

      // Convert object response to Map
      for (const [id, zipData] of Object.entries(data)) {
        if (zipData && typeof zipData === 'object') {
          const zip = zipData as any
          results.set(id, {
            id: zip.id,
            content: zip.content,
            type: zip.type || 'text',
            tokens: zip.tokens || 0,
            description: zip.description || '',
            name: zip.metadata?.name || '',
            metadata: zip.metadata || {}
          })
        }
      }

      return results
    } catch (error) {
      console.error('[UploadAPI] Get zips error:', error)
      throw error
    }
  }
}

// Export singleton instance
export const uploadApiService = new UploadApiService()
