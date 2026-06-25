import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'

const REPORT_INDEX_KEY = 'catalog:reports:index:v1'
const WRITE_PROBE_KEY = 'catalog:reports:readiness-probe:v1'

export type ReadinessProbeResult = {
  ok: boolean
  statusCode?: number
  message?: string
}

export type ModelCatalogReadiness = {
  ready: boolean
  status: 'ready' | 'degraded'
  checkedAt: string
  warnings: string[]
  checks: {
    kvRestApiUrl: boolean
    kvWriteToken: boolean
    kvReadToken: boolean
    readTokenSource: 'read-only' | 'write-fallback' | 'missing'
  }
  probes: {
    readReports: ReadinessProbeResult
    writeProbe: ReadinessProbeResult
  }
}

async function runReadProbe(url: string, token: string): Promise<ReadinessProbeResult> {
  try {
    const response = await fetch(`${url}/get/${REPORT_INDEX_KEY}`, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        message: `Read probe failed (${response.status})`
      }
    }

    return { ok: true, statusCode: response.status }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Read probe failed'
    }
  }
}

async function runWriteProbe(url: string, token: string): Promise<ReadinessProbeResult> {
  try {
    const response = await fetch(`${url}/set/${WRITE_PROBE_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        checkedAt: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        ok: false,
        statusCode: response.status,
        message: text ? `Write probe failed (${response.status}): ${text}` : `Write probe failed (${response.status})`
      }
    }

    return { ok: true, statusCode: response.status }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Write probe failed'
    }
  }
}

export async function getModelCatalogReadiness(): Promise<ModelCatalogReadiness> {
  const checkedAt = new Date().toISOString()
  const kvRestApiUrl = (await getRuntimeEnv('KV_REST_API_URL'))?.trim() || ''
  const kvWriteToken = (await getRuntimeEnv('KV_REST_API_TOKEN'))?.trim() || ''
  const kvReadOnlyToken = (await getRuntimeEnv('KV_REST_API_READ_ONLY_TOKEN'))?.trim() || ''
  const kvReadToken = kvReadOnlyToken || kvWriteToken

  const readTokenSource: ModelCatalogReadiness['checks']['readTokenSource'] =
    kvReadOnlyToken ? 'read-only' : kvReadToken ? 'write-fallback' : 'missing'

  const warnings: string[] = []
  if (readTokenSource === 'write-fallback') {
    warnings.push(
      'KV_REST_API_READ_ONLY_TOKEN is missing; report reads are using KV_REST_API_TOKEN fallback.'
    )
  }

  const baseChecks = {
    kvRestApiUrl: Boolean(kvRestApiUrl),
    kvWriteToken: Boolean(kvWriteToken),
    kvReadToken: Boolean(kvReadToken),
    readTokenSource
  }

  let readReports: ReadinessProbeResult = {
    ok: false,
    message: 'Read probe skipped (missing KV URL or read token).'
  }
  let writeProbe: ReadinessProbeResult = {
    ok: false,
    message: 'Write probe skipped (missing KV URL or write token).'
  }

  if (baseChecks.kvRestApiUrl && baseChecks.kvReadToken) {
    readReports = await runReadProbe(kvRestApiUrl, kvReadToken)
  }

  if (baseChecks.kvRestApiUrl && baseChecks.kvWriteToken) {
    writeProbe = await runWriteProbe(kvRestApiUrl, kvWriteToken)
  }

  if (!readReports.ok && baseChecks.kvRestApiUrl && baseChecks.kvReadToken) {
    warnings.push(readReports.message || 'Report read probe failed.')
  }
  if (!writeProbe.ok && baseChecks.kvRestApiUrl && baseChecks.kvWriteToken) {
    warnings.push(writeProbe.message || 'Catalog/report write probe failed.')
  }

  const ready =
    baseChecks.kvRestApiUrl &&
    baseChecks.kvWriteToken &&
    baseChecks.kvReadToken &&
    readReports.ok &&
    writeProbe.ok

  return {
    ready,
    status: ready ? 'ready' : 'degraded',
    checkedAt,
    warnings,
    checks: baseChecks,
    probes: {
      readReports,
      writeProbe
    }
  }
}
