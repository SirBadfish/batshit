const MAX_LOG_VALUE_LENGTH = 8192;

function stringifyLogValue(value) {
  if (value instanceof Error) {
    return value.stack || value.message || value.name;
  }
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function sanitizeLogValue(value) {
  return stringifyLogValue(value)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .slice(0, MAX_LOG_VALUE_LENGTH);
}

function writeErrorLog(logger, context, error) {
  const safeContext = sanitizeLogValue(context);
  const safeError = sanitizeLogValue(error);
  logger.error(`${safeContext}: ${safeError}`);
}

module.exports = {
  sanitizeLogValue,
  writeErrorLog
};
