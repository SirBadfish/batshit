const { createClient } = require('redis');
const logger = require('../utils/logger');

const REDIS_STARTUP_RETRY_DELAY_MS = 1000;
const REDIS_STARTUP_MAX_ATTEMPTS = 15;

function parseRedisUrl(redisUrl) {
  if (!redisUrl) return null;

  try {
    const parsed = new URL(redisUrl);
    const databaseFromPath =
      parsed.pathname && parsed.pathname !== '/'
        ? Number(parsed.pathname.slice(1))
        : undefined;

    return {
      url: redisUrl,
      host: parsed.hostname || 'localhost',
      port: parsed.port ? Number(parsed.port) : 6379,
      database: Number.isInteger(databaseFromPath) ? databaseFromPath : undefined
    };
  } catch (error) {
    throw new Error(`Invalid REDIS_URL: ${error.message}`);
  }
}

function resolveRedisConnectionConfig(env = process.env) {
  const fromUrl = parseRedisUrl(env.REDIS_URL);
  if (fromUrl) {
    return {
      url: fromUrl.url,
      database:
        env.REDIS_DB !== undefined && env.REDIS_DB !== ''
          ? Number(env.REDIS_DB)
          : fromUrl.database
    };
  }

  return {
    socket: {
      host: env.REDIS_HOST || 'localhost',
      port: env.REDIS_PORT ? Number(env.REDIS_PORT) : 6379
    },
    database:
      env.REDIS_DB !== undefined && env.REDIS_DB !== ''
        ? Number(env.REDIS_DB)
        : undefined
  };
}

class RedisService {
  constructor() {
    this.client = null;
    this.connected = false;
    this.useRedis = true; // Can be toggled for fallback to Maps
    this.startingUp = false;
  }

  isStartupRetryableError(error) {
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : String(error || '');
    return /LOADING/i.test(message) || /ECONNREFUSED/i.test(message);
  }

  async connect() {
    const connectionConfig = resolveRedisConnectionConfig(process.env);
    this.startingUp = true;

    for (let attempt = 1; attempt <= REDIS_STARTUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        if (this.client?.isOpen) {
          await this.client.quit().catch(() => {});
        }
        if (this.client?.removeAllListeners) {
          this.client.removeAllListeners();
        }

        this.client = createClient({
          ...connectionConfig,
          // Redis 8 optimizations
          commandsQueueMaxLength: 10000,
          enableAutoPipelining: true
        });

        this.client.on('error', (err) => {
          logger.error('[Redis] Client error:', err);
          this.connected = false;
          if (this.startingUp && this.isStartupRetryableError(err)) {
            logger.warn(
              '[Redis] Startup error is retryable; keeping Redis mode enabled while startup retries continue'
            );
            return;
          }
          this.useRedis = false; // Fallback to Maps on persistent runtime error
        });

        this.client.on('ready', () => {
          logger.debug('[Redis] Client ready');
          this.connected = true;
          this.useRedis = true;
        });

        await this.client.connect();
        await this.client.ping();

        this.connected = true;
        this.useRedis = true;
        this.startingUp = false;
        logger.info('[Redis] Connected successfully');
        return true;
      } catch (error) {
        const retryable =
          this.isStartupRetryableError(error) && attempt < REDIS_STARTUP_MAX_ATTEMPTS;
        this.connected = false;

        if (retryable) {
          logger.warn(
            `[Redis] Connection attempt ${attempt}/${REDIS_STARTUP_MAX_ATTEMPTS} hit a transient startup condition; retrying in ${REDIS_STARTUP_RETRY_DELAY_MS}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, REDIS_STARTUP_RETRY_DELAY_MS));
          continue;
        }

        logger.error('[Redis] Connection failed:', error);
        this.useRedis = false;
        this.startingUp = false;
        return false;
      }
    }

    this.connected = false;
    this.useRedis = false;
    this.startingUp = false;
    return false;
  }

  async disconnect() {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
      logger.debug('[Redis] Disconnected');
    }
  }

  // Helper to safely parse JSON - handles backward compatibility
  safeJsonParse(data) {
    if (!data) return null;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch (error) {
        // Not JSON, return as string
        return data;
      }
    }
    // If it's already an object (from RedisJSON), return as-is
    return data;
  }

  // Zip operations
  async setZip(zipId, content, metadata = {}) {
    if (!this.useRedis) return false;
    
    try {
      const zip = {
        id: zipId,
        content: content,
        type: metadata.type || 'text',
        tokens: metadata.tokens || 0,
        created_at: new Date().toISOString(),
        source: metadata.source || 'ai',
        size: content.length,
        name: metadata.name || '',
        description: metadata.description || '',
        // Include any additional metadata (like redisKey for uploads)
        ...metadata
      };
      
      // Store using RedisJSON
      await this.client.json.set(`zip:${zipId}`, '$', zip);
      
      logger.debug(`[Redis] Stored zip ${zipId} (${content.length} bytes) using RedisJSON`);
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to store zip ${zipId}:`, error);
      return false;
    }
  }

  async getZip(zipId) {
    if (!this.useRedis) return null;
    
    try {
      return await this.client.json.get(`zip:${zipId}`);
    } catch (error) {
      logger.error(`[Redis] Failed to get zip ${zipId}:`, error);
      return null;
    }
  }

  // Clip operations (user uploads - reusable across chats)
  async setClip(userId, clipId, clipData) {
    if (!this.useRedis) return false;
    
    try {
      // Store clip data using RedisJSON
      await this.client.json.set(`clip:${userId}:${clipId}`, '$', clipData);
      
      // Add to user's clip set
      await this.client.sAdd(`user:${userId}:clips`, clipId);
      
      logger.debug('[Redis] Stored clip using RedisJSON');
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to store clip:`, error);
      return false;
    }
  }

  async getClip(userId, clipId) {
    if (!this.useRedis) return null;
    
    try {
      const clipKey = `clip:${userId}:${clipId}`;
      return await this.client.json.get(clipKey);
    } catch (error) {
      logger.error(`[Redis] Failed to get clip ${clipId}:`, error);
      return null;
    }
  }

  async getUserClips(userId) {
    if (!this.useRedis) return [];
    
    try {
      const clipIds = await this.client.sMembers(`user:${userId}:clips`);
      const clips = [];
      
      for (const clipId of clipIds) {
        const clip = await this.getClip(userId, clipId);
        if (clip) clips.push(clip);
      }
      
      return clips;
    } catch (error) {
      logger.error(`[Redis] Failed to get user clips:`, error);
      return [];
    }
  }

  async deleteClip(userId, clipId) {
    if (!this.useRedis) return false;
    
    try {
      // Remove from user's clip set
      await this.client.sRem(`user:${userId}:clips`, clipId);
      
      // Delete clip data
      await this.client.del(`clip:${userId}:${clipId}`);
      
      logger.debug(`[Redis] Deleted clip ${clipId} for user ${userId}`);
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to delete clip:`, error);
      return false;
    }
  }

  // Agent settings operations
  async setAgentSettings(agentId, settings) {
    if (!this.useRedis) return false;
    
    try {
      // Ensure agent_id is included
      settings.agent_id = agentId;
      await this.client.json.set(`agent:${agentId}`, '$', settings);
      
      logger.debug(`[Redis] Stored agent settings for ${agentId}`);
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to store agent settings:`, error);
      return false;
    }
  }

  async getAgentSettings(agentId) {
    if (!this.useRedis) return null;
    
    try {
      return await this.client.json.get(`agent:${agentId}`);
    } catch (error) {
      logger.error(`[Redis] Failed to get agent settings:`, error);
      return null;
    }
  }

  // Cache operations (for message formatting cache later)
  async setCached(key, value, ttl = 3600) {
    if (!this.useRedis) return false;
    
    try {
      const cacheData = {
        content: value,
        cached_at: Date.now()
      };
      const cacheKey = `cache:${key}`;
      await this.client.json.set(cacheKey, '$', cacheData);
      if (ttl > 0) await this.client.expire(cacheKey, ttl);
      
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to cache:`, error);
      return false;
    }
  }

  async getCached(key) {
    if (!this.useRedis) return null;
    
    try {
      const cached = await this.client.json.get(`cache:${key}`);
      return cached ? cached.content : null;
    } catch (error) {
      logger.error(`[Redis] Failed to get cached:`, error);
      return null;
    }
  }

  // Generic operations
  async setWithTTL(key, value, ttl = 3600) {
    if (!this.useRedis) return false;
    
    try {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        await this.client.set(key, String(value));
      } else {
        await this.client.json.set(key, '$', value);
      }
      if (ttl > 0) await this.client.expire(key, ttl);
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to set with TTL:`, error);
      return false;
    }
  }

  async get(key) {
    if (!this.useRedis) return null;
    
    try {
      const exists = await this.client.exists(key);
      if (!exists) return null;
      
      // Special handling for system prompt keys which are plain text
      if (key.includes('system_prompt')) {
        return await this.client.get(key);
      }
      
      // Check type for proper retrieval
      const type = await this.client.type(key);
      if (type === 'ReJSON-RL') {
        return await this.client.json.get(key);
      } else {
        const value = await this.client.get(key);
        // Try to parse as JSON using safe parser, return raw value if not JSON
        return this.safeJsonParse(value) || value;
      }
    } catch (error) {
      logger.error(`[Redis] Failed to get:`, error);
      return null;
    }
  }

  async delete(key) {
    if (!this.useRedis) return false;
    
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to delete:`, error);
      return false;
    }
  }

  async keys(pattern) {
    if (!this.useRedis) return [];
    
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      logger.error(`[Redis] Failed to get keys:`, error);
      return [];
    }
  }

  // Registry cache operations
  async setRegistryCache(type, data) {
    if (!this.useRedis) return false;
    
    try {
      const cacheData = {
        data,
        cached_at: Date.now()
      };
      
      await this.client.json.set(`registry:${type}`, '$', cacheData);
      
      // Registry cache expires after 24 hours
      await this.client.expire(`registry:${type}`, 86400);
      
      return true;
    } catch (error) {
      logger.error(`[Redis] Failed to cache registry data:`, error);
      return false;
    }
  }

  async getRegistryCache(type) {
    if (!this.useRedis) return null;
    
    try {
      const registryKey = `registry:${type}`;
      const exists = await this.client.exists(registryKey);
      if (!exists) return null;
      const cached = await this.client.json.get(registryKey);
      return cached ? cached.data ?? null : null;
    } catch (error) {
      logger.error(`[Redis] Failed to get registry cache:`, error);
      return null;
    }
  }

  // Utility methods
  async flushAll() {
    if (!this.useRedis) return false;
    
    try {
      await this.client.flushAll();
      logger.warn('[Redis] Flushed all data!');
      return true;
    } catch (error) {
      logger.error('[Redis] Failed to flush:', error);
      return false;
    }
  }

  isConnected() {
    return this.connected && this.useRedis;
  }
}

// Export singleton instance
const redisService = new RedisService();
redisService.RedisService = RedisService;
redisService.resolveRedisConnectionConfig = resolveRedisConnectionConfig;

module.exports = redisService;
