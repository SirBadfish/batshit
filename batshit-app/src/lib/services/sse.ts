// SSE (Server-Sent Events) service for real-time communication
import { BATSHIT_SERVER_API_URL } from '$lib/services/apiClient'
import { logger } from '$lib/utils/logger'

export class SSEService {
  private eventSource: EventSource | null = null
  private reconnectTimeout: any = null
  private connectionTimeout: any = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  
  constructor(
    private sessionId: string,
    private baseUrl: string = '',  // Default to same origin (SvelteKit)
    private useBatshitServer: boolean = false  // Flag to use batshit-server instead of SvelteKit
  ) {}

  connect(onMessage: (data: any) => void, onError?: (error: any) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.eventSource) {
        this.disconnect()
      }

      // Use SvelteKit SSE endpoint by default, or batshit-server if flag is set
      const url = this.useBatshitServer
        ? `${BATSHIT_SERVER_API_URL}/sse/${this.sessionId}`
        : `${this.baseUrl}/api/sse?sessionId=${this.sessionId}`
      logger.debug('[SSE] Connecting to:', url)

      const eventSource = new EventSource(url)
      this.eventSource = eventSource

      // Set up a timeout in case connection never opens
      this.clearConnectionTimeout()
      this.connectionTimeout = setTimeout(() => {
        if (this.eventSource !== eventSource || eventSource.readyState === EventSource.CLOSED) {
          return
        }
        console.warn('[SSE] Connection timeout after 5 seconds')
        eventSource.close()
        if (this.eventSource === eventSource) {
          this.eventSource = null
        }
        reject(new Error('SSE connection timeout'))
      }, 5000)

      eventSource.onopen = () => {
        logger.debug('[SSE] Connection opened')
        if (this.eventSource === eventSource) {
          this.clearConnectionTimeout()
        }
        this.reconnectAttempts = 0
        resolve() // Resolve the promise when connection is open
      }

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          logger.debug('[SSE] Received:', data)
          onMessage(data)
        } catch (error) {
          console.error('[SSE] Failed to parse message:', error, event.data)
        }
      }

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error)
        if (this.eventSource === eventSource) {
          this.clearConnectionTimeout()
        }
        onError?.(error)

        // Only reject on first connection attempt
        if (this.reconnectAttempts === 0) {
          reject(error)
        }

        // Auto-reconnect logic
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
          logger.debug(`[SSE] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

          this.reconnectTimeout = setTimeout(() => {
            this.connect(onMessage, onError).catch(console.error)
          }, delay)
        }
      }
    })
  }
  
  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    this.clearConnectionTimeout()
    
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    
    logger.debug('[SSE] Disconnected')
  }
  
  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN
  }

  private clearConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout)
      this.connectionTimeout = null
    }
  }
}
