import crypto from 'crypto'
import { error, type RequestEvent } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

const TOKEN_PREFIX = 'art_rt_'
const TOKEN_TTL_SECONDS = 6 * 60 * 60
const MAX_STORAGE_KEY_CHARS = 120
const MAX_STORAGE_VALUE_BYTES = 200_000
const MAX_STORAGE_TOTAL_BYTES = 1_000_000

export interface ArtifactRuntimeClaims {
  token: string
  userId: string
  artifactId: string
  sessionId: string | null
  createdAt: string
  expiresAt: string
}

interface CreateArtifactRuntimeTokenOptions {
  userId: string
  artifactId: string
  sessionId?: string | null
}

function tokenKey(token: string) {
  return `artifact_runtime_token:${token}`
}

function storageKey(userId: string, artifactId: string) {
  return `artifact_runtime_storage:${userId}:${artifactId}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')?.trim()
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() || null
}

function assertRuntimeTokenFormat(token: string) {
  if (!token.startsWith(TOKEN_PREFIX) || token.length !== TOKEN_PREFIX.length + 64) {
    throw error(401, 'Invalid artifact runtime token')
  }
}

function normalizeStorageKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw error(400, 'Storage key must be a string')
  }

  const normalized = value.trim()
  if (!normalized) {
    throw error(400, 'Storage key is required')
  }
  if (normalized.length > MAX_STORAGE_KEY_CHARS) {
    throw error(413, 'Storage key is too long')
  }
  if (!/^[a-zA-Z0-9_.:-]+$/.test(normalized)) {
    throw error(400, 'Storage key contains unsupported characters')
  }
  return normalized
}

function assertStorageValueSize(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized.length > MAX_STORAGE_VALUE_BYTES) {
    throw error(413, 'Artifact storage value is too large')
  }
}

function assertStorageTotalSize(snapshot: Record<string, unknown>) {
  const serialized = JSON.stringify(snapshot)
  if (serialized.length > MAX_STORAGE_TOTAL_BYTES) {
    throw error(413, 'Artifact storage is too large')
  }
}

export function isOpaqueArtifactRuntimeRequest(request: Request) {
  return request.headers.get('origin') === 'null'
}

export function isArtifactRuntimeCorsPath(path: string) {
  if (
    path === '/api/artifacts/complete' ||
    path === '/api/artifacts/env' ||
    path === '/api/artifacts/run-event' ||
    path === '/api/artifacts/share' ||
    path === '/api/artifacts/clip-sources' ||
    path === '/api/artifacts/storage'
  ) {
    return true
  }

  if (path === '/api/artifacts/comfyui' || path.startsWith('/api/artifacts/comfyui/')) {
    return true
  }

  return /^\/api\/artifacts\/[^/]+$/.test(path)
}

export function artifactRuntimeCorsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  }
}

export function shouldApplyArtifactRuntimeCors(event: RequestEvent) {
  return (
    isArtifactRuntimeCorsPath(event.url.pathname) &&
    isOpaqueArtifactRuntimeRequest(event.request)
  )
}

export function appendArtifactRuntimeCors(event: RequestEvent, response: Response) {
  if (!shouldApplyArtifactRuntimeCors(event)) return response

  const headers = new Headers(response.headers)
  const corsHeaders = artifactRuntimeCorsHeaders()
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value)
  }
  headers.delete('Access-Control-Allow-Credentials')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export async function createArtifactRuntimeToken({
  userId,
  artifactId,
  sessionId = null
}: CreateArtifactRuntimeTokenOptions): Promise<string> {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`
  const now = Date.now()
  const claims: ArtifactRuntimeClaims = {
    token,
    userId,
    artifactId,
    sessionId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_SECONDS * 1000).toISOString()
  }

  await redis.set(tokenKey(token), claims)
  await redis.expire(tokenKey(token), TOKEN_TTL_SECONDS)
  return token
}

export async function resolveArtifactRuntimeClaims(
  request: Request,
  expectedArtifactId?: string | null
): Promise<ArtifactRuntimeClaims | null> {
  const token = readBearerToken(request)
  if (!token) return null

  assertRuntimeTokenFormat(token)
  const claims = (await redis.get(tokenKey(token))) as ArtifactRuntimeClaims | null
  if (!claims || !isPlainRecord(claims)) {
    throw error(401, 'Artifact runtime token expired')
  }

  if (new Date(claims.expiresAt).getTime() <= Date.now()) {
    await redis.del(tokenKey(token)).catch(() => {})
    throw error(401, 'Artifact runtime token expired')
  }

  if (expectedArtifactId && claims.artifactId !== expectedArtifactId) {
    throw error(403, 'Artifact runtime token does not match artifact')
  }

  return claims
}

export async function requireArtifactRuntimeClaims(
  request: Request,
  expectedArtifactId?: string | null
) {
  const claims = await resolveArtifactRuntimeClaims(request, expectedArtifactId)
  if (!claims) {
    throw error(401, 'Artifact runtime token is required')
  }
  return claims
}

export async function getArtifactRuntimeStorageSnapshot(
  userId: string,
  artifactId: string
): Promise<Record<string, unknown>> {
  const snapshot = await redis.get(storageKey(userId, artifactId))
  return isPlainRecord(snapshot) ? snapshot : {}
}

export async function updateArtifactRuntimeStorage(options: {
  userId: string
  artifactId: string
  operation: 'set' | 'remove' | 'clear'
  key?: unknown
  value?: unknown
}) {
  const current = await getArtifactRuntimeStorageSnapshot(options.userId, options.artifactId)

  if (options.operation === 'clear') {
    await redis.del(storageKey(options.userId, options.artifactId))
    return {}
  }

  const key = normalizeStorageKey(options.key)

  if (options.operation === 'remove') {
    delete current[key]
    if (Object.keys(current).length === 0) {
      await redis.del(storageKey(options.userId, options.artifactId))
      return {}
    }
    await redis.set(storageKey(options.userId, options.artifactId), current)
    return current
  }

  assertStorageValueSize(options.value)
  current[key] = options.value
  assertStorageTotalSize(current)
  await redis.set(storageKey(options.userId, options.artifactId), current)
  return current
}
