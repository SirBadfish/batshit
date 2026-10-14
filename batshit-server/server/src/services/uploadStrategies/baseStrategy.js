/**
 * Base upload storage interface.
 * Batshit currently ships only local storage, but the local implementation keeps
 * this small interface to preserve the existing upload service boundary.
 */
class BaseUploadStrategy {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
  }

  /**
   * Upload a file and return the public URL
   * @param {Buffer} buffer - File buffer
   * @param {string} filename - Original filename
   * @param {Object} metadata - Additional metadata (mimetype, size, etc.)
   * @returns {Promise<Object>} Result with url and any additional data
   */
  async upload(buffer, filename, metadata) {
    throw new Error('upload() method must be implemented by subclass');
  }

  /**
   * Test if the storage backend is properly configured and working
   * @returns {Promise<boolean>} True if working, false otherwise
   */
  async testConnection() {
    throw new Error('testConnection() method must be implemented by subclass');
  }

  /**
   * Get the backend name for display/logging
   * @returns {string} Human-readable strategy name
   */
  getName() {
    return this.name;
  }

  /**
   * Check if this backend requires HTTPS URLs
   * @returns {boolean} True if HTTPS required (for cloud services)
   */
  requiresHttps() {
    return false;
  }

  // No delete (BL-282): a placeholder that answered `false` was a silent no-op waiting for a
  // caller. Upload deletes go through `deleteStoredUploadRecord` in `upload-redis.js`.
}

module.exports = BaseUploadStrategy;
