const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

/**
 * Environment Variable Manager
 * Manages the master .env file with categorization and security
 */
class EnvManager {
  constructor() {
    // Path to master .env file at project root
    this.envPath = path.join(__dirname, '../../../../.env');
    this.templatePath = path.join(__dirname, '../../../../.env.example');
    
    // Security configuration - which vars to hide/mask
    this.sensitiveVars = new Set([
      'BATSHIT_AUTH_PASSWORD',
      'MCP_GATEWAY_AUTH_TOKEN',
      'N8N_WEBHOOK_AUTH',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_AI_API_KEY',
      'MISTRAL_API_KEY',
      'GROQ_API_KEY',
      'OPENROUTER_API_KEY',
      'ELEVENLABS_API_KEY',
      'DEEPGRAM_API_KEY',
      'JWT_SECRET',
      'SESSION_SECRET',
      'REDIS_PASSWORD',
      'AWS_SECRET_ACCESS_KEY'
    ]);

    // Categories for UI organization
    this.categories = {
      server: {
        name: '🌐 Server Configuration',
        vars: [
          'BATSHIT_FRONTEND_PORT',
          'BATSHIT_COMMANDER_PORT',
          'MCP_BRIDGE_PORT',
          'MCP_BRIDGE_HTTPS_PORT',
          'ENABLE_HTTPS',
          'NODE_ENV',
          'DOCKER_MCP_GATEWAY_URL'
        ]
      },
      database: {
        name: '🗄️ Database Configuration',
        vars: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_LOG_LEVEL']
      },
      security: {
        name: '🔒 Security & CORS',
        vars: ['BATSHIT_AUTH_ENABLED', 'BATSHIT_AUTH_USER', 'BATSHIT_AUTH_PASSWORD', 'MCP_GATEWAY_AUTH_TOKEN']
      },
      monitoring: {
        name: '📊 Logging',
        vars: ['BATSHIT_LOG_LEVEL', 'BATSHIT_HTTP_LOGS', 'VITE_LOG_LEVEL', 'VITE_DEBUG_MODE']
      },
      developer: {
        name: '🔧 Developer Options',
        vars: ['VITE_ENABLE_CODEX', 'VITE_ENABLE_CLAUDE_CLI']
      }
    };
  }

  /**
   * Read and parse the .env file
   * @returns {Object} Parsed environment variables by category
   */
  async readEnvFile() {
    try {
      // Check if .env exists, if not copy from .env.example
      try {
        await fs.access(this.envPath);
      } catch {
        logger.info('[EnvManager] No .env file found, creating from .env.example');
        const template = await fs.readFile(this.templatePath, 'utf8');
        await fs.writeFile(this.envPath, template);
      }

      const content = await fs.readFile(this.envPath, 'utf8');
      const lines = content.split('\n');
      const vars = {};

      // Parse each line
      for (const line of lines) {
        const trimmed = line.trim();
        
        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        // Parse KEY=VALUE
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          const value = valueParts.join('='); // Handle values with = in them
          vars[key] = value || '';
        }
      }

      return this.categorizeVars(vars);
    } catch (error) {
      logger.error('[EnvManager] Error reading .env file:', error);
      throw error;
    }
  }

  /**
   * Categorize variables for UI display
   * @param {Object} vars - Raw environment variables
   * @returns {Object} Categorized variables
   */
  categorizeVars(vars) {
    const categorized = {};
    
    // Initialize categories
    for (const [catKey, catConfig] of Object.entries(this.categories)) {
      categorized[catKey] = {
        name: catConfig.name,
        variables: {}
      };
    }

    // Add uncategorized section
    categorized.uncategorized = {
      name: '❓ Other Variables',
      variables: {}
    };

    // Categorize each variable
    for (const [key, value] of Object.entries(vars)) {
      let categorized = false;
      
      for (const [catKey, catConfig] of Object.entries(this.categories)) {
        if (catConfig.vars.includes(key)) {
          const displayValue = this.sensitiveVars.has(key) ? this.maskValue(value) : value;
          categorized[catKey].variables[key] = {
            value: displayValue,
            masked: this.sensitiveVars.has(key),
            actualValue: this.sensitiveVars.has(key) ? value : undefined
          };
          categorized = true;
          break;
        }
      }

      // If not categorized, add to uncategorized
      if (!categorized) {
        const displayValue = this.shouldMaskUnknown(key) ? this.maskValue(value) : value;
        categorized.uncategorized.variables[key] = {
          value: displayValue,
          masked: this.shouldMaskUnknown(key)
        };
      }
    }

    // Remove empty categories
    for (const key of Object.keys(categorized)) {
      if (Object.keys(categorized[key].variables).length === 0 && key !== 'uncategorized') {
        delete categorized[key];
      }
    }

    return categorized;
  }

  /**
   * Mask sensitive values for display
   * @param {string} value - Value to mask
   * @returns {string} Masked value
   */
  maskValue(value) {
    if (!value) return '';
    if (value.length <= 8) return '••••••••';
    // Show first 4 and last 2 characters
    return value.substring(0, 4) + '••••••' + value.substring(value.length - 2);
  }

  /**
   * Check if unknown variable should be masked
   * @param {string} key - Variable name
   * @returns {boolean} Should mask
   */
  shouldMaskUnknown(key) {
    const patterns = ['KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'PRIVATE'];
    return patterns.some(pattern => key.toUpperCase().includes(pattern));
  }

  /**
   * Update environment variables
   * @param {Object} updates - Key-value pairs to update
   * @returns {boolean} Success
   */
  async updateEnvFile(updates) {
    try {
      // Read current file
      const content = await fs.readFile(this.envPath, 'utf8');
      const lines = content.split('\n');
      const updatedLines = [];
      const processedKeys = new Set();

      // Update existing lines
      for (const line of lines) {
        const trimmed = line.trim();
        
        // Keep comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) {
          updatedLines.push(line);
          continue;
        }

        // Check if this line needs updating
        const [key] = trimmed.split('=');
        if (key && updates.hasOwnProperty(key)) {
          updatedLines.push(`${key}=${updates[key]}`);
          processedKeys.add(key);
        } else {
          updatedLines.push(line);
        }
      }

      // Add new variables that weren't in the file
      for (const [key, value] of Object.entries(updates)) {
        if (!processedKeys.has(key)) {
          updatedLines.push(`${key}=${value}`);
        }
      }

      // Write back
      await fs.writeFile(this.envPath, updatedLines.join('\n'));
      
      // Reload environment variables in current process
      this.reloadEnv();
      
      return true;
    } catch (error) {
      logger.error('[EnvManager] Error updating .env file:', error);
      throw error;
    }
  }

  /**
   * Reload environment variables in current process
   */
  reloadEnv() {
    try {
      const content = require('fs').readFileSync(this.envPath, 'utf8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          process.env[key] = valueParts.join('=') || '';
        }
      }
      
      logger.info('[EnvManager] Environment variables reloaded');
    } catch (error) {
      logger.error('[EnvManager] Error reloading environment:', error);
    }
  }

  /**
   * Get template structure for UI
   * @returns {Object} Template structure with descriptions
   */
  async getTemplate() {
    try {
      const template = await fs.readFile(this.templatePath, 'utf8');
      // Parse template to extract descriptions from comments
      // This could be enhanced to parse the template more intelligently
      return {
        template,
        categories: this.categories
      };
    } catch (error) {
      logger.error('[EnvManager] Error reading template:', error);
      return {
        template: '',
        categories: this.categories
      };
    }
  }
}

// Export singleton instance
module.exports = new EnvManager();
