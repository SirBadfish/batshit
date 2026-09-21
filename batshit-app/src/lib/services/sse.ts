/**
 * One chat's live events, over the browser's shared live connection (the live hub, 2026-09-18).
 *
 * Until then each `SSEService` opened its own `EventSource` to `/api/sse?sessionId=`, and a
 * browser shares six connections per server across all its tabs: three chat tabs held all six
 * and froze every request (`_local/mtab-proof/`). Now a connect is a subscription on the hub
 * (`$lib/services/liveHub/liveHubClient.ts`); the chat page's calls (`connect`, `disconnect`,
 * `isConnected`) mean what they meant:
 * - `connect` resolves once the SERVER has added this tab as a listener of the chat (so a send
 *   right after it cannot race the listener), and rejects if the server refuses the chat or
 *   nothing is added within five seconds.
 * - `onError` is called when the live connection drops (the hub reconnects and re-adds the chat
 *   by itself; the server replays the chat's live turn, and the page's `SseEventDeduper` drops
 *   what it already had) and when the server refuses the chat.
 */

import {
  subscribeLive,
  type LiveSubscription
} from '$lib/services/liveHub/liveHubClient'
import { logger } from '$lib/utils/logger'

export const SSE_CONNECT_TIMEOUT_MS = 5000

export class SSEService {
  private subscription: LiveSubscription | null = null
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(private sessionId: string) {}

  connect(onMessage: (data: any) => void, onError?: (error: any) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.subscription) {
        this.disconnect()
      }

      logger.debug('[SSE] Subscribing to session:', this.sessionId)
      let settled = false
      const subscription = subscribeLive(
        { scope: 'session', sessionId: this.sessionId },
        {
          onEvent: (text) => {
            let data: unknown
            try {
              data = JSON.parse(text)
            } catch (error) {
              console.error('[SSE] Failed to parse message:', error, text)
              return
            }
            logger.debug('[SSE] Received:', data)
            onMessage(data)
          },
          onStatus: (status, code) => {
            if (this.subscription !== subscription) return
            if (status === 'open') {
              this.clearConnectionTimeout()
              if (!settled) {
                settled = true
                logger.debug('[SSE] Connection opened')
                resolve()
              }
              return
            }
            if (status === 'down') {
              console.error('[SSE] Connection error: the live connection dropped and is reconnecting.')
              onError?.(new Error('SSE connection lost'))
              return
            }
            this.clearConnectionTimeout()
            this.subscription = null
            subscription.unsubscribe()
            const error = new Error(`SSE subscription refused (${code ?? 'unknown'})`)
            console.error('[SSE] Connection error:', error.message)
            onError?.(error)
            if (!settled) {
              settled = true
              reject(error)
            }
          }
        }
      )
      this.subscription = subscription

      this.clearConnectionTimeout()
      this.connectionTimeout = setTimeout(() => {
        if (this.subscription !== subscription || settled) return
        console.warn('[SSE] Connection timeout after 5 seconds')
        this.subscription = null
        subscription.unsubscribe()
        settled = true
        reject(new Error('SSE connection timeout'))
      }, SSE_CONNECT_TIMEOUT_MS)
    })
  }

  disconnect() {
    this.clearConnectionTimeout()
    if (this.subscription) {
      const subscription = this.subscription
      this.subscription = null
      subscription.unsubscribe()
    }
    logger.debug('[SSE] Disconnected')
  }

  isConnected(): boolean {
    return this.subscription?.state() === 'open'
  }

  private clearConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout)
      this.connectionTimeout = null
    }
  }
}
