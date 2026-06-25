const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Default configuration
const defaultConfig = {
  host: process.env.BATSHIT_SERVER_HOST || process.env.HOST || '127.0.0.1',
  port: process.env.PORT || 5600,
  httpsPort: process.env.HTTPS_PORT || 5600,  // Use same port as HTTP by default
  enableHttps: process.env.ENABLE_HTTPS === 'true',
  httpsOnly: process.env.HTTPS_ONLY === 'true',
  sslCertPath: process.env.SSL_CERT_PATH,
  sslKeyPath: process.env.SSL_KEY_PATH,
  autoGenerateCerts: process.env.AUTO_GENERATE_CERTS !== 'false', // Default true
  logLevel: process.env.BATSHIT_LOG_LEVEL || process.env.LOG_LEVEL || 'info',
  httpLogs: process.env.BATSHIT_HTTP_LOGS === 'true',
  redisRequired:
    process.env.BATSHIT_REDIS_REQUIRED === 'true' || process.env.NODE_ENV === 'production',
  pluginsDir: path.join(__dirname, 'plugins'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, '../uploads'),
  cors: {
    origin: process.env.CORS_ORIGIN || '*'
  }
};

// Load from config file if exists
let fileConfig = {};
const configPath = process.env.CONFIG_PATH || path.join(__dirname, '../config.json');

try {
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (error) {
  console.warn(`Failed to load config from ${configPath}:`, error.message);
}

// Merge configurations with environment variables taking precedence
const config = {
  ...defaultConfig,
  ...fileConfig,
  // Add any environment variable overrides here
};

// Ensure required directories exist
if (!fs.existsSync(config.uploadsDir)) {
  try {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
  } catch (error) {
    console.error(`Failed to create uploads directory: ${error.message}`);
  }
}

module.exports = config;
