/**
 * Redis Stream Service for Temporary Zip Storage
 * Implements temporary Redis list-based storage for streaming chunks
 * Part of Story 2.1: Stream-to-Zip Architecture
 */

import { redis } from './redis'
import type { RedisClientType } from 'redis'

export interface TempZipMetadata {
  sessionId: string
  messageId: string
  type: 'terminal' | 'diff' | 'error' | 'cool_tool' | 'image' | 'file'
  index: number
  startedAt: string
  language?: string  // For code blocks
  path?: string      // For diff blocks
}

export class RedisStreamService {
  private redisService = redis

  /**
   * Generate unique temporary Redis key for a zip block
   */
  createTempStorageKey(sessionId: string, messageId: string, type: string, index: number): string {
    return `zip_temp:${sessionId}:${messageId}:${type}:${index}`
  }

  /**
   * Generate metadata key for tracking active zip blocks
   */
  createTempMetadataKey(sessionId: string, messageId: string): string {
    return `zip_temp_meta:${sessionId}:${messageId}`
  }

  /**
   * Append a chunk to the temporary storage list
   * Uses RPUSH for efficient append operations
   */
  async appendChunk(key: string, chunk: string): Promise<void> {
    await this.redisService.rPush(key, chunk)
    
    // Set TTL of 1 hour as failsafe cleanup (refreshed on each append)
    await this.setExpiry(key, 3600)
    await this.refreshMetadataExpiryForStorageKey(key)
  }

  /**
   * Retrieve all chunks from a temporary storage list
   * Uses LRANGE to get all elements
   */
  async retrieveChunks(key: string): Promise<string[]> {
    return await this.redisService.lRange(key, 0, -1)
  }

  /**
   * Start tracking a new zippable block
   */
  async startZipBlock(metadata: TempZipMetadata): Promise<void> {
    const metaKey = this.createTempMetadataKey(metadata.sessionId, metadata.messageId)
    const blockKey = `${metadata.type}:${metadata.index}`
    
    // Get existing metadata or create new
    const existingMeta = await this.redisService.get(metaKey)
    const metaData = existingMeta || {}
    
    // Add this block to tracking
    metaData[blockKey] = {
      ...metadata,
      startedAt: metadata.startedAt || new Date().toISOString(),
      chunkCount: 0
    }
    
    // Store updated metadata
    await this.redisService.set(metaKey, metaData)
    
    // Set TTL on metadata
    await this.setExpiry(metaKey, 3600)
  }

  /**
   * Complete a zippable block and return assembled content
   */
  async completeZipBlock(
    sessionId: string, 
    messageId: string, 
    type: string, 
    index: number
  ): Promise<string | null> {
    const key = this.createTempStorageKey(sessionId, messageId, type, index)
    
    // Retrieve all chunks
    const chunks = await this.retrieveChunks(key)
    
    if (chunks.length === 0) {
      console.warn(`[RedisStreamService] No chunks found for ${key}`)
      return null
    }
    
    // Assemble content
    const content = chunks.join('')
    
    // Clean up temporary storage
    await this.cleanupTempStorage(key)
    
    // Update metadata
    const metaKey = this.createTempMetadataKey(sessionId, messageId)
    const blockKey = `${type}:${index}`
    const metadata = await this.redisService.get(metaKey)
    
    if (metadata && metadata[blockKey]) {
      delete metadata[blockKey]
      
      // If no more blocks, delete metadata
      if (Object.keys(metadata).length === 0) {
        await this.redisService.del(metaKey)
      } else {
        await this.redisService.set(metaKey, metadata)
      }
    }
    
    return content
  }

  /**
   * Clean up a temporary storage list
   */
  async cleanupTempStorage(key: string): Promise<void> {
    await this.redisService.del(key)
  }

  /**
   * Clean up all temporary storage for a session
   * Called on error or session end
   */
  async cleanupSessionTempStorage(sessionId: string, messageId?: string): Promise<void> {
    // Pattern for all temp storage keys for this session
    const pattern = messageId 
      ? `zip_temp:${sessionId}:${messageId}:*`
      : `zip_temp:${sessionId}:*`
    
    // Get all matching keys
    const keys = await this.redisService.keys(pattern)
    
    // Delete all temp storage keys
    for (const key of keys) {
      await this.redisService.del(key)
    }
    
    // Clean up metadata
    if (messageId) {
      const metaKey = this.createTempMetadataKey(sessionId, messageId)
      await this.redisService.del(metaKey)
    } else {
      // Clean up all metadata for session
      const metaPattern = `zip_temp_meta:${sessionId}:*`
      const metaKeys = await this.redisService.keys(metaPattern)
      for (const key of metaKeys) {
        await this.redisService.del(key)
      }
    }
  }

  /**
   * Get active zip blocks for a message
   */
  async getActiveZipBlocks(sessionId: string, messageId: string): Promise<TempZipMetadata[]> {
    const metaKey = this.createTempMetadataKey(sessionId, messageId)
    const metadata = await this.redisService.get(metaKey)
    
    if (!metadata) {
      return []
    }
    
    return Object.values(metadata)
  }

  /**
   * Handle concurrent zip blocks by tracking multiple blocks per message
   */
  async trackConcurrentBlock(
    sessionId: string,
    messageId: string,
    type: string
  ): Promise<number> {
    const metaKey = this.createTempMetadataKey(sessionId, messageId)
    const metadata = await this.redisService.get(metaKey) || {}
    
    // Find the next available index for this type
    let index = 1
    while (metadata[`${type}:${index}`]) {
      index++
    }
    
    // Start tracking this block
    await this.startZipBlock({
      sessionId,
      messageId,
      type: type as TempZipMetadata['type'],
      index,
      startedAt: new Date().toISOString()
    })
    
    return index
  }

  /**
   * Set expiry on a key (helper for TTL management)
   */
  private async setExpiry(key: string, seconds: number): Promise<void> {
    // Use Redis EXPIRE command via the redis service
    // This is a failsafe - keys should be cleaned up explicitly
    await this.redisService.execute(async (client: RedisClientType) => {
      await client.expire(key, seconds)
    })
  }

  private async refreshMetadataExpiryForStorageKey(key: string): Promise<void> {
    const [prefix, sessionId, messageId] = key.split(':')
    if (prefix !== 'zip_temp' || !sessionId || !messageId) return

    await this.setExpiry(this.createTempMetadataKey(sessionId, messageId), 3600)
  }
}

// Export singleton instance
export const redisStreamService = new RedisStreamService()
