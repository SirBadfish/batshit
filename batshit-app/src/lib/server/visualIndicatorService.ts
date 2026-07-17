/**
 * Visual Indicator Service
 * Manages Redis keyspace notifications for real-time visual updates
 * Implements Stream-to-Zip architecture support from Story 2.5
 */

import { logger } from '$lib/utils/logger'
import { redis } from './redis'
import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import { createClient, type RedisClientType } from 'redis'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'

type VisualIndicatorListener = (event: VisualIndicatorEvent) => void

type VisualIndicatorSubscription = {
  client: any
  listeners: Set<VisualIndicatorListener>
}

// Active subscriptions (type inferred to allow RedisJSON extended client)
const subscriptions = new Map<string, VisualIndicatorSubscription>()
const zipSessionCache = new Map<string, string>()

// Visual state cache for performance
const visualStateCache = new Map<string, { isZipped: boolean, isUnzipped: boolean, timestamp: number }>()

// Cache TTL (5 seconds)
const CACHE_TTL = 5000
let keyspaceNotificationsInit: Promise<void> | null = null

async function resolveRedisSubscriptionConfig(): Promise<{ url: string; database: number }> {
  const url = resolveRedisConnectionUrl({
    REDIS_URL: await getRuntimeEnv('REDIS_URL'),
    REDIS_HOST: await getRuntimeEnv('REDIS_HOST'),
    REDIS_PORT: await getRuntimeEnv('REDIS_PORT'),
    REDIS_DB: await getRuntimeEnv('REDIS_DB')
  })
  const parsed = new URL(url)
  const database = parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : 0

  return {
    url,
    database: Number.isInteger(database) ? database : 0
  }
}

function keyspacePattern(database: number, keyPattern: string): string {
  return `__keyspace@${database}__:${keyPattern}`
}

export interface VisualIndicatorEvent {
  type: 'zip_created' | 'zip_deleted' | 'unzip_added' | 'unzip_removed'
  zipId: string
  sessionId?: string
  timestamp: number
}

/**
 * Initialize Redis keyspace notifications for zip patterns
 * Configures Redis to monitor zip:* and unzipped:* patterns
 */
async function enableKeyspaceNotifications(): Promise<void> {
  let configClient: ReturnType<typeof createClient> | null = null
  try {
    const redisConfig = await resolveRedisSubscriptionConfig()
    // Create a separate client for configuration
    configClient = createClient({
      url: redisConfig.url
    })
    
    await configClient.connect()
    
    // Enable keyspace notifications (KEA = Key events, Expired events, and general commands)
    await configClient.configSet('notify-keyspace-events', 'KEA')
    
    logger.debug('[VisualIndicators] Redis keyspace notifications enabled')
  } catch (error) {
    console.error('[VisualIndicators] Failed to enable keyspace notifications:', error)
    // Continue anyway - notifications are enhancement, not critical
  } finally {
    if (configClient?.isOpen) {
      await configClient.disconnect().catch((error) => {
        console.error('[VisualIndicators] Failed to close Redis configuration client:', error)
      })
    }
  }
}

export async function initializeKeyspaceNotifications(): Promise<void> {
  keyspaceNotificationsInit ??= enableKeyspaceNotifications()
  await keyspaceNotificationsInit
}

/**
 * Setup monitoring for a specific session
 * Creates pubsub connection for real-time updates
 */
export async function setupSessionMonitoring(
  sessionId: string,
  onEvent: VisualIndicatorListener
): Promise<() => Promise<void>> {
  // Check if already monitoring this session
  const existing = subscriptions.get(sessionId)
  if (existing) {
    existing.listeners.add(onEvent)
    logger.debug(`[VisualIndicators] Already monitoring session: ${sessionId}`)
    return () => removeSessionListener(sessionId, onEvent)
  }

  let pubsubClient: ReturnType<typeof createClient> | null = null
  try {
    const redisConfig = await resolveRedisSubscriptionConfig()
    // Create separate Redis connection for pubsub
    pubsubClient = createClient({
      url: redisConfig.url
    })
    
    await pubsubClient.connect()
    
    // Subscribe to patterns for Stream-to-Zip architecture
    // Monitor new zip storage pattern: zip:{zipId}
    const zipPattern = keyspacePattern(redisConfig.database, 'zip:*')
    const unzippedPattern = keyspacePattern(redisConfig.database, 'unzipped:*')
    const unzippedItemPattern = keyspacePattern(redisConfig.database, 'unzipped_item:*')
    
    // Subscribe to patterns
    await pubsubClient.pSubscribe(zipPattern, (message, channel) => {
      void handleKeyspaceEvent(channel, message, sessionId)
    })
    
    await pubsubClient.pSubscribe(unzippedPattern, (message, channel) => {
      void handleKeyspaceEvent(channel, message, sessionId)
    })
    
    await pubsubClient.pSubscribe(unzippedItemPattern, (message, channel) => {
      void handleKeyspaceEvent(channel, message, sessionId)
    })
    
    // Store subscription
    subscriptions.set(sessionId, {
      client: pubsubClient,
      listeners: new Set([onEvent])
    })
    
    logger.debug(`[VisualIndicators] Monitoring started for session: ${sessionId}`)
    
    // Return cleanup function
    return () => removeSessionListener(sessionId, onEvent)
  } catch (error) {
    console.error(`[VisualIndicators] Failed to setup monitoring for session ${sessionId}:`, error)
    if (pubsubClient?.isOpen) {
      await pubsubClient.disconnect().catch((disconnectError) => {
        console.error('[VisualIndicators] Failed to close partial pubsub client:', disconnectError)
      })
    }
    return async () => {}
  }
}

function emitSessionEvent(sessionId: string, event: VisualIndicatorEvent): void {
  const subscription = subscriptions.get(sessionId)
  if (!subscription || subscription.listeners.size === 0) return

  for (const listener of subscription.listeners) {
    listener(event)
  }
}

async function removeSessionListener(
  sessionId: string,
  listener: VisualIndicatorListener
): Promise<void> {
  const subscription = subscriptions.get(sessionId)
  if (!subscription) return

  subscription.listeners.delete(listener)
  if (subscription.listeners.size === 0) {
    await cleanupSessionMonitoring(sessionId)
  }
}

async function resolveZipSessionId(zipId: string, operation: string): Promise<string | null> {
  if (operation === 'del' || operation === 'expired') {
    const cached = zipSessionCache.get(zipId) ?? null
    zipSessionCache.delete(zipId)
    return cached
  }

  try {
    const zip = await redis.execute(async (client) => {
      return await client.json.get(`zip:${zipId}`)
    })
    const record = zip as Record<string, any> | null
    const owner =
      record?.metadata?.sessionId ||
      record?.metadata?.session_id ||
      record?.sessionId ||
      record?.session_id ||
      null
    if (typeof owner === 'string' && owner.trim()) {
      zipSessionCache.set(zipId, owner)
      return owner
    }
  } catch (error) {
    logger.warn('[VisualIndicators] Failed to resolve zip session owner', {
      zipId,
      error
    })
  }

  return null
}

/**
 * Handle keyspace event and convert to visual indicator event
 */
async function handleKeyspaceEvent(
  channel: string,
  message: string,
  sessionId: string
): Promise<void> {
  // Parse channel to extract key info
  // Format: __keyspace@0__:zip:abc123 or __keyspace@0__:unzipped:sessionId
  const keyParts = channel.replace(/^__keyspace@\d+__:/, '').split(':')
  const keyType = keyParts[0]
  
  // Handle based on key type and operation
  if (keyType === 'zip') {
    const zipId = keyParts[1]
    const zipSessionId = await resolveZipSessionId(zipId, message)
    if (zipSessionId !== sessionId) {
      return
    }

    if (message === 'set' || message === 'json.set') {
      emitSessionEvent(sessionId, {
        type: 'zip_created',
        zipId,
        sessionId,
        timestamp: Date.now()
      })
    } else if (message === 'del' || message === 'expired') {
      emitSessionEvent(sessionId, {
        type: 'zip_deleted',
        zipId,
        sessionId,
        timestamp: Date.now()
      })
    }
  } else if (keyType === 'unzipped' && keyParts[1] === sessionId) {
    // Unzipped set operations for this session
    if (message === 'sadd') {
      // Need to get the actual zipId from recent operations
      // This is a limitation of keyspace notifications - they don't provide the value
      // We'll handle this through the unzipped_item pattern instead
    } else if (message === 'srem') {
      // Similar limitation here
    }
  } else if (keyType === 'unzipped_item') {
    // Format: unzipped_item:sessionId:zipId
    if (keyParts[1] === sessionId) {
      const zipId = keyParts[2]
      if (message === 'set') {
        emitSessionEvent(sessionId, {
          type: 'unzip_added',
          zipId,
          sessionId,
          timestamp: Date.now()
        })
      } else if (message === 'del' || message === 'expired') {
        emitSessionEvent(sessionId, {
          type: 'unzip_removed',
          zipId,
          sessionId,
          timestamp: Date.now()
        })
      }
    }
  }
  
  // Clear cache for affected zipId to force refresh
  const cacheKey = `${keyParts[keyParts.length - 1]}:${sessionId}`
  visualStateCache.delete(cacheKey)
}

/**
 * Clean up monitoring for a session
 */
export async function cleanupSessionMonitoring(sessionId: string): Promise<void> {
  const subscription = subscriptions.get(sessionId)
  if (subscription) {
    if (subscription.client.isOpen) {
      try {
        await subscription.client.disconnect()
      } catch (error) {
        console.error(
          `[VisualIndicators] Disconnect failed for session ${sessionId}; forcing socket destruction:`,
          error
        )
        subscription.client.destroy()
        if (subscription.client.isOpen) throw error
      }
    }
    subscriptions.delete(sessionId)
    logger.debug(`[VisualIndicators] Monitoring stopped for session: ${sessionId}`)
  }
  
  // Clear cache entries for this session
  for (const [key] of visualStateCache) {
    if (key.endsWith(`:${sessionId}`)) {
      visualStateCache.delete(key)
    }
  }
}

/**
 * Get visual state for a zip
 * Uses cache for performance with < 50ms requirement
 */
export async function getVisualState(
  zipId: string,
  sessionId: string
): Promise<{ isZipped: boolean; isUnzipped: boolean }> {
  const cacheKey = `${zipId}:${sessionId}`
  const cached = visualStateCache.get(cacheKey)
  
  // Return cached value if fresh
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { isZipped: cached.isZipped, isUnzipped: cached.isUnzipped }
  }
  
  try {
    // Check if zip exists
    const isZipped = await redis.execute(async (client) => {
      const exists = await client.exists(`zip:${zipId}`)
      return exists === 1
    })
    
    // Check if unzipped for this session
    const isUnzipped = await redis.execute(async (client) => {
      const isMember = await client.sIsMember(`unzipped:${sessionId}`, zipId)
      return isMember === 1
    })
    
    // Update cache
    visualStateCache.set(cacheKey, {
      isZipped,
      isUnzipped,
      timestamp: Date.now()
    })
    
    return { isZipped, isUnzipped }
  } catch (error) {
    console.error(`[VisualIndicators] Failed to get visual state for ${zipId}:`, error)
    return { isZipped: false, isUnzipped: false }
  }
}

/**
 * Cleanup all monitoring
 */
export async function cleanupAllMonitoring(): Promise<void> {
  await Promise.all(Array.from(subscriptions.keys()).map(cleanupSessionMonitoring))
  visualStateCache.clear()
}
