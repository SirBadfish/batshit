// Zipping service - Uses batshit-server API only (no localStorage)

import { logger } from '$lib/utils/logger'

/**
 * Who changed a zip's state. `user` locks (an agent may not zip it), `agent` is zip
 * control, and `inferred` (SA-120 P5) is Batshit acting on a Judge Juice judgment: the
 * weakest of the three. It never locks anything, either of the others overwrites it, and
 * the browser never creates it; only the server writes it at the accepted-send boundary.
 */
export type ZipStateSource = 'user' | 'agent' | 'inferred'

export function isZipStateSource(value: unknown): value is ZipStateSource {
  return value === 'user' || value === 'agent' || value === 'inferred'
}

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
  source?: ZipStateSource
  /**
   * SA-129 P2 (DL-02): an agent's hold names the FILE it holds (the dead-copy ledger's key: a
   * project path, or `skill:<id>:<path>`). The server moves the hold to the newest whole read of
   * that file at every reply end, so it follows the file. Absent on every other record.
   */
  path?: string
  /** SA-129 P2: which agent holds it (a `source: 'agent'` hold), so every surface can name it. */
  agentId?: string
}

/**
 * One chat's zip state, read-only: what `compileForAI` reads to decide zip activation, and
 * what the DCM's `Current Zip State` lists. The browser singleton below is one (the tab's
 * current chat). A server compile builds its own with `createZipStateView`, because two
 * compiles can run at once in one process and a module-level object holds one chat.
 */
export interface ZipStateView {
  isUnzipped(zipId: string): boolean
  isRezipped(zipId: string): boolean
  getRezippedSource(zipId: string): ZipStateSource | undefined
  getUnzippedInfo(zipId: string): UnzippedItem | undefined
  getAllUnzipped(): UnzippedItem[]
}

/**
 * A frozen zip-state view over trusted records (the server's own Redis reads). A later item
 * with the same zip id replaces an earlier one in place, and a rezip source that is not a
 * known source is dropped, never guessed.
 */
export function createZipStateView(
  items: UnzippedItem[],
  rezippedIds: string[] = [],
  rezippedSources: Record<string, ZipStateSource> = {}
): ZipStateView {
  const unzipped = new Map<string, UnzippedItem>()
  for (const item of items) {
    if (item?.zipId) {
      unzipped.set(item.zipId, Object.freeze({ ...item }))
    }
  }
  const rezipped = new Set(rezippedIds)
  const sources = new Map<string, ZipStateSource>()
  for (const [zipId, source] of Object.entries(rezippedSources)) {
    if (isZipStateSource(source)) {
      sources.set(zipId, source)
    }
  }
  return Object.freeze({
    isUnzipped: (zipId: string) => unzipped.has(zipId),
    isRezipped: (zipId: string) => rezipped.has(zipId),
    getRezippedSource: (zipId: string) => sources.get(zipId),
    getUnzippedInfo: (zipId: string) => unzipped.get(zipId),
    getAllUnzipped: () => Array.from(unzipped.values())
  })
}

/**
 * SA-129 P2 (DL-08): the countdown of a "Hold for N messages" (and of Judge Juice's temporary
 * opens) after ONE more message in the chat. A permanent item is unchanged; a temporary one counts
 * one message and ends when its count reaches its duration (it then returns to the automatic
 * rules). The server burns the countdown (`advanceZipCountdowns`, once per accepted user message
 * and once per finished reply); a compile for a new user message reads the state as it will be
 * once that message counts, which is what the chat page's count used to give it.
 */
export function countOneMoreMessage(items: UnzippedItem[]): { kept: UnzippedItem[]; ended: UnzippedItem[] } {
  const kept: UnzippedItem[] = []
  const ended: UnzippedItem[] = []
  for (const item of items) {
    if (item.permanent || typeof item.duration !== 'number') {
      kept.push(item)
      continue
    }
    const messageCount = (item.messageCount || 0) + 1
    if (messageCount >= item.duration) ended.push({ ...item, messageCount })
    else kept.push({ ...item, messageCount })
  }
  return { kept, ended }
}

/**
 * What the browser itself may write: the user's own state. `agent` state (holds, the parked zip
 * actions) and `inferred` state are written only by the server at a reply end or an accepted send
 * (SA-129 P2, SA-120 P5), and are only read here.
 */
type ZipControlSource = 'user'

class ZippingService implements ZipStateView {
  private apiUrl = '/api/unzipping' // Now using Vite API endpoint
  private currentSessionId: string | null = null
  private sessionUnzipped: Map<string, UnzippedItem> = new Map() // Memory cache only
  private sessionRezipped: Set<string> = new Set()
  private sessionRezippedSources: Map<string, ZipStateSource> = new Map()
  private lastUnzipError: string | null = null

  getLastUnzipError(): string | null {
    return this.lastUnzipError
  }

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

  async setCurrentSession(sessionId: string, fetcher?: typeof fetch) {
    if (this.currentSessionId !== sessionId) {
      this.currentSessionId = sessionId
      this.lastUnzipError = null
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
            if (isZipStateSource(source)) {
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
    source: ZipControlSource = 'user',
    fetcher?: typeof fetch
  ) {
    this.lastUnzipError = null
    if (!this.currentSessionId) {
      this.lastUnzipError = 'No current chat is selected.'
      console.error('[Unzipping] No current session')
      return false
    }
    const fetchImpl = this.resolveFetch(fetcher)
    if (!fetchImpl) {
      this.lastUnzipError = 'The Hold request could not be sent.'
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
        const body = await response.json().catch(() => null)
        const reason = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : `HTTP ${response.status}`
        throw new Error(reason)
      }
      
      logger.debug(`[Unzipping] Unzipped ${zipId} via API`)
      return true
    } catch (error) {
      this.lastUnzipError = error instanceof Error ? error.message : String(error)
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

  getRezippedSource(zipId: string): ZipStateSource | undefined {
    return this.sessionRezippedSources.get(zipId)
  }
  
  getUnzippedInfo(zipId: string): UnzippedItem | undefined {
    return this.sessionUnzipped.get(zipId)
  }
  
  getAllUnzipped(): UnzippedItem[] {
    return Array.from(this.sessionUnzipped.values())
  }

  /**
   * SA-120 P5: re-read this session's zip state from Redis. The server writes `inferred`
   * unzips and rezips at the accepted-send boundary, so the tab learns of them here (the
   * finished reply's metadata says when). Redis is the authority; nothing is re-posted.
   */
  async refreshFromServer(sessionId: string, fetcher?: typeof fetch): Promise<void> {
    if (!sessionId) return
    if (this.currentSessionId !== sessionId) {
      await this.setCurrentSession(sessionId, fetcher)
      return
    }
    await this.loadUnzippedFromAPI(fetcher)
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
