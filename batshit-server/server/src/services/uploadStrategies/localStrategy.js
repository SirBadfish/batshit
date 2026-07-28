const BaseUploadStrategy = require('./baseStrategy');
const redisService = require('../redisService');
const logger = require('../../utils/logger');
const { writeErrorLog } = require('../../utils/logSafety');
const {
  deleteFileBackedPayload,
  persistFileBackedUpload
} = require('../fileBackedUploadService');

function stripTrailingSlash(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function removeHttpScheme(value) {
  const lower = value.toLowerCase();
  if (lower.startsWith('https://')) return value.slice('https://'.length);
  if (lower.startsWith('http://')) return value.slice('http://'.length);
  return value;
}

function takeBeforeSlash(value) {
  const slashIndex = value.indexOf('/');
  return slashIndex >= 0 ? value.slice(0, slashIndex) : value;
}

function normalizeHost(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return parsed.host;
  } catch {
    return takeBeforeSlash(removeHttpScheme(trimmed));
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
 * Stores persistent files on disk with metadata in Redis and serves them via
 * local HTTP/HTTPS endpoints. Short-lived uploads remain in Redis so key expiry
 * cannot orphan file bytes.
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

      const fileData = {
        originalName: metadata?.originalName || filename,
        filename: storedFilename,
        mimetype: metadata.mimetype,
        size: buffer.length,
        uploadType: uploadType,
        uploadedAt: new Date().toISOString(),
        strategy: 'local',
        artifactSource: metadata?.artifactSource || null,
        ephemeralUpload: metadata?.ephemeralUpload === true || ttlSeconds > 0,
        ttlSeconds: ttlSeconds > 0 ? ttlSeconds : null,
        expiresAt:
          ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null
      };

      if (ttlSeconds > 0 || fileData.ephemeralUpload) {
        await redisService.setWithTTL(
          redisKey,
          { ...fileData, base64: buffer.toString('base64') },
          ttlSeconds
        );
        logger.debug('[LocalStrategy] Stored expiring file in Redis');
      } else {
        await persistFileBackedUpload({
          redisService,
          redisKey,
          uploadType,
          filename: storedFilename,
          buffer,
          payload: fileData
        });
        logger.debug('[LocalStrategy] Stored persistent file on disk with Redis metadata');
      }

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
      writeErrorLog(logger, '[LocalStrategy] Upload error', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      // Test Redis connection
      await redisService.ping();
      return true;
    } catch (error) {
      writeErrorLog(logger, '[LocalStrategy] Connection test failed', error);
      return false;
    }
  }

  requiresHttps() {
    // Local storage works with both HTTP and HTTPS
    return false;
  }

  async delete(redisKey) {
    try {
      const payload = await redisService.get(redisKey);
      const deleted = await redisService.delete(redisKey);
      if (!deleted) throw new Error(`Redis refused to delete upload metadata for ${redisKey}.`);
      if (payload) await deleteFileBackedPayload(payload);
      return true;
    } catch (error) {
      writeErrorLog(logger, '[LocalStrategy] Delete error', error);
      return false;
    }
  }
}

module.exports = LocalStorageStrategy;
