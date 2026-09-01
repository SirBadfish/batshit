import { env } from '$env/dynamic/private'
import type {
  CacheForensicsExportStatus,
  CacheForensicsRecord,
} from '$lib/types/cacheForensics'

/**
 * SA-093 P3: Batshit-authored OTLP/HTTP JSON exporter (validated "Path A").
 *
 * Zero dependencies: one span shape POSTed with plain fetch to an OTLP traces
 * endpoint (proven against disposable Langfuse v4: /api/public/otel/v1/traces
 * with Basic project-key auth). Spans carry ONLY allow-listed attributes built
 * from the forensic record — hashes, counts, states, and the plain model id.
 * Raw prompts/headers/tool payloads cannot appear because the record never
 * contains them (DL-093-04/05/06), and labels are additionally stripped of
 * their name suffixes before export.
 *
 * Referenced OTel GenAI semconv names (Development stability, moved to the
 * dedicated GenAI conventions repo at semconv v1.42.0, 2026-06-12):
 * `gen_ai.usage.input_tokens`, `gen_ai.usage.cache_read_tokens`,
 * `gen_ai.usage.cache_creation_tokens`. Batshit-namespaced attributes carry
 * the versioned divergence record itself.
 */

const EXPORT_TIMEOUT_MS = 5_000
const MAX_ATTRIBUTE_STRING_CHARS = 256

export interface CacheForensicsExportConfig {
  url: string
  authHeader: string | null
  destinationClass: 'loopback-otlp' | 'remote-otlp'
}

export type CacheForensicsExportConfigResult =
  | { state: 'disabled' }
  | { state: 'blocked'; reason: string }
  | { state: 'ready'; config: CacheForensicsExportConfig }

function isLoopbackUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase()
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === 'host.docker.internal'
  )
}

/**
 * Server-only export configuration (DL-093-11 fail-visible posture):
 * - no URL → exporting is disabled (the normal state);
 * - a non-loopback URL without BATSHIT_CACHE_FORENSICS_OTLP_ALLOW_REMOTE=1 →
 *   blocked with a visible reason, never silently exported;
 * - credentials never appear in logs or records — only the destination class.
 */
export function resolveCacheForensicsExportConfig(): CacheForensicsExportConfigResult {
  const url = (env.BATSHIT_CACHE_FORENSICS_OTLP_URL || '').trim()
  if (!url) return { state: 'disabled' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { state: 'blocked', reason: 'BATSHIT_CACHE_FORENSICS_OTLP_URL is not a valid URL.' }
  }

  const loopback = isLoopbackUrl(parsed)
  const allowRemote = (env.BATSHIT_CACHE_FORENSICS_OTLP_ALLOW_REMOTE || '').trim() === '1'
  if (!loopback && !allowRemote) {
    return {
      state: 'blocked',
      reason:
        'The OTLP endpoint is not loopback and BATSHIT_CACHE_FORENSICS_OTLP_ALLOW_REMOTE=1 was not set.',
    }
  }

  const auth = (env.BATSHIT_CACHE_FORENSICS_OTLP_AUTH || '').trim()
  const authHeader = auth
    ? `Basic ${Buffer.from(auth, 'utf8').toString('base64')}`
    : null

  return {
    state: 'ready',
    config: {
      url,
      authHeader,
      destinationClass: loopback ? 'loopback-otlp' : 'remote-otlp',
    },
  }
}

type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }

interface OtlpAttribute {
  key: string
  value: OtlpAttributeValue
}

function stringAttribute(key: string, value: string): OtlpAttribute {
  return {
    key,
    value: { stringValue: value.slice(0, MAX_ATTRIBUTE_STRING_CHARS) },
  }
}

function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.round(value)) } }
}

function boolAttribute(key: string, value: boolean): OtlpAttribute {
  return { key, value: { boolValue: value } }
}

/** Strips the name suffix from a segment label: `body.tools[2]:my_tool` → `body.tools[2]`. */
export function genericizeLabelForExport(label: string): string {
  const colonIndex = label.indexOf(':')
  return colonIndex === -1 ? label : label.slice(0, colonIndex)
}

function nanosecondsFromIso(iso: string): string {
  const millis = Date.parse(iso)
  const safeMillis = Number.isFinite(millis) ? millis : 0
  return `${safeMillis}000000`
}

function spanForRecord(record: CacheForensicsRecord, traceId: string): Record<string, unknown> {
  const attributes: OtlpAttribute[] = [
    intAttribute('batshit.forensics.schema_version', record.schemaVersion),
    stringAttribute('batshit.forensics.runtime', record.runtime),
    stringAttribute('batshit.forensics.boundary', record.boundary),
    stringAttribute('batshit.forensics.confidence', record.confidence),
    stringAttribute('batshit.forensics.comparison_id', record.comparisonId),
    intAttribute('batshit.forensics.segments_count', record.segments.length),
  ]

  if (record.modelId) {
    attributes.push(stringAttribute('batshit.forensics.model_id', record.modelId))
  }
  if (record.runId) {
    attributes.push(stringAttribute('batshit.forensics.run_id', record.runId))
  }
  if (record.baselineRunId) {
    attributes.push(stringAttribute('batshit.forensics.baseline_run_id', record.baselineRunId))
  }
  if (typeof record.callIndex === 'number') {
    attributes.push(intAttribute('batshit.forensics.call_index', record.callIndex))
  }
  if (record.intraRunComparison) {
    attributes.push(boolAttribute('batshit.forensics.intra_run', true))
  }
  if (record.actor === 'subagent') {
    attributes.push(stringAttribute('batshit.forensics.actor', 'subagent'))
  }
  if (record.parentRunId) {
    attributes.push(stringAttribute('batshit.forensics.parent_run_id', record.parentRunId))
  }
  if (record.experimentGroup) {
    attributes.push(stringAttribute('batshit.forensics.experiment_group', record.experimentGroup))
  }
  if (typeof record.segmentsTruncated === 'number') {
    attributes.push(intAttribute('batshit.forensics.segments_truncated', record.segmentsTruncated))
  }

  const divergence = record.divergence
  if (divergence) {
    attributes.push(stringAttribute('batshit.forensics.divergence_state', divergence.state))
    if (divergence.firstDivergence) {
      attributes.push(
        stringAttribute('batshit.forensics.divergence_kind', divergence.firstDivergence.kind),
        intAttribute('batshit.forensics.divergence_index', divergence.firstDivergence.index),
        stringAttribute(
          'batshit.forensics.divergence_label',
          genericizeLabelForExport(divergence.firstDivergence.label),
        ),
      )
    }
    if (typeof divergence.reusablePrefixSegments === 'number') {
      attributes.push(
        intAttribute('batshit.forensics.reusable_prefix_segments', divergence.reusablePrefixSegments),
      )
    }
    if (typeof divergence.reusablePrefixBytes === 'number') {
      attributes.push(
        intAttribute('batshit.forensics.reusable_prefix_bytes', divergence.reusablePrefixBytes),
      )
    }
    if (typeof divergence.reusablePrefixTokensEstimate === 'number') {
      attributes.push(
        intAttribute(
          'batshit.forensics.reusable_prefix_tokens_estimate',
          divergence.reusablePrefixTokensEstimate,
        ),
      )
    }
  }

  const cacheUsage = record.providerCacheUsage
  if (cacheUsage) {
    if (typeof cacheUsage.inputTokens === 'number') {
      attributes.push(intAttribute('gen_ai.usage.input_tokens', cacheUsage.inputTokens))
    }
    if (typeof cacheUsage.cachedInputTokens === 'number') {
      attributes.push(intAttribute('gen_ai.usage.cache_read_tokens', cacheUsage.cachedInputTokens))
    }
    if (typeof cacheUsage.cacheCreationInputTokens === 'number') {
      attributes.push(
        intAttribute('gen_ai.usage.cache_creation_tokens', cacheUsage.cacheCreationInputTokens),
      )
    }
  }

  const startNs = nanosecondsFromIso(record.capturedAt)

  return {
    traceId,
    // The pseudonymous per-call runId is 64 hex chars; the first 16 form a
    // valid, deterministic, non-reversible span id.
    spanId: (record.runId ?? '0'.repeat(64)).slice(0, 16),
    name: 'batshit.cache_forensics.call',
    kind: 1,
    startTimeUnixNano: startNs,
    endTimeUnixNano: startNs,
    attributes,
  }
}

/** Pure payload builder (unit-tested): one trace per run, one span per call. */
export function buildOtlpPayload(records: CacheForensicsRecord[]): Record<string, unknown> {
  // All calls of one send share a trace derived from the first call's runId.
  const traceId = (records[0]?.runId ?? '0'.repeat(64)).slice(0, 32)

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [stringAttribute('service.name', 'batshit-cache-forensics')],
        },
        scopeSpans: [
          {
            scope: { name: 'batshit.cache-forensics', version: '1' },
            spans: records.map((record) => spanForRecord(record, traceId)),
          },
        ],
      },
    ],
  }
}

/**
 * Exports a run's records. Returns the status to stamp on the records —
 * NEVER throws, never retries, never alters the model send (DL-093-11).
 */
export async function exportCacheForensicsRecords(
  records: CacheForensicsRecord[],
  fetchImpl: typeof fetch = fetch,
): Promise<CacheForensicsExportStatus> {
  const configResult = resolveCacheForensicsExportConfig()
  if (configResult.state === 'disabled') return { state: 'disabled' }
  if (configResult.state === 'blocked') {
    return { state: 'failed', error: configResult.reason }
  }

  const { config } = configResult

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS)
    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.authHeader ? { Authorization: config.authHeader } : {}),
        },
        body: JSON.stringify(buildOtlpPayload(records)),
        signal: controller.signal,
      })

      if (!response.ok) {
        return {
          state: 'failed',
          error: `OTLP endpoint responded with HTTP ${response.status}.`,
          destinationClass: config.destinationClass,
        }
      }

      return { state: 'exported', destinationClass: config.destinationClass }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return {
      state: 'failed',
      error:
        error instanceof Error && error.name === 'AbortError'
          ? `OTLP export timed out after ${EXPORT_TIMEOUT_MS} ms.`
          : `OTLP export failed: ${error instanceof Error ? error.message : String(error)}`,
      destinationClass: config.destinationClass,
    }
  }
}
