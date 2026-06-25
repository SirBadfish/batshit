const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Service for generating and managing Batshit zips
 */
class batshitzipService {
  constructor() {
    // Store file metadata for retrieval
    this.fileMetadata = new Map();
  }

  /**
   * Generate a unique ID for Batshit zips with meaningful structure
   * @param {string} sessionId - Session ID (optional)
   * @param {string} messageId - Message ID (optional)
   * @param {string} contentType - Type of content (upload, terminal, code, etc.)
   * @param {number} index - Index for multiple zips of same type
   * @returns {string} Unique identifier
   */
  generateId(sessionId, messageId, contentType = 'unknown', index = 0) {
    // If no session info provided, use legacy format
    if (!sessionId) {
      return crypto.randomBytes(6).toString('hex');
    }
    
    // For user uploads: sessionId-upload-timestamp-index
    if (contentType === 'upload') {
      return `${sessionId}-upload-${Date.now()}-${index}`;
    }
    
    // For AI content: sessionId-messageId-contentType-index
    if (messageId && contentType) {
      return `${sessionId}-${messageId}-${contentType}-${index}`;
    }
    
    // Fallback with session but no message info
    return `${sessionId}-${Date.now()}-${contentType}-${index}`;
  }

  /**
   * Calculate token count for content
   * @param {string} content - The content to analyze
   * @returns {number} Estimated token count
   */
  calculateTokens(content) {
    return Math.ceil(content.length / 4);
  }

  /**
   * Generate description based on file type and content
   * @param {Object} fileData - File information
   * @returns {string} Human-readable description
   */
  generateDescription(fileData) {
    const { originalName, mimetype, size, textContent } = fileData;
    
    // For v2, we just use the filename as the description
    // The visual indicators and metadata handle the rest
    return originalName;
  }

  /**
   * Generate Batshit clip for uploaded file
   * @param {Object} fileData - File data from upload
   * @param {string} source - Source of the file (USER, AI, SMART)
   * @param {string} userId - User ID for clip ownership (clips are per-user)
   * @param {number} index - Index for multiple uploads
   * @returns {Object} Batshit zip data
   */
  generateFileZip(fileData, source = 'USER', userId = null, index = 0) {
    // Generate clip ID without session - clips are per-user, not per-session
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    const id = `clip_${timestamp}_${randomStr}_${index}`;
    const { filename, originalName, mimetype, size, url, base64, textContent } = fileData;

    // Calculate tokens based on content
    let tokens = 0;
    if (textContent) {
      // For text files, calculate from actual content
      // Use rough estimate for large files to avoid slow tokenizer
      if (textContent.length > 10000) {
        tokens = Math.ceil(textContent.length / 4); // Rough estimate
        logger.debug(`[batshitzip] Text file token estimate (rough): ${tokens} tokens for ${textContent.length} characters`);
      } else {
        tokens = this.calculateTokens(textContent);
        logger.debug(`[batshitzip] Text file token count (exact): ${tokens} tokens`);
      }
    } else if (mimetype && mimetype.startsWith('image/')) {
      // For images, calculate based on whether it's base64 or external URL
      if (base64) {
        // Local storage: calculate from base64 length
        tokens = Math.ceil(base64.length / 4);
        logger.debug(`[batshitzip] Image token count (base64): ${tokens} tokens for ${originalName}`);
      } else {
        // External URL: use vision model token cost (765 for standard images)
        tokens = 765; // Standard image token cost for URL references
        logger.debug(`[batshitzip] Image token count (vision model): ${tokens} tokens for ${originalName}`);
      }
    } else if (base64) {
      // For non-image binary files, calculate from base64 length
      tokens = Math.ceil(base64.length / 4);
      logger.debug(`[batshitzip] Binary file token estimate: ${tokens} tokens for ${base64.length} base64 characters`);
    } else {
      // Fallback rough estimate
      tokens = Math.ceil(size / 100);
      logger.debug(`[batshitzip] Fallback token estimate: ${tokens} tokens for ${size} bytes`);
    }

    const description = this.generateDescription(fileData);

    const zipData = {
      id,
      source,
      tokens,
      name: originalName,
      path: url,
      type: mimetype,
      description,
      // Store full data for retrieval
      fullData: {
        filename,
        base64,
        textContent,
        size
      }
    };

    // Store metadata for later retrieval
    this.fileMetadata.set(id, zipData);

    return zipData;
  }

  /**
   * Format as clip for user uploads
   * @param {Object} zipData - Zip data object
   * @param {Object} options - Additional options (externalUrl, storageMode)
   * @returns {string} Clip formatted string
   */
  formatAsClip(zipData, options = {}) {
    const { id, tokens, name, path, description } = zipData;
    const { externalUrl, storageMode = 'local' } = options;
    
    // Determine the URL to use
    const url = externalUrl || path;
    
    // Calculate tokens based on storage mode
    // External URLs are much smaller (~20-50 tokens) vs base64 (thousands)
    const actualTokens = externalUrl ? Math.ceil(externalUrl.length / 4) : tokens;
    
    // Generate NEW clip format: {{batshit-clip:id:::filename}}
    // Store metadata (tokens, storageMode, URLs) separately in Redis
    return `{{batshit-clip:${id}:::${description}}}`;
  }

  /**
   * Format Batshit zip in NEW format (v2) - for AI-generated content
   * @param {Object} zipData - Zip data object
   * @returns {string} v2 formatted zip
   */
  formatAsXML(zipData) {
    const { id, source, tokens, name, path, type, description } = zipData;
    
    // This method is ONLY for AI-generated content (terminal, code, diff, etc.)
    // User uploads MUST use formatAsClip() - no exceptions!
    
    if (source === 'USER') {
      throw new Error('User uploads must use formatAsClip(), not formatAsXML()');
    }
    
    // NEW zip format: {{batshit-zip:id:::summary}}
    // Store metadata (tokens, type, bufferSize, threshold) separately in Redis
    return `{{batshit-zip:${id}:::${description}}}`;
  }

  /**
   * Get file data by Batshit zip ID
   * @param {string} id - Batshit zip ID
   * @returns {Object|null} File metadata or null if not found
   */
  getFileData(id) {
    return this.fileMetadata.get(id) || null;
  }

  /**
   * Clear old file metadata (cleanup)
   * @param {number} maxAge - Maximum age in milliseconds
   */
  cleanupOldMetadata(maxAge = 24 * 60 * 60 * 1000) {
    // This could be enhanced to track creation time
    // For now, we'll keep all metadata during the session
  }
}

// Export singleton instance
module.exports = new batshitzipService();
