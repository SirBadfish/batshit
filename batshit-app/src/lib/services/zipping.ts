// Zipping service - Uses batshit-server API only (no localStorage)

import { logger } from '$lib/utils/logger'

export interface UnzippedItem {
  zipId: string
  sessionId: string
  permanent: boolean
  duration?: number
  unzippedAt: number
  messageCount?: number
  name?: string
  description?: string
  tokens?: number
  source?: 'user' | 'agent'
}

type ZipControlSource = 'user' | 'agent'

class ZippingService {
  private apiUrl = '/api/unzipping' // Now using Vite API endpoint
  private currentSessionId: string | null = null
  private sessionUnzipped: Map<string, UnzippedItem> = new Map() // Memory cache only
  private sessionRezipped: Set<string> = new Set()
  private sessionRezippedSources: Map<string, ZipControlSource> = new Map()

  private notifyStateChanged() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('batshit:zip-state-changed', {
        detail: {
          sessionId: this.currentSessionId,
          unzipped: this.getAllUnzipped(),
          rezipped: Array.from(this.sessionRezipped),
          rezippedSources: Object.fromEntries(this.sessionRezippedSources)
        }
      })
    )
  }

  private resolveFetch(fetcher?: typeof fetch) {
    if (fetcher) {
      return fetcher
    }
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
      return window.fetch.bind(window)
    }
    if (typeof fetch === 'function') {
      return fetch
    }
    return null
  }

  private async persistUnzippedItem(item: UnzippedItem, fetcher?: typeof fetch) {
    const fetchImpl = this.resolveFetch(fetcher)
    if (!fetchImpl) return

    try {
      const response = await fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-request': '1'
        },
        body: JSON.stringify({ ...item })
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
    } catch (error) {
      console.error('[Unzipping] Failed to persist unzipped item countdown:', error)
    }
  }
  
  async setCurrentSession(sessionId: string, fetcher?: typeof fetch) {
    if (this.currentSessionId !== sessionId) {
      this.currentSessionId = sessionId
      this.sessionUnzipped.clear()
      this.sessionRezipped.clear()
      this.sessionRezippedSources.clear()
      await this.loadUnzippedFromAPI(fetcher) // Load from API and wait for it
      this.notifyStateChanged()
    }
  }
  
  private async loadUnzippedFromAPI(fetcher?: typeof fetch) {
    if (!this.currentSessionId) return
    const fetchImpl = this.resolveFetch(fetcher)
    if (!fetchImpl) {
      console.warn('[Unzipping] No fetch implementation available, skipping load')
      return
    }
    
    try {
      const response = await fetchImpl(`${this.apiUrl}?sessionId=${this.currentSessionId}`, {
        // Mark as internal so hooks.server.ts skips public rate limiting
        headers: { 'x-internal-api-request': '1' }
      })
      if (!response.ok) {
        if (response.status === 404) {
          logger.debug('[Unzipping] No unzipped items found for session')
          return
        }
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      if (data.unzipped && Array.isArray(data.unzipped)) {
        this.sessionUnzipped.clear()
        this.sessionRezipped.clear()
        this.sessionRezippedSources.clear()
        data.unzipped.forEach((item: UnzippedItem) => {
          this.sessionUnzipped.set(item.zipId, item)
        })
        if (Array.isArray(data.rezipped)) {
          data.rezipped.forEach((id: string) => this.sessionRezipped.add(id))
        }
        if (data.rezippedSources && typeof data.rezippedSources === 'object') {
          Object.entries(data.rezippedSources).forEach(([id, source]) => {
            if (source === 'user' || source === 'agent') {
              this.sessionRezippedSources.set(id, source)
            }
          })
        }
        logger.debug(`[Unzipping] Loaded ${data.unzipped.length} unzipped items from API`)
      }
    } catch (error) {
      console.error('[Unzipping] Failed to load unzipped items from API:', error)
    }
  }
  
  async unzip(
    zipId: string,
    permanent: boolean = false,
    duration: number = 20,
    name?: string,
    description?: string,
    tokens?: number,
    source: 'user' | 'agent' = 'user',
    fetcher?: typeof fetch
  ) {
    if (!this.currentSessionId) {
      console.error('[Unzipping] No current session')
      return false
    }
    const fetchImpl = this.resolveFetch(fetcher)
    if (!fetchImpl) {
      console.error('[Unzipping] No fetch implementation available for unzip')
      return false
    }
    
    const item: UnzippedItem = {
      zipId,
      sessionId: this.currentSessionId,
      permanent,
      duration: permanent ? undefined : duration,
      unzippedAt: Date.now(),
      name,
      description,
      tokens,
      messageCount: 0,
      source
    }
    
    // Update cache immediately for responsiveness
    this.sessionUnzipped.set(zipId, item)
    this.sessionRezipped.delete(zipId)
    this.sessionRezippedSources.delete(zipId)
    this.notifyStateChanged()
    
    // Save to API
    try {
      const response = await fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-request': '1'
        },
        body: JSON.stringify(item)
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      logger.debug(`[Unzipping] Unzipped ${zipId} via API`)
      return true
    } catch (error) {
      console.error('[Unzipping] Failed to save unzipped item to API:', error)
      this.sessionUnzipped.delete(zipId) // Rollback on error
      this.notifyStateChanged()
      return false
    }
  }
  
  async rezip(zipId: string, sourceOrFetcher: ZipControlSource | typeof fetch = 'user', fetcher?: typeof fetch) {
    if (!this.currentSessionId) {
      console.error('[Unzipping] No current session')
      return false
    }
    const source: ZipControlSource = typeof sourceOrFetcher === 'string' ? sourceOrFetcher : 'user'
    const fetchImpl = this.resolveFetch(typeof sourceOrFetcher === 'function' ? sourceOrFetcher : fetcher)
    if (!fetchImpl) {
      console.error('[Unzipping] No fetch implementation available for rezip')
      return false
    }
    
    // Update cache immediately
    this.sessionUnzipped.delete(zipId)
    this.sessionRezipped.add(zipId)
    this.sessionRezippedSources.set(zipId, source)
    this.notifyStateChanged()
    
    // Delete from API
    try {
      const params = new URLSearchParams({
        sessionId: this.currentSessionId,
        source
      })
      const response = await fetchImpl(`${this.apiUrl}/${zipId}?${params.toString()}`, {
        method: 'DELETE',
        headers: { 'x-internal-api-request': '1' }
      })
      
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      logger.debug(`[Unzipping] Rezipped ${zipId} via API`)
      return true
    } catch (error) {
      console.error('[Unzipping] Failed to delete unzipped item from API:', error)
      return false
    }
  }

  async returnToAutomatic(zipId: string, fetcher?: typeof fetch) {
    if (!this.currentSessionId) {
      console.error('[Unzipping] No current session')
      return false
    }
    const fetchImpl = this.resolveFetch(fetcher)
    if (!fetchImpl) {
      console.error('[Unzipping] No fetch implementation available for returnToAutomatic')
      return false
    }

    const previousUnzipped = this.sessionUnzipped.get(zipId)
    const wasRezipped = this.sessionRezipped.has(zipId)
    const previousRezippedSource = this.sessionRezippedSources.get(zipId)

    this.sessionUnzipped.delete(zipId)
    this.sessionRezipped.delete(zipId)
    this.sessionRezippedSources.delete(zipId)
    this.notifyStateChanged()

    try {
      const params = new URLSearchParams({
        sessionId: this.currentSessionId,
        mode: 'automatic'
      })
      const response = await fetchImpl(`${this.apiUrl}/${zipId}?${params.toString()}`, {
        method: 'DELETE',
        headers: { 'x-internal-api-request': '1' }
      })

      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`)
      }

      logger.debug(`[Unzipping] Returned ${zipId} to automatic zip behavior via API`)
      return true
    } catch (error) {
      console.error('[Unzipping] Failed to return zip item to automatic behavior:', error)
      if (previousUnzipped) {
        this.sessionUnzipped.set(zipId, previousUnzipped)
      }
      if (wasRezipped) {
        this.sessionRezipped.add(zipId)
      }
      if (previousRezippedSource) {
        this.sessionRezippedSources.set(zipId, previousRezippedSource)
      }
      this.notifyStateChanged()
      return false
    }
  }
  
  isUnzipped(zipId: string): boolean {
    return this.sessionUnzipped.has(zipId)
  }

  isRezipped(zipId: string): boolean {
    return this.sessionRezipped.has(zipId)
  }

  getRezippedSource(zipId: string): ZipControlSource | undefined {
    return this.sessionRezippedSources.get(zipId)
  }
  
  getUnzippedInfo(zipId: string): UnzippedItem | undefined {
    return this.sessionUnzipped.get(zipId)
  }
  
  getAllUnzipped(): UnzippedItem[] {
    return Array.from(this.sessionUnzipped.values())
  }

  // Server-side hydration: populate from trusted data without hitting HTTP
  hydrate(
    sessionId: string,
    items: UnzippedItem[],
    rezippedIds: string[] = [],
    rezippedSources: Record<string, ZipControlSource> = {}
  ) {
    this.currentSessionId = sessionId
    this.sessionUnzipped.clear()
    this.sessionRezipped.clear()
    this.sessionRezippedSources.clear()
    items.forEach(item => {
      if (item?.zipId) {
        this.sessionUnzipped.set(item.zipId, item)
      }
    })
    rezippedIds.forEach(id => this.sessionRezipped.add(id))
    Object.entries(rezippedSources).forEach(([id, source]) => {
      if (source === 'user' || source === 'agent') {
        this.sessionRezippedSources.set(id, source)
      }
    })
    this.notifyStateChanged()
  }
  
  // Ensure the session is loaded before getting unzipped items
  async ensureSessionLoaded(sessionId: string, fetcher?: typeof fetch): Promise<void> {
    if (this.currentSessionId !== sessionId) {
      await this.setCurrentSession(sessionId, fetcher)
    }
  }
  
  getTotalTokens(): number {
    return Array.from(this.sessionUnzipped.values())
      .reduce((sum, item) => sum + (item.tokens || 0), 0)
  }
  
  incrementMessageCount(sessionId?: string | null, fetcher?: typeof fetch) {
    if (sessionId && sessionId !== this.currentSessionId) return

    // Update message counts and check for expiry
    const itemsToRezip: string[] = []
    const itemsToPersist: UnzippedItem[] = []
    
    this.sessionUnzipped.forEach((item, zipId) => {
      if (!item.permanent && item.duration !== undefined) {
        item.messageCount = (item.messageCount || 0) + 1
        if (item.messageCount >= item.duration) {
          itemsToRezip.push(zipId)
        } else {
          itemsToPersist.push({ ...item })
        }
      }
    })
    
    // Timed unzips expire back to automatic policy rather than creating a manual zip override.
    itemsToRezip.forEach(zipId => this.returnToAutomatic(zipId))
    if (itemsToPersist.length > 0) {
      this.notifyStateChanged()
      itemsToPersist.forEach(item => {
        void this.persistUnzippedItem(item, fetcher)
      })
    }
  }
  
  clear() {
    this.sessionUnzipped.clear()
    this.sessionRezipped.clear()
    this.sessionRezippedSources.clear()
    this.notifyStateChanged()
  }
  
  clearAll() {
    // Alias for clear() to match the component's expectations
    this.clear()
  }
  
  clearAllGlobally() {
    this.clear()
  }
}

export const zippingService = new ZippingService()
