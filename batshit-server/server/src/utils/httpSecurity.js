const DEFAULT_TRUSTED_ORIGINS = [
  'http://localhost:5620',
  'http://127.0.0.1:5620',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://localhost:5620',
  'https://127.0.0.1:5620',
];

function parseOriginList(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== '*');
}

function getTrustedOrigins() {
  return new Set([
    ...DEFAULT_TRUSTED_ORIGINS,
    ...parseOriginList(process.env.BATSHIT_FRONTEND_URL),
    ...parseOriginList(process.env.BATSHIT_TRUSTED_ORIGINS),
    ...parseOriginList(process.env.CORS_ORIGIN),
  ]);
}

function isTrustedOrigin(origin) {
  if (!origin) return true;
  return getTrustedOrigins().has(origin);
}

function corsOriginDelegate(origin, callback) {
  if (isTrustedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(null, false);
}

function enforceTrustedOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }

  if (isTrustedOrigin(origin)) {
    next();
    return;
  }

  res.status(403).json({ error: 'Origin is not trusted' });
}

function getTrustedCorsOriginForRequest(req) {
  const origin = req.get('origin');
  return origin && isTrustedOrigin(origin) ? origin : null;
}

module.exports = {
  corsOriginDelegate,
  enforceTrustedOrigin,
  getTrustedCorsOriginForRequest,
  getTrustedOrigins,
  isTrustedOrigin,
};
