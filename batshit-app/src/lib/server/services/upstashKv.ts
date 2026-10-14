import { randomUUID } from 'node:crypto'
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

  const payload: unknown = await response.json()
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, 'result') ||
    (Object.prototype.hasOwnProperty.call(payload, 'error') &&
      (payload as { error?: unknown }).error != null)
  ) {
    throw new Error('Upstash read failed: malformed response envelope')
  }
  const value = (payload as { result?: unknown }).result
  if (value === undefined) {
    throw new Error('Upstash read failed: missing result value')
  }
  if (value === null) return null
  const parsed = maybeParseJson<T>(value)
  if (parsed === null) {
    throw new Error('Upstash read failed: stored value resolved to null')
  }
  return parsed
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

/**
 * Runs one Redis command through Upstash's REST API: the command and its
 * arguments POSTed as a JSON array to the base URL (Upstash REST API docs,
 * "POST with JSON array body"). Returns the command's `result`.
 */
export async function upstashKvCommand<T>(
  command: Array<string | number>,
  options: UpstashWriteOptions = {}
): Promise<T | null> {
  const [baseUrl, token] = await Promise.all([getBaseUrl(true), getWriteToken()])

  const response = await fetch(`${baseUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command.map(String)),
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      text
        ? `Upstash ${String(command[0])} failed (${response.status}): ${text}`
        : `Upstash ${String(command[0])} failed (${response.status})`
    )
  }

  const payload = await response.json()
  if (payload?.error) throw new Error(`Upstash ${String(command[0])} failed: ${payload.error}`)
  return (payload?.result ?? null) as T | null
}

/** Deletes KEYS[1] only while it still holds ARGV[1], so a holder never frees a lock another took after its own expired. */
const RELEASE_LOCK_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"

type UpstashLockOptions = {
  /** How long the lock lives if its holder never releases it (a crash). */
  ttlMs?: number
  /** The time limit on each lock request (take, release). */
  requestTimeoutMs?: number
  /** How long to wait for another holder before giving up with an error. */
  waitMs?: number
  /** Pause between tries. */
  retryMs?: number
}

/**
 * BL-295: runs `task` while holding `lockKey`, for a read-modify-write of one
 * Upstash value that two server processes may run at once (two catalog sync
 * reports each rewriting the report index lost one entry). Takes the lock with
 * `SET key token NX PX ttl` and frees it with a compare-and-delete; waits for
 * another holder up to `waitMs`, then fails loudly instead of writing unguarded.
 * The task's own requests need their own time limits, well inside `ttlMs`, or a
 * stuck one outlasts the lock.
 */
export async function withUpstashKvLock<T>(
  lockKey: string,
  task: () => Promise<T>,
  options: UpstashLockOptions = {}
): Promise<T> {
  const ttlMs = options.ttlMs ?? 30_000
  const waitMs = options.waitMs ?? 35_000
  const retryMs = options.retryMs ?? 200
  const timeoutMs = options.requestTimeoutMs ?? 10_000
  const token = randomUUID()
  const deadline = Date.now() + waitMs

  while ((await upstashKvCommand<string>(['SET', lockKey, token, 'NX', 'PX', ttlMs], { timeoutMs })) !== 'OK') {
    if (Date.now() >= deadline) {
      throw new Error(`Upstash lock ${lockKey} is still held after ${waitMs} ms; nothing was written`)
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs))
  }

  try {
    return await task()
  } finally {
    // A release that fails leaves the lock to expire after ttlMs; the task's
    // own result or error stands.
    await upstashKvCommand(['EVAL', RELEASE_LOCK_SCRIPT, 1, lockKey, token], { timeoutMs }).catch((error) => {
      console.warn(`[upstash] Could not release lock ${lockKey}; it expires in ${ttlMs} ms:`, error)
    })
  }
}
