const LocalStorageStrategy = require('./uploadStrategies/localStrategy');
const logger = require('../utils/logger');

/**
 * Local upload manager.
 *
 * Batshit clip uploads always store through the local strategy: persistent bytes
 * are file-backed with Redis metadata, while TTL-backed ephemeral bytes stay in Redis.
 * Model-facing URL vs data-URL transport is resolved later by the app runtime.
 */
class UploadManager {
  constructor() {
    this.strategies = new Map();
    this.currentStrategy = null;
    
    // Initialize available strategies
    this.initializeStrategies();
  }

  initializeStrategies() {
    // Keep the strategy wrapper only for the existing upload service boundary.
    this.strategies.set('local', LocalStorageStrategy);
    
  }

  /**
   * Set the local upload implementation.
   * @param {string} strategyName - Ignored unless local; retained for the upload service boundary
   * @param {Object} config - Configuration for local URL generation
   */
  setStrategy(strategyName, config = {}) {
    const StrategyClass = this.strategies.get(strategyName);
    if (!StrategyClass) {
      logger.warn(`[UploadManager] Ignoring unsupported upload storage ${strategyName}; using local storage`);
      strategyName = 'local';
    }

    try {
      this.currentStrategy = new (this.strategies.get(strategyName))(config);
      
      logger.info(`[UploadManager] Local upload storage ready: ${this.currentStrategy.displayName || strategyName}`);
    } catch (error) {
      logger.error(`[UploadManager] Failed to initialize strategy ${strategyName}:`, error);
      this.currentStrategy = new LocalStorageStrategy(config);
    }
  }

  /**
   * Upload a file using local storage.
   * @param {Buffer} buffer - File buffer
   * @param {string} filename - Original filename
   * @param {Object} metadata - File metadata
   * @returns {Promise<Object>} Upload result
   */
  async upload(buffer, filename, metadata) {
    if (!this.currentStrategy) {
      this.setStrategy('local');
    }

    try {
      const result = await this.currentStrategy.upload(buffer, filename, metadata);
      result.strategy = this.currentStrategy.name;
      return result;
    } catch (error) {
      logger.error(`[UploadManager] Local upload failed:`, error);
      throw error;
    }
  }

  /**
   * Test the current strategy connection
   * @returns {Promise<boolean>} True if working
   */
  async testConnection() {
    if (!this.currentStrategy) {
      return false;
    }
    
    return await this.currentStrategy.testConnection();
  }

  /**
   * Get list of available strategies
   * @returns {Array} Available strategy names and display names
   */
  getAvailableStrategies() {
    const strategies = [];
    for (const [key, StrategyClass] of this.strategies) {
      const instance = new StrategyClass();
      strategies.push({
        key,
        name: instance.displayName || instance.name,
        requiresHttps: instance.requiresHttps()
      });
    }
    return strategies;
  }

  /**
   * Get the current strategy name
   * @returns {string} Current strategy name
   */
  getCurrentStrategy() {
    return this.currentStrategy ? this.currentStrategy.name : 'none';
  }
}

// Export singleton instance
module.exports = new UploadManager();
