const { timingSafeEqual } = require('crypto');

/**
 * Shared service-token gate for batshit-server's HTTP API.
 *
 * Batshit-server is an internal service: every mutating/dispatching route is
 * reachable only with the shared service token (`BATSHIT_TOKEN`). Browser
 * features never call these routes directly — they go through session-authed
 * batshit-app proxy routes, which attach this token server-side. Public
 * exceptions are mounted explicitly in `src/index.js` (health checks and
 * read-only `/uploads/*` clip serving for AI providers).
 */

function tokenEquals(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function getConfiguredServiceToken() {
  return process.env.BATSHIT_TOKEN || process.env.MCP_GATEWAY_AUTH_TOKEN || '';
}

function hasValidServiceToken(req) {
  const configuredToken = getConfiguredServiceToken();
  const suppliedToken = req.get('x-batshit-service-token') || req.get('x-batshit-token');
  return tokenEquals(suppliedToken, configuredToken);
}

function requireServiceToken(req, res, next) {
  const configuredToken = getConfiguredServiceToken();
  if (!configuredToken) {
    return res.status(503).json({ error: 'Service token is not configured' });
  }
  if (!hasValidServiceToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = {
  tokenEquals,
  getConfiguredServiceToken,
  hasValidServiceToken,
  requireServiceToken,
};
