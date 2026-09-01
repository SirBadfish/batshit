import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import {
  buildOtlpPayload,
  exportCacheForensicsRecords,
  genericizeLabelForExport,
  resolveCacheForensicsExportConfig,
} from '$lib/server/services/cacheForensics/otlpExport'
import { captureCacheForensicsRecord } from '$lib/server/services/cacheForensics/record'

const ENV_KEYS = [
  'BATSHIT_CACHE_FORENSICS_OTLP_URL',
  'BATSHIT_CACHE_FORENSICS_OTLP_AUTH',
  'BATSHIT_CACHE_FORENSICS_OTLP_ALLOW_REMOTE',
] as const

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  if (value === undefined) delete (env as Record<string, string | undefined>)[key]
  else (env as Record<string, string | undefined>)[key] = value
}

function canaryRecord() {
  const record = captureCacheForensicsRecord({
    runtime: 'vercel',
    boundary: 'provider-request',
    confidence: 'exact',
    agentId: 'BATSHIT-CANARY-AGENT',
    connectionId: 'conn-1',
    modelId: 'claude-sonnet-4-6',
    runId: 'BATSHIT-CANARY-RUN',
    experimentGroup: 'BATSHIT-CANARY-EXPERIMENT',
    segments: [
      {
        type: 'system-prompt',
        label: 'body.system[0]:text',
        content: 'BATSHIT-CANARY-PROMPT secret words',
      },
      {
        type: 'tool',
        label: 'body.tools[0]:my_private_tool_name',
        content: { apiKey: 'sk-BATSHIT-CANARY-KEY' },
      },
    ],
    capturedAt: '2026-08-30T05:00:00.000Z',
  })
  record.callIndex = 1
  record.providerCacheUsage = {
    inputTokens: 8000,
    cachedInputTokens: 6888,
    cacheCreationInputTokens: 112,
    source: 'provider',
  }
  record.divergence = {
    state: 'diverged',
    firstDivergence: { kind: 'changed', index: 1, label: 'body.tools[0]:my_private_tool_name' },
    reusablePrefixSegments: 1,
    reusablePrefixBytes: 120,
  }
  return record
}

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  'service.name',
  'batshit.forensics.schema_version',
  'batshit.forensics.runtime',
  'batshit.forensics.boundary',
  'batshit.forensics.confidence',
  'batshit.forensics.comparison_id',
  'batshit.forensics.segments_count',
  'batshit.forensics.segments_truncated',
  'batshit.forensics.model_id',
  'batshit.forensics.run_id',
  'batshit.forensics.baseline_run_id',
  'batshit.forensics.call_index',
  'batshit.forensics.intra_run',
  'batshit.forensics.actor',
  'batshit.forensics.parent_run_id',
  'batshit.forensics.experiment_group',
  'batshit.forensics.divergence_state',
  'batshit.forensics.divergence_kind',
  'batshit.forensics.divergence_index',
  'batshit.forensics.divergence_label',
  'batshit.forensics.reusable_prefix_segments',
  'batshit.forensics.reusable_prefix_bytes',
  'batshit.forensics.reusable_prefix_tokens_estimate',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.cache_read_tokens',
  'gen_ai.usage.cache_creation_tokens',
])

function collectAttributeKeys(payload: Record<string, any>): string[] {
  const keys: string[] = []
  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const attribute of resourceSpan.resource?.attributes ?? []) {
      keys.push(attribute.key)
    }
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        for (const attribute of span.attributes ?? []) {
          keys.push(attribute.key)
        }
      }
    }
  }
  return keys
}

describe('cacheForensics OTLP export (P3)', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) setEnv(key, undefined)
    vi.restoreAllMocks()
  })

  describe('resolveCacheForensicsExportConfig', () => {
    it('is disabled with no endpoint configured (the normal state)', () => {
      expect(resolveCacheForensicsExportConfig()).toEqual({ state: 'disabled' })
    })

    it('blocks invalid URLs and non-loopback endpoints without the explicit override', () => {
      setEnv('BATSHIT_CACHE_FORENSICS_OTLP_URL', 'not a url')
      expect(resolveCacheForensicsExportConfig().state).toBe('blocked')

      setEnv('BATSHIT_CACHE_FORENSICS_OTLP_URL', 'https://collector.example.test/v1/traces')
      const blocked = resolveCacheForensicsExportConfig()
      expect(blocked.state).toBe('blocked')
      expect((blocked as { reason: string }).reason).toContain('ALLOW_REMOTE')

      setEnv('BATSHIT_CACHE_FORENSICS_OTLP_ALLOW_REMOTE', '1')
      const allowed = resolveCacheForensicsExportConfig()
      expect(allowed.state).toBe('ready')
      expect((allowed as any).config.destinationClass).toBe('remote-otlp')
    })

    it('accepts loopback endpoints and encodes Basic auth from the key pair', () => {
      setEnv(
        'BATSHIT_CACHE_FORENSICS_OTLP_URL',
        'http://127.0.0.1:5700/api/public/otel/v1/traces',
      )
      setEnv('BATSHIT_CACHE_FORENSICS_OTLP_AUTH', 'pk-test:sk-test')
      const result = resolveCacheForensicsExportConfig()
      expect(result.state).toBe('ready')
      const config = (result as any).config
      expect(config.destinationClass).toBe('loopback-otlp')
      expect(config.authHeader).toBe(
        `Basic ${Buffer.from('pk-test:sk-test').toString('base64')}`,
      )
    })
  })

  describe('buildOtlpPayload', () => {
    it('emits only allow-listed attribute keys', () => {
      const payload = buildOtlpPayload([canaryRecord()])
      for (const key of collectAttributeKeys(payload)) {
        expect(ALLOWED_ATTRIBUTE_KEYS.has(key), `unexpected attribute key: ${key}`).toBe(true)
      }
    })

    it('never exports canary content, raw ids, or tool names', () => {
      const serialized = JSON.stringify(buildOtlpPayload([canaryRecord()]))
      expect(serialized).not.toContain('CANARY')
      expect(serialized).not.toContain('sk-')
      expect(serialized).not.toContain('my_private_tool_name')
      // The plain model id is deliberately allowed for grouping.
      expect(serialized).toContain('claude-sonnet-4-6')
    })

    it('derives deterministic trace/span ids from the pseudonymous run id', () => {
      const record = canaryRecord()
      const payload = buildOtlpPayload([record]) as any
      const span = payload.resourceSpans[0].scopeSpans[0].spans[0]
      expect(span.traceId).toBe(record.runId!.slice(0, 32))
      expect(span.spanId).toBe(record.runId!.slice(0, 16))
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
    })

    it('genericizes divergence labels by dropping the name suffix', () => {
      expect(genericizeLabelForExport('body.tools[0]:my_private_tool_name')).toBe(
        'body.tools[0]',
      )
      expect(genericizeLabelForExport('body.model')).toBe('body.model')
    })
  })

  describe('exportCacheForensicsRecords', () => {
    it('reports disabled without an endpoint and never calls fetch', async () => {
      const fetchSpy = vi.fn()
      const status = await exportCacheForensicsRecords([canaryRecord()], fetchSpy as any)
      expect(status).toEqual({ state: 'disabled' })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('exports to a loopback endpoint and reports the destination class', async () => {
      setEnv(
        'BATSHIT_CACHE_FORENSICS_OTLP_URL',
        'http://127.0.0.1:5700/api/public/otel/v1/traces',
      )
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      const status = await exportCacheForensicsRecords([canaryRecord()], fetchSpy as any)
      expect(status).toEqual({ state: 'exported', destinationClass: 'loopback-otlp' })
      expect(fetchSpy).toHaveBeenCalledOnce()
      const [, init] = fetchSpy.mock.calls[0]
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body).resourceSpans).toHaveLength(1)
    })

    it('reports visible failure states instead of throwing (DL-093-11)', async () => {
      setEnv(
        'BATSHIT_CACHE_FORENSICS_OTLP_URL',
        'http://127.0.0.1:5700/api/public/otel/v1/traces',
      )
      const badResponse = vi.fn().mockResolvedValue({ ok: false, status: 401 })
      const unauthorized = await exportCacheForensicsRecords(
        [canaryRecord()],
        badResponse as any,
      )
      expect(unauthorized.state).toBe('failed')
      expect(unauthorized.error).toContain('401')

      const network = vi.fn().mockRejectedValue(new Error('connection refused'))
      const failed = await exportCacheForensicsRecords([canaryRecord()], network as any)
      expect(failed.state).toBe('failed')
      expect(failed.error).toContain('connection refused')

      const blocked = await exportCacheForensicsRecords([canaryRecord()], vi.fn() as any)
      setEnv('BATSHIT_CACHE_FORENSICS_OTLP_URL', undefined)
      expect(blocked.state).not.toBe('exported')
    })
  })
})
