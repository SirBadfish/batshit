import crypto from 'crypto'
import { building } from '$app/environment'
import { env } from '$env/dynamic/private'
import {
  CACHE_FORENSICS_SCHEMA_VERSION,
  type CacheForensicsBoundary,
  type CacheForensicsConfidence,
  type CacheForensicsRuntime,
  type CacheForensicsSegment,
  type CacheForensicsSegmentType,
} from '$lib/types/cacheForensics'

/**
 * SA-093 fingerprint engine (P1).
 *
 * Deterministic, bounded, non-lossy-for-order serialization + full HMAC-SHA-256
 * fingerprints for ordered request segments (DL-093-05/06). The canonical
 * serialization is hashed and discarded — it is never stored or exported.
 */

// Historical placeholder value — same recognition rule as encryption.server.ts
// so a stale .env fails loudly here too instead of keying HMACs publicly.
const LEGACY_PLACEHOLDER_KEY = 'CHANGE-THIS-IN-PRODUCTION-32CHR'

const HKDF_INFO = 'batshit-cache-forensics-v1'

/** Bounds (DL-093-06): the record stays small by construction. */
export const CACHE_FORENSICS_MAX_SEGMENTS = 512
export const CACHE_FORENSICS_MAX_LABEL_CHARS = 160
const MAX_SERIALIZATION_DEPTH = 64

export class CacheForensicsCaptureError extends Error {
  readonly code:
    | 'KEY_UNAVAILABLE'
    | 'CIRCULAR_REFERENCE'
    | 'UNSERIALIZABLE_VALUE'
    | 'DEPTH_EXCEEDED'

  constructor(code: CacheForensicsCaptureError['code'], message: string) {
    super(message)
    this.name = 'CacheForensicsCaptureError'
    this.code = code
  }
}

function isUnsafePlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized === LEGACY_PLACEHOLDER_KEY.toLowerCase() ||
    normalized.startsWith('replace-with-')
  )
}

let cachedKey: Buffer | null = null

/**
 * Derives the domain-separated forensics HMAC key from ENCRYPTION_KEY
 * (house pattern: HKDF-SHA-256, own info string). The derived key is held in
 * module memory only — never stored, logged, or exported (DL-093-05).
 *
 * Missing/placeholder keys throw CacheForensicsCaptureError('KEY_UNAVAILABLE');
 * callers map that to a loud `capture-failed` record while the model send
 * proceeds untouched (DL-093-11).
 */
export function resolveCacheForensicsKey(): Buffer {
  if (cachedKey) return cachedKey

  const raw = (env.ENCRYPTION_KEY || '').trim()

  // `vite build` loads server modules without runtime env; nothing is
  // fingerprinted at build time.
  if (building) {
    return Buffer.from(
      crypto.hkdfSync('sha256', raw || 'batshit-buildtime-placeholder-key-32', '', HKDF_INFO, 32),
    )
  }

  if (!raw || isUnsafePlaceholderSecret(raw) || raw.length < 32) {
    throw new CacheForensicsCaptureError(
      'KEY_UNAVAILABLE',
      'ENCRYPTION_KEY is missing or a placeholder, so cache-forensics fingerprints cannot be keyed. ' +
        'Launch Batshit through your normal install path once to generate it.',
    )
  }

  cachedKey = Buffer.from(crypto.hkdfSync('sha256', raw, '', HKDF_INFO, 32))
  return cachedKey
}

/** Test seam: clears the memoized derived key (used when env changes per test). */
export function __resetCacheForensicsKeyForTests(): void {
  cachedKey = null
}

/**
 * Canonical deterministic serialization:
 * - object keys sorted lexicographically; entries with `undefined` values omitted
 * - array order preserved exactly; `undefined`/unserializable entries become null markers
 * - strings/booleans/finite numbers as JSON; non-finite numbers as tagged markers
 * - bigint/Date/binary as tagged markers (`{"__bigint"|"__date"|"__bytes"}`)
 * - functions/symbols rejected loudly; circular references rejected loudly
 *
 * The output feeds the HMAC and is then discarded.
 */
export function canonicalSerialize(value: unknown): string {
  const seen = new WeakSet<object>()

  const visit = (node: unknown, depth: number): string => {
    if (depth > MAX_SERIALIZATION_DEPTH) {
      throw new CacheForensicsCaptureError(
        'DEPTH_EXCEEDED',
        `Serialization exceeded the maximum depth of ${MAX_SERIALIZATION_DEPTH}.`,
      )
    }

    if (node === null) return 'null'
    if (node === undefined) return '{"__undefined":true}'

    switch (typeof node) {
      case 'string':
        return JSON.stringify(node)
      case 'boolean':
        return node ? 'true' : 'false'
      case 'number':
        return Number.isFinite(node)
          ? JSON.stringify(node)
          : `{"__nonfinite":${JSON.stringify(String(node))}}`
      case 'bigint':
        return `{"__bigint":${JSON.stringify(node.toString())}}`
      case 'function':
      case 'symbol':
        throw new CacheForensicsCaptureError(
          'UNSERIALIZABLE_VALUE',
          `Cannot canonically serialize a ${typeof node} value.`,
        )
    }

    const objectNode = node as object

    if (seen.has(objectNode)) {
      throw new CacheForensicsCaptureError(
        'CIRCULAR_REFERENCE',
        'Circular reference encountered during canonical serialization.',
      )
    }

    if (objectNode instanceof Date) {
      const time = objectNode.getTime()
      return Number.isFinite(time)
        ? `{"__date":${JSON.stringify(objectNode.toISOString())}}`
        : '{"__date":"invalid"}'
    }

    if (Buffer.isBuffer(objectNode)) {
      return `{"__bytes":${JSON.stringify(objectNode.toString('base64'))}}`
    }

    if (ArrayBuffer.isView(objectNode)) {
      const view = objectNode as ArrayBufferView
      const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
      return `{"__bytes":${JSON.stringify(bytes.toString('base64'))}}`
    }

    if (objectNode instanceof ArrayBuffer) {
      return `{"__bytes":${JSON.stringify(Buffer.from(objectNode).toString('base64'))}}`
    }

    seen.add(objectNode)
    try {
      if (Array.isArray(objectNode)) {
        const parts = objectNode.map((entry) => visit(entry, depth + 1))
        return `[${parts.join(',')}]`
      }

      const entries = Object.entries(objectNode as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(
          ([entryKey, entryValue]) =>
            `${JSON.stringify(entryKey)}:${visit(entryValue, depth + 1)}`,
        )
      return `{${entries.join(',')}}`
    } finally {
      seen.delete(objectNode)
    }
  }

  return visit(value, 0)
}

function hmacHex(key: Buffer, value: string): string {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest('hex')
}

function clampLabel(label: string): string {
  const trimmed = label.trim()
  return trimmed.length <= CACHE_FORENSICS_MAX_LABEL_CHARS
    ? trimmed
    : `${trimmed.slice(0, CACHE_FORENSICS_MAX_LABEL_CHARS - 1)}…`
}

export interface CacheForensicsSegmentInput {
  type: CacheForensicsSegmentType
  label: string
  content: unknown
  tokensEstimate?: number
  confidence?: CacheForensicsConfidence
}

export interface FingerprintSegmentsResult {
  segments: CacheForensicsSegment[]
  /** Segments dropped by the CACHE_FORENSICS_MAX_SEGMENTS bound. */
  truncated: number
}

/**
 * Fingerprints ordered segment inputs into the stored contract shape.
 * Throws CacheForensicsCaptureError on unserializable/circular input — callers
 * convert that into an explicit `capture-failed` record, never a silent skip.
 */
export function fingerprintSegments(
  key: Buffer,
  inputs: CacheForensicsSegmentInput[],
): FingerprintSegmentsResult {
  const bounded = inputs.slice(0, CACHE_FORENSICS_MAX_SEGMENTS)

  const segments = bounded.map((input, index): CacheForensicsSegment => {
    const canonical = canonicalSerialize(input.content)
    const segment: CacheForensicsSegment = {
      index,
      type: input.type,
      label: clampLabel(input.label),
      hmac: hmacHex(key, canonical),
      bytes: Buffer.byteLength(canonical, 'utf8'),
      chars: canonical.length,
      confidence: input.confidence ?? 'exact',
    }
    if (typeof input.tokensEstimate === 'number' && Number.isFinite(input.tokensEstimate)) {
      segment.tokensEstimate = Math.max(0, Math.round(input.tokensEstimate))
    }
    return segment
  })

  return { segments, truncated: Math.max(0, inputs.length - bounded.length) }
}

/**
 * Pseudonymous comparison identity (DL-093-09): equal ids mean same runtime,
 * agent, provider/connection, model, boundary, schema, and experiment group.
 * Raw identifiers never leave this function.
 */
export function buildComparisonId(
  key: Buffer,
  parts: {
    runtime: CacheForensicsRuntime
    boundary: CacheForensicsBoundary
    agentId: string | null | undefined
    connectionId: string | null | undefined
    modelId: string | null | undefined
    experimentGroup?: string | null
  },
): string {
  return hmacHex(
    key,
    [
      `v${CACHE_FORENSICS_SCHEMA_VERSION}`,
      parts.runtime,
      parts.boundary,
      parts.agentId ?? 'no-agent',
      parts.connectionId ?? 'no-connection',
      parts.modelId ?? 'no-model',
      parts.experimentGroup ?? 'no-experiment',
    ].join('|'),
  )
}

/** Pseudonymizes an internal identifier (session/run/experiment) for storage/export. */
export function pseudonymizeId(key: Buffer, kind: string, rawId: string): string {
  return hmacHex(key, `id|${kind}|${rawId}`)
}
