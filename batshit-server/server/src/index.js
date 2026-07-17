const express = require('express');
const http = require('http');
const https = require('https');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const helmet = require('helmet');
const apiRoutes = require('./api');
const config = require('./config');
const logger = require('./utils/logger');
const redisService = require('./services/redisService');
const {
  migrateLegacyBase64Uploads,
  ensureAofRewriteAfterMigration,
} = require('./services/fileBackedUploadService');
const CertificateService = require('./services/certificateService');
const {
  corsOriginDelegate,
  enforceTrustedOrigin,
} = require('./utils/httpSecurity');
const { requireServiceToken } = require('./utils/serviceTokenAuth');

// Create Express app
const app = express();
const httpServer = http.createServer(app);

// HTTPS server will be created conditionally
let httpsServer;
let certificateService;

/**
 * Sanitizes a filename to make it safe for filesystem and URL serving
 * @param {string} filename - The original filename
 * @returns {string} - The sanitized filename
 */
function sanitizeFilename(filename) {
  // Remove query parameters and fragments
  let clean = filename.split('?')[0].split('#')[0];

  // Remove or replace invalid characters including ? character and newlines
  clean = clean.replace(/[<>:"|?*\\/]/g, '');
  clean = clean.replace(/[\r\n]/g, ''); // Remove newline characters

  // Remove leading/trailing spaces and dots
  clean = clean.trim().replace(/^\.+|\.+$/g, '');

  // Replace multiple spaces with single space
  clean = clean.replace(/\s+/g, ' ');

  // Ensure filename is not empty
  if (!clean) {
    clean = 'unnamed';
  }

  return clean;
}

// Middleware
// batshit-server serves JSON APIs and uploaded files — never an application
// document. The CSP below is inert for JSON/images but fully neutralizes any
// response a browser would render as a document (defense-in-depth on top of
// the upload-gate's HTML/SVG rejection). CORP stays cross-origin so the app
// origin can embed served clips in <img> tags.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      sandbox: [],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({
  origin: corsOriginDelegate,
  credentials: false,
}));
app.use(enforceTrustedOrigin);
// Only use morgan if HTTP logging is enabled
if (config.httpLogs) {
  app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
}
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Persistent upload bytes are owned by batshit-server's configured upload directory;
// Redis stores metadata and short-lived/explicitly ephemeral upload payloads.

function getHealthPayload() {
  const redisReady = Boolean(redisService.connected && redisService.useRedis);
  return {
    ok: redisReady,
    service: 'batshit-server',
    checks: {
      http: true,
      redis: redisReady
    }
  };
}

function healthHandler(req, res) {
  const payload = getHealthPayload();
  res.status(payload.ok ? 200 : 503).json(payload);
}

app.get('/health', healthHandler);
app.get('/api/v1/health', healthHandler);

// Every API route below requires the shared service token. Browser features
// reach these through session-authed batshit-app proxy routes; n8n custom
// nodes and app server services attach the token directly. Only the health
// checks above and the read-only `/uploads/*` clip serving stay public, so a
// managed tunnel or LAN-published port exposes no exec/upload/admin surface.
app.use('/api/v1', requireServiceToken, apiRoutes);

// Redis-based upload handlers
const uploadRedisRoutes = require('./api/upload-redis');
const serveUploadsRoutes = require('./api/serve-uploads');

// Use Redis upload routes (token-gated; userId is asserted by the
// authenticated caller, never trusted from anonymous requests)
app.use('/api', requireServiceToken, uploadRedisRoutes);
app.use('/uploads', serveUploadsRoutes);

// Static file serving for public directory (registry viewer, etc)
const publicDir = path.join(__dirname, '..', 'public');
app.use('/', express.static(publicDir));

// Initialize certificate service if HTTPS is enabled
if (config.enableHttps) {
  certificateService = new CertificateService(config);
}

// Start servers
let shutdownRequested = false;
let startupPromise = null;

async function startServers() {
  const httpPort = config.port || 5600;
  const httpsPort = config.httpsPort || 5443;
  const host = config.host || '127.0.0.1';

  // Redis-backed storage migrations must finish before the server accepts requests.
  const redisConnected = await redisService.connect();
  if (redisConnected) {
    logger.info('Redis connected successfully for Batshit storage');
    const migration = await migrateLegacyBase64Uploads({
      redisService,
      shouldStop: () => shutdownRequested
    });
    if (migration.migrated > 0) {
      logger.info(
        `[UploadMigration] Completed: ${migration.migrated}/${migration.scanned} records, ` +
          `${migration.bytesMoved} bytes moved to file-backed storage, ` +
          `${migration.skippedEphemeral} ephemeral records retained in Redis.`
      );
    }
    await ensureAofRewriteAfterMigration({ redisService, migration });
    if (migration.interrupted || shutdownRequested) {
      logger.info('[UploadMigration] Startup stopped safely at the shutdown boundary.');
      return;
    }
  } else {
    const message = 'Redis connection failed for Batshit-Server';
    if (config.redisRequired) {
      logger.error(`${message}; BATSHIT_REDIS_REQUIRED=true so startup cannot continue`);
      process.exit(1);
    }
    logger.warn(`${message} - using in-memory fallback`);
  }

  logger.info(`Upload directory: ${config.uploadsDir}`);

  if (shutdownRequested) return;

  // Start HTTP server (unless HTTPS only mode) only after storage is ready.
  if (!config.httpsOnly) {
    httpServer.listen(httpPort, host, () => {
      logger.info(`Batshit-Server HTTP server running at http://${host}:${httpPort}`);
    });
  }

  if (config.enableHttps) {
    try {
      const certificates = await certificateService.ensureCertificates();
      httpsServer = https.createServer(certificates, app);
      httpsServer.listen(httpsPort, host, () => {
        logger.info(`Batshit-Server HTTPS server running at https://${host}:${httpsPort}`);
        logger.info(`HTTPS URL: https://${host}:${httpsPort}`);
      });
    } catch (error) {
      logger.error('Failed to start HTTPS server:', error.message);
      if (config.httpsOnly) process.exit(1);
    }
  }
}

// Graceful shutdown: close HTTP/S servers with a hard deadline so a hung
// connection can never block process exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownRequested = true;
  logger.info(`${signal} received, shutting down gracefully...`);

  const shutdownPromises = [];

  if (httpServer?.listening) {
    shutdownPromises.push(new Promise(resolve => httpServer.close(resolve)));
  }

  if (httpsServer?.listening) {
    shutdownPromises.push(new Promise(resolve => httpsServer.close(resolve)));
  }
  if (startupPromise) shutdownPromises.push(startupPromise.catch(() => undefined));

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out; exiting now');
    process.exit(1);
  }, 30_000);
  forceExitTimer.unref();

  Promise.all(shutdownPromises).then(async () => {
    await redisService.disconnect().catch((error) => {
      logger.error('Failed to disconnect batshit-server Redis during shutdown:', error);
    });
    logger.info('All servers closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Call startup only after signal handlers are installed, so a quit during a
// large pre-listen migration reaches the cancellation boundary safely.
startupPromise = startServers().catch(error => {
  logger.error('Failed to start servers:', error);
  if (!shuttingDown) process.exit(1);
});

module.exports = { app, httpServer, httpsServer };
