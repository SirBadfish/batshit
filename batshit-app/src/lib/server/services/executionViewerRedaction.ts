/**
 * Execution Viewer redaction.
 *
 * SA-106: the webhook-body/webhook-style-input helpers retired with the n8n Primary
 * lane's execution-log POST handler. `redactHeaders` stays — `executionViewerLlmCapture`
 * uses it on every captured provider response, so this remains a live security boundary.
 */

/**
 * Exported so a test can assert that a header is EXPLICITLY registered, not merely caught by
 * the conservative fallback below. SA-117 P1: `x-batshit-agent-token` is redacted either way,
 * so a test that only checked the output would pass even if the entry were deleted.
 */
export const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-n8n-api-key',
  'x-api-key',
  'api-key',
  'x-batshit-token',
  'x-batshit-service-token',
  'x-batshit-callback-token',
  'x-batshit-native-tool-token',
  // SA-117 P1 (DL-117-09). The `includes('token')` fallback below would already catch this
  // one, and it is listed anyway: the fallback is a net for headers nobody thought about, and
  // a credential Batshit itself mints and sends is not one of those. A rename to something
  // without "token" in it would silently start capturing a live secret.
  'x-batshit-agent-token',
  'x-batshit-internal-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-session-token',
  'x-csrf-token',
  'x-csrftoken',
  'x-mcp-gateway-auth-token'
])

function normalizeHeaderKey(key: string): string {
  return key.trim().toLowerCase()
}

function shouldRedactHeader(key: string): boolean {
  const normalized = normalizeHeaderKey(key)
  if (SENSITIVE_HEADER_KEYS.has(normalized)) return true

  // Be conservative: if the header name strongly implies credentials, redact it.
  if (normalized.includes('token')) return true
  if (normalized.includes('secret')) return true
  if (normalized.includes('password')) return true
  if (normalized.includes('api-key')) return true
  if (normalized.endsWith('apikey')) return true

  return false
}

export function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return headers
  }

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (shouldRedactHeader(key)) {
      output[key] = '[REDACTED]'
      continue
    }
    output[key] = value
  }
  return output
}
