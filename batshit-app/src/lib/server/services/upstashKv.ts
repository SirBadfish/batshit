import { getRuntimeEnv, requireRuntimeEnv } from '$lib/server/services/runtimeEnv'

type UpstashReadOptions = {
  allowWriteTokenFallback?: boolean
  required?: boolean
  timeoutMs?: number
}

type UpstashWriteOptions = {
  timeoutMs?: number
}

async function getBaseUrl(required: boolean): Promise<string | null> {
  if (required) return await requireRuntimeEnv('KV_REST_API_URL')
  const value = (await getRuntimeEnv('KV_REST_API_URL'))?.trim()
  return value || null
}

async function getReadToken(options: UpstashReadOptions): Promise<string | null> {
  const readOnlyToken = (await getRuntimeEnv('KV_REST_API_READ_ONLY_TOKEN'))?.trim()
  if (readOnlyToken) return readOnlyToken

  if (options.allowWriteTokenFallback !== false) {
    const writeToken = (await getRuntimeEnv('KV_REST_API_TOKEN'))?.trim()
    if (writeToken) return writeToken
  }

  if (options.required !== false) {
    throw new Error('KV_REST_API_READ_ONLY_TOKEN not configured')
  }
  return null
}

async function getWriteToken(): Promise<string> {
  const value = (await getRuntimeEnv('KV_REST_API_TOKEN'))?.trim()
  if (!value) throw new Error('KV_REST_API_TOKEN not configured')
  return value
}

function maybeParseJson<T>(value: unknown): T {
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return value as T
  }
}

export async function upstashKvGet<T>(
  key: string,
  options: UpstashReadOptions = {}
): Promise<T | null> {
  const required = options.required !== false
  const [baseUrl, token] = await Promise.all([
    getBaseUrl(required),
    getReadToken(options)
  ])

  if (!baseUrl || !token) return null

  const response = await fetch(`${baseUrl}/get/${key}`, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text ? `Upstash read failed (${response.status}): ${text}` : `Upstash read failed (${response.status})`)
  }

  const payload = await response.json()
  const value = payload?.result
  if (value === null || value === undefined) return null
  return maybeParseJson<T>(value)
}

export async function upstashKvSet(
  key: string,
  value: unknown,
  options: UpstashWriteOptions = {}
): Promise<void> {
  const [baseUrl, token] = await Promise.all([getBaseUrl(true), getWriteToken()])

  const response = await fetch(`${baseUrl}/set/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(value),
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text ? `Upstash write failed (${response.status}): ${text}` : `Upstash write failed (${response.status})`)
  }
}
