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

  /**
   * Clean up or delete a file (optional)
   * @param {string} identifier - File identifier (URL, key, etc.)
   * @returns {Promise<boolean>} True if deleted
   */
  async delete(identifier) {
    // Optional - not all storage backends support deletion
    return false;
  }
}

module.exports = BaseUploadStrategy;
