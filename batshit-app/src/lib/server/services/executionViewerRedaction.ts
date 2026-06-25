const SENSITIVE_HEADER_KEYS = new Set([
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
  'x-batshit-internal-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-session-token',
  'x-csrf-token',
  'x-csrftoken',
  'x-mcp-gateway-auth-token'
])

const SENSITIVE_BODY_KEYS = new Set([
  'batshit_sse_callback_token',
  'batshitSseCallbackToken',
  'batshit_native_tool_token',
  'batshitNativeToolToken',
  'batshit_native_tool_header',
  'batshitNativeToolHeader',
  'batshit_sse_callback_header',
  'batshitSseCallbackHeader',
  'batshit_sse_callback_expires_at',
  'batshitSseCallbackExpiresAt',
  'sse_callback_token',
  'sseCallbackToken',
  'callback_token',
  'callbackToken',
  'callback_auth_token',
  'callbackAuthToken'
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

function shouldRedactBodyKey(key: string): boolean {
  if (SENSITIVE_BODY_KEYS.has(key)) return true
  const normalized = key.trim().toLowerCase()

  if (normalized.includes('callback') && normalized.includes('token')) return true
  if (normalized.includes('secret')) return true
  if (normalized.includes('password')) return true

  return false
}

export function redactWebhookBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body

  if (Array.isArray(body)) {
    return body.map((item) => redactWebhookBody(item))
  }

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (shouldRedactBodyKey(key)) {
      output[key] = '[REDACTED]'
      continue
    }
    output[key] = redactWebhookBody(value)
  }
  return output
}

export function redactWebhookStyleInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input

  return input.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const record = entry as Record<string, unknown>
    return {
      ...record,
      headers: redactHeaders(record.headers),
      body: redactWebhookBody(record.body)
    }
  })
}
