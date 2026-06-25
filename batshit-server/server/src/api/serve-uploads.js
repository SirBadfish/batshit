// Serve uploaded files from Redis metadata and optional local file-backed storage.
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const redisService = require('../services/redisService');
const { getTrustedCorsOriginForRequest } = require('../utils/httpSecurity');

const router = express.Router();

function resolveFilesystemUploadPath(fileData) {
  const uploadRoot = path.resolve(config.uploadsDir);
  const rawPath =
    typeof fileData?.relativePath === 'string' && fileData.relativePath
      ? path.resolve(uploadRoot, fileData.relativePath)
      : typeof fileData?.filePath === 'string'
        ? path.resolve(fileData.filePath)
        : null;

  if (!rawPath) return null;
  if (!rawPath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('Stored upload path escaped the configured upload directory.');
  }
  return rawPath;
}

function applyUploadCorsHeader(req, res) {
  const origin = getTrustedCorsOriginForRequest(req);
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
  }
}

// Shared hardening headers for served uploads: `nosniff` stops MIME sniffing
// on content/extension mismatches, `inline` Content-Disposition keeps clips
// renderable in <img> tags and AI-provider fetches while pinning a filename,
// and `private` keeps tunnel/proxy intermediaries from caching user content.
function buildUploadSecurityHeaders(filename) {
  const asciiName = String(filename || 'upload')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .trim() || 'upload';
  return {
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${asciiName}"`,
    'Cache-Control': 'private, max-age=31536000'
  };
}

async function serveFileBackedUpload(fileData, filename, req, res, headOnly = false) {
  const filePath = resolveFilesystemUploadPath(fileData);
  if (!filePath) return false;

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      logger.error(`File-backed upload metadata exists but file is missing: ${filePath}`);
      if (headOnly) {
        res.status(404).end();
      } else {
        res.status(404).json({ error: 'File not found' });
      }
      return true;
    }
    throw error;
  }

  res.set({
    'Content-Type': fileData.mimetype || 'application/octet-stream',
    'Content-Length': stat.size,
    'ETag': `"${filename}"`,
    'Last-Modified': fileData.uploadedAt || stat.mtime.toUTCString(),
    ...buildUploadSecurityHeaders(filename)
  });
  applyUploadCorsHeader(req, res);

  if (headOnly) {
    res.end();
    return true;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    logger.error('Error streaming uploaded file:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream file' });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
  return true;
}

/**
 * Serve uploaded files from Redis metadata.
 * URL format: /uploads/:type/:filename
 * Example: /uploads/images/1234567890_photo.jpg
 */
router.get('/:type/:filename', async (req, res) => {
  try {
    const { type, filename } = req.params;
    let redisKey = `upload:${type}:${filename}`;
    
    logger.debug(`Serving file from Redis: ${redisKey}`);
    
    // Get file data from Redis
    let fileData = await redisService.get(redisKey);
    
    // For avatars, try the new organized structure if old key doesn't exist
    if (!fileData && type === 'avatars') {
      // Check if filename follows new pattern: entityType_entityId_timestamp.jpg
      const parts = filename.split('_');
      if (parts.length >= 3) {
        const entityType = parts[0];
        // Try new organized key pattern
        const newKey = `upload:avatars:${entityType}:${filename}`;
        fileData = await redisService.get(newKey);
        if (fileData) {
          logger.debug(`Found avatar in new structure: ${newKey}`);
        }
      }
      
      // If still not found, check for default avatars
      if (!fileData) {
        if (filename === 'default_user_avatar.png') {
          fileData = await redisService.get('defaults:avatars:user');
        } else if (filename === 'default_agent_avatar.png') {
          fileData = await redisService.get('defaults:avatars:agent');
        } else if (filename === 'default_subagent_avatar.png') {
          fileData = await redisService.get('defaults:avatars:subagent');
        }
      }
    }
    
    if (!fileData) {
      logger.warn(`File not found in Redis: ${redisKey}`);
      const looksLikeEphemeralAgentBrowser =
        typeof filename === 'string' && filename.includes('batshit-agent-browser-');
      if (looksLikeEphemeralAgentBrowser) {
        return res.status(410).json({ error: 'Artifact expired' });
      }
      return res.status(404).json({ error: 'File not found' });
    }

    if (await serveFileBackedUpload(fileData, filename, req, res)) {
      return;
    }
    
    // Convert content to buffer - handle both base64 and plain text
    let buffer;
    if (fileData.textContent) {
      // Text files stored as plain text
      buffer = Buffer.from(fileData.textContent, 'utf-8');
    } else if (fileData.base64) {
      // Binary files stored as base64
      buffer = Buffer.from(fileData.base64, 'base64');
    } else {
      logger.error(`File has neither textContent nor base64: ${redisKey}`);
      return res.status(500).json({ error: 'Invalid file data' });
    }
    
    // Set appropriate headers
    res.set({
      'Content-Type': fileData.mimetype,
      'Content-Length': buffer.length,
      'ETag': `"${filename}"`,
      'Last-Modified': fileData.uploadedAt || new Date().toUTCString(),
      ...buildUploadSecurityHeaders(filename)
    });
    applyUploadCorsHeader(req, res);
    
    // Send the file
    res.send(buffer);
    
  } catch (error) {
    logger.error('Error serving file from Redis:', error);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

/**
 * Get file metadata without serving the file
 * Useful for checking if a file exists or getting its size
 */
router.head('/:type/:filename', async (req, res) => {
  try {
    const { type, filename } = req.params;
    const redisKey = `upload:${type}:${filename}`;
    
    const fileData = await redisService.get(redisKey);
    
    if (!fileData) {
      const looksLikeEphemeralAgentBrowser =
        typeof filename === 'string' && filename.includes('batshit-agent-browser-');
      return res.status(looksLikeEphemeralAgentBrowser ? 410 : 404).end();
    }

    if (await serveFileBackedUpload(fileData, filename, req, res, true)) {
      return;
    }
    
    // Just send headers, no body
    res.set({
      'Content-Type': fileData.mimetype,
      'Content-Length': fileData.size || Buffer.from(fileData.base64, 'base64').length,
      'Last-Modified': fileData.uploadedAt || new Date().toUTCString(),
      ...buildUploadSecurityHeaders(filename)
    });
    applyUploadCorsHeader(req, res);
    
    res.end();
    
  } catch (error) {
    logger.error('Error checking file in Redis:', error);
    res.status(500).end();
  }
});

module.exports = router;
