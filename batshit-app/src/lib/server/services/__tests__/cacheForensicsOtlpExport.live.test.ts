import { afterAll, describe, expect, it } from 'vitest'
import { env } from '$env/dynamic/private'
import {
  exportCacheForensicsRecords,
} from '$lib/server/services/cacheForensics/otlpExport'
import { captureCacheForensicsRecord } from '$lib/server/services/cacheForensics/record'

/**
 * SA-093 P3 live proof against the disposable local Langfuse stack.
 *
 * Deliberate-run only (house `*.live.test.ts` pattern):
 *   BATSHIT_LIVE_FORENSICS=1 \
 *   BATSHIT_FORENSICS_LANGFUSE_AUTH="pk-lf-...:sk-lf-..." \
 *   npx vitest run src/lib/server/services/__tests__/cacheForensicsOtlpExport.live.test.ts
 *
 * Requires `docker compose -p batshit-cache-forensics up -d` from
 * `_local/cache-forensics/langfuse/` (web on 127.0.0.1:5700). Never enable in CI.
 */

const LIVE = process.env.BATSHIT_LIVE_FORENSICS === '1'
const LANGFUSE_BASE = 'http://127.0.0.1:5700'
const AUTH_PAIR = process.env.BATSHIT_FORENSICS_LANGFUSE_AUTH || ''

describe.runIf(LIVE)('cacheForensics OTLP live proof (disposable Langfuse)', () => {
  const previousUrl = env.BATSHIT_CACHE_FORENSICS_OTLP_URL
  const previousAuth = env.BATSHIT_CACHE_FORENSICS_OTLP_AUTH

  afterAll(() => {
    ;(env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS_OTLP_URL =
      previousUrl
    ;(env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS_OTLP_AUTH =
      previousAuth
  })

  it('exports a real record and finds its span via the v2 Observations API, canary-free', async () => {
    expect(AUTH_PAIR, 'BATSHIT_FORENSICS_LANGFUSE_AUTH must hold pk:sk').toContain(':')

    ;(env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS_OTLP_URL =
      `${LANGFUSE_BASE}/api/public/otel/v1/traces`
    ;(env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS_OTLP_AUTH =
      AUTH_PAIR

    const marker = `live-${Date.now()}`
    const record = captureCacheForensicsRecord({
      runtime: 'vercel',
      boundary: 'provider-request',
      confidence: 'exact',
      agentId: 'BATSHIT-CANARY-LIVE-AGENT',
      connectionId: 'conn-live',
      modelId: `claude-sonnet-4-6-${marker}`,
      runId: `BATSHIT-CANARY-LIVE-RUN-${marker}`,
      segments: [
        {
          type: 'system-prompt',
          label: 'body.system[0]:text',
          content: `BATSHIT-CANARY-LIVE-PROMPT ${marker}`,
        },
      ],
    })
    record.callIndex = 1
    record.providerCacheUsage = { inputTokens: 5000, cachedInputTokens: 4200, source: 'provider' }
    record.divergence = {
      state: 'no-divergence',
      reusablePrefixSegments: 1,
      reusablePrefixBytes: 64,
    }

    const status = await exportCacheForensicsRecords([record])
    expect(status.state).toBe('exported')

    // The exporter derives trace/span ids from the pseudonymous runId, so the
    // ingested span is matchable deterministically (v2 list rows are
    // summaries without attributes; attribute-level proof is the ClickHouse
    // storage scan recorded in the story).
    const expectedTraceId = record.runId!.slice(0, 32)

    const authHeader = `Basic ${Buffer.from(AUTH_PAIR).toString('base64')}`
    let found: any = null
    for (let attempt = 0; attempt < 15 && !found; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const response = await fetch(`${LANGFUSE_BASE}/api/public/v2/observations?limit=50`, {
        headers: { Authorization: authHeader },
      })
      expect(response.ok).toBe(true)
      const body = (await response.json()) as { data?: any[] }
      found =
        body.data?.find(
          (observation) =>
            observation?.name === 'batshit.cache_forensics.call' &&
            observation?.traceId === expectedTraceId,
        ) ?? null
    }

    expect(found, 'exported span should appear in Langfuse v2 observations').toBeTruthy()
    expect(JSON.stringify(found)).not.toContain('CANARY')
  }, 60_000)
})
