const BaseUploadStrategy = require('./baseStrategy');
const redisService = require('../redisService');
const logger = require('../../utils/logger');

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function normalizeHost(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return parsed.host;
  } catch {
    return trimmed.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function isLoopbackHost(value) {
  const host = normalizeHost(value);
  if (!host) return false;

  try {
    const parsed = new URL(`http://${host}`);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:');
  }
}

function resolveLocalServerOrigin(config) {
  const configuredHost = normalizeHost(config?.host);
  const protocol = config?.useHttps ? 'https' : 'http';
  if (configuredHost && isLoopbackHost(configuredHost)) {
    return `${protocol}://${configuredHost}`;
  }

  const envOrigin =
    process.env.BATSHIT_SERVER_PUBLIC_URL ||
    process.env.PUBLIC_BATSHIT_SERVER_URL ||
    process.env.BATSHIT_SERVER_URL;

  if (envOrigin) {
    try {
      const parsed = new URL(envOrigin);
      return stripTrailingSlash(`${parsed.protocol}//${parsed.host}`);
    } catch {
      logger.warn(`[LocalStrategy] Ignoring invalid Batshit server origin: ${envOrigin}`);
    }
  }

  return 'http://localhost:5600';
}

/**
 * Local Storage Strategy
 * Stores files in Redis and serves them via local HTTP/HTTPS endpoints
 * This is the current default behavior - 100% private, no external services
 */
class LocalStorageStrategy extends BaseUploadStrategy {
  constructor(config = {}) {
    super(config);
    this.name = 'local';
    this.displayName = 'Local Storage (Private)';
  }

  async upload(buffer, filename, metadata) {
    try {
      const timestamp = Date.now();
      const uploadType = metadata.mimetype.startsWith('image/') ? 'images' :
                        metadata.mimetype.startsWith('video/') ? 'videos' : 'documents';
      const storedFilename = `${timestamp}_${filename}`;
      const ttlCandidate = Number(metadata?.artifactTtlSeconds ?? 0);
      const ttlSeconds = Number.isFinite(ttlCandidate) && ttlCandidate > 0 ? Math.floor(ttlCandidate) : 0;

      // Generate unique Redis key
      const redisKey = `upload:${uploadType}:${storedFilename}`;

      // Store in Redis with metadata
      // IMPORTANT: We ALWAYS store base64 in Redis so files can be served via /uploads/...
      // The upload handler no longer duplicates that base64 into clip metadata; model-facing
      // base64 is derived from this upload record at send time when a runtime needs it.
      const fileData = {
        originalName: metadata?.originalName || filename,
        filename: storedFilename,
        mimetype: metadata.mimetype,
        size: buffer.length,
        base64: buffer.toString('base64'), // Always store for serving
        uploadType: uploadType,
        uploadedAt: new Date().toISOString(),
        strategy: 'local',
        artifactSource: metadata?.artifactSource || null,
        ephemeralUpload: metadata?.ephemeralUpload === true || ttlSeconds > 0,
        ttlSeconds: ttlSeconds > 0 ? ttlSeconds : null,
        expiresAt:
          ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null
      };

      // Store with TTL when requested (Agent Browser screenshot artifacts), else persist.
      await redisService.setWithTTL(redisKey, fileData, ttlSeconds);
      logger.debug(`[LocalStrategy] Stored file in Redis: ${redisKey}`);

      // Generate URLs
      const localOrigin = resolveLocalServerOrigin(this.config);
      const localUrl = `${localOrigin}/uploads/${uploadType}/${storedFilename}`;
      const tunnelPath = `/uploads/${uploadType}/${storedFilename}`;

      return {
        url: localUrl,
        displayUrl: localUrl,
        externalUrl: null,
        tunnelPath,
        redisKey,
        filename: storedFilename,
        isLocal: true,
        storageMode: 'local',
        skipBase64: true,
        requiresHttps: false
      };
    } catch (error) {
      logger.error('[LocalStrategy] Upload error:', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      // Test Redis connection
      await redisService.ping();
      return true;
    } catch (error) {
      logger.error('[LocalStrategy] Connection test failed:', error);
      return false;
    }
  }

  requiresHttps() {
    // Local storage works with both HTTP and HTTPS
    return false;
  }

  async delete(redisKey) {
    try {
      await redisService.delete(redisKey);
      return true;
    } catch (error) {
      logger.error('[LocalStrategy] Delete error:', error);
      return false;
    }
  }
}

module.exports = LocalStorageStrategy;
