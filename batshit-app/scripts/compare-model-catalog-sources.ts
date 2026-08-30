import { loadLocalEnvFiles } from './lib/loadLocalEnv'

loadLocalEnvFiles({ cwd: process.cwd(), label: 'catalog-compare' })

type CatalogModel = {
  id: string
  provider: string
  name: string
  connectionId?: string | null
  availableConnections?: string[]
  idVariants?: Record<
    string,
    {
      effectiveId: string
      developerId: string
      modelId: string
      source: string
    }
  >
}

type ComparisonFetchMode = 'live-api' | 'manual-or-skipped' | 'error'

type ComparisonResult = {
  provider: string
  connectionId: string
  fetchMode: ComparisonFetchMode
  sourceCount: number
  catalogCount: number
  onlyInSource: string[]
  onlyInCatalog: string[]
  note?: string
  error?: string
  hasGpt4oInSource?: boolean
  hasGpt4oInCatalog?: boolean
}

type ComparisonDefinition = {
  provider: string
  connectionId: string
  note?: string
  fetcher: () => Promise<string[] | null>
}

type ScriptOptions = {
  json: boolean
  providerFilter: string | null
}

function parseArgs(argv: string[]): ScriptOptions {
  let json = false
  let providerFilter: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--provider') {
      providerFilter = argv[index + 1]?.trim().toLowerCase() ?? null
      index += 1
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run compare:model-catalog-sources -- [options]

Options:
  --json                Print the full comparison payload as JSON
  --provider <id>       Limit the compare to one provider (for example: openai, groq, replicate)
  --help, -h            Show this help
`)
      process.exit(0)
    }
  }

  return { json, providerFilter }
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort()
}

function normalize(values: string[]) {
  return uniq(values.map((value) => value.trim()).filter(Boolean))
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${url} ${text}`.trim())
  }
  return (await response.json()) as T
}

async function getCatalog(): Promise<CatalogModel[]> {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_READ_ONLY_TOKEN || process.env.KV_REST_API_TOKEN
  if (!url || !token) {
    throw new Error('Missing KV env for catalog compare')
  }

  const payload = await fetchJson<{
    result?: string | { models?: CatalogModel[] }
  }>(`${url}/get/catalog:v1`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  const raw = payload.result
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  return Array.isArray(parsed?.models) ? parsed.models : []
}

function getCatalogIdsForConnection(models: CatalogModel[], connectionId: string): string[] {
  const values: string[] = []

  for (const model of models) {
    const variant = model.idVariants?.[connectionId]
    if (variant?.effectiveId) {
      values.push(variant.effectiveId)
      continue
    }

    if (model.connectionId === connectionId) {
      values.push(model.id)
      continue
    }

    if (model.availableConnections?.includes(connectionId)) {
      if (connectionId === 'vercel-gateway' || connectionId === 'openrouter') {
        values.push(model.id)
      }
    }
  }

  return normalize(values)
}

function buildOpenAICompatibleModelsUrl(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/models`
  return `${trimmed}/v1/models`
}

async function fetchOpenAICompatibleIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const payload = await fetchJson<any>(buildOpenAICompatibleModelsUrl(baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` }
  })

  const data = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : []

  return normalize(data.map((entry: any) => String(entry?.id ?? '')).filter(Boolean))
}

async function fetchOpenAIIds() {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null

  const payload = await fetchJson<{ data?: Array<{ id: string }> }>('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  })

  return normalize((payload.data ?? []).map((entry) => entry.id))
}

async function fetchAnthropicIds() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null

  let afterId: string | null = null
  const ids: string[] = []

  do {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '1000')
    if (afterId) url.searchParams.set('after_id', afterId)

    const payload = await fetchJson<{
      data?: Array<{ id: string }>
      has_more?: boolean
      last_id?: string | null
    }>(url.toString(), {
      headers: {
        'x-api-key': key,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01'
      }
    })

    for (const entry of payload.data ?? []) {
      ids.push(entry.id)
    }
    afterId = payload.has_more ? payload.last_id || null : null
  } while (afterId)

  return normalize(ids)
}

async function fetchGoogleIds() {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!key) return null

  let pageToken: string | null = null
  const ids: string[] = []

  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const payload = await fetchJson<{
      models?: Array<{ name?: string; baseModelId?: string }>
      nextPageToken?: string
    }>(url.toString(), {
      headers: { 'x-goog-api-key': key }
    })

    for (const model of payload.models ?? []) {
      const rawName = String(model?.name ?? '')
      const id = rawName.startsWith('models/')
        ? rawName.slice('models/'.length)
        : rawName || String(model?.baseModelId ?? '')

      if (id) ids.push(id)
    }

    pageToken = payload.nextPageToken || null
  } while (pageToken)

  return normalize(ids)
}

async function fetchGroqIds() {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  return fetchOpenAICompatibleIds('https://api.groq.com/openai/v1', key)
}

async function fetchDeepSeekIds() {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) return null
  return fetchOpenAICompatibleIds(process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com', key)
}

async function fetchDeepInfraIds() {
  const payload = await fetchJson<
    Array<{
      model_name?: string
      reported_type?: string
      deprecated?: number | null
      replaced_by?: string | null
      private?: number | null
    }>
  >('https://api.deepinfra.com/models/list')

  return normalize(
    payload
      .filter(
        (model) =>
          model?.reported_type === 'text-generation' &&
          model.private !== 1 &&
          model.deprecated == null &&
          !model.replaced_by
      )
      .map((model) => String(model.model_name ?? ''))
  )
}

async function fetchZaiIds() {
  const key = process.env.ZAI_API_KEY
  if (!key) return null
  return fetchOpenAICompatibleIds(process.env.ZAI_API_BASE_URL || 'https://api.z.ai/api/paas/v4', key)
}

async function fetchZaiCodingIds() {
  const key = process.env.ZAI_CODING_API_KEY
  if (!key) return null
  return fetchOpenAICompatibleIds(process.env.ZAI_CODING_API_BASE_URL || 'https://api.z.ai/api/coding/paas/v4', key)
}

async function fetchTogetherIds() {
  const key = process.env.TOGETHER_API_KEY
  if (!key) return null

  const payload = await fetchJson<Array<{ id?: string; type?: string; running?: boolean }>>(
    buildOpenAICompatibleModelsUrl(process.env.TOGETHER_API_BASE_URL || 'https://api.together.xyz/v1'),
    { headers: { Authorization: `Bearer ${key}` } }
  )
  return normalize(payload.filter((entry) => entry.type === 'chat').map((entry) => String(entry.id ?? '')))
}

async function fetchFireworksIds() {
  const key = process.env.FIREWORKS_API_KEY
  if (!key) return null

  const ids: string[] = []
  let pageToken: string | null = null
  do {
    const url = new URL('https://api.fireworks.ai/v1/accounts/fireworks/models')
    url.searchParams.set('filter', 'supports_serverless=true')
    url.searchParams.set('pageSize', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const payload = await fetchJson<{
      models?: Array<{ name?: string; public?: boolean; state?: string }>
      nextPageToken?: string | null
    }>(url.toString(), { headers: { Authorization: `Bearer ${key}` } })

    ids.push(
      ...(payload.models ?? [])
        .filter((entry) => entry.public !== false && entry.state !== 'DELETING' && entry.state !== 'FAILED')
        .map((entry) => String(entry.name ?? ''))
    )
    pageToken = String(payload.nextPageToken ?? '').trim() || null
  } while (pageToken)

  return normalize(ids)
}

async function fetchCohereIds() {
  const key = process.env.COHERE_API_KEY
  if (!key) return null

  const payload = await fetchJson<{ models?: Array<{ name?: string }> }>('https://api.cohere.ai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  })
  return normalize((payload.models ?? []).map((entry) => String(entry.name ?? '')))
}

async function fetchMistralIds() {
  const key = process.env.MISTRAL_API_KEY
  if (!key) return null

  const payload = await fetchJson<any>('https://api.mistral.ai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  })
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return normalize(data.map((entry: any) => String(entry?.id ?? '')).filter(Boolean))
}

async function fetchFalIds() {
  const key = process.env.FAL_API_KEY || process.env.FAL_KEY
  if (!key) return null

  const ids: string[] = []
  let cursor: string | null = null
  let pages = 0

  while (pages < 200) {
    const url = new URL('https://api.fal.ai/v1/models')
    url.searchParams.set('limit', '200')
    if (cursor) url.searchParams.set('cursor', cursor)

    const payload = await fetchJson<{
      models?: any[]
      next_cursor?: string | null
    }>(url.toString(), {
      headers: { Authorization: `Key ${key}` }
    })

    for (const model of payload.models ?? []) {
      const endpointId = String(model?.endpoint_id ?? '').trim()
      if (endpointId) ids.push(endpointId)
    }

    cursor = String(payload?.next_cursor ?? '').trim() || null
    if (!cursor) break
    pages += 1
  }

  return normalize(ids)
}

async function fetchReplicateIds() {
  const key = process.env.REPLICATE_API_KEY
  if (!key) return null

  const payload = await fetchJson<{ models?: any[] }>('https://api.replicate.com/v1/collections/official', {
    headers: { Authorization: `Bearer ${key}` }
  })

  const ids: string[] = []
  for (const model of payload.models ?? []) {
    if (model?.is_official !== true) continue
    const owner = String(model?.owner ?? '').trim()
    const name = String(model?.name ?? '').trim()
    if (owner && name) ids.push(`${owner}/${name}`)
  }

  return normalize(ids)
}

const COMPARISONS: ComparisonDefinition[] = [
  {
    provider: 'openai',
    connectionId: 'direct:openai',
    fetcher: fetchOpenAIIds
  },
  {
    provider: 'anthropic',
    connectionId: 'direct:anthropic',
    fetcher: fetchAnthropicIds
  },
  {
    provider: 'google',
    connectionId: 'direct:google',
    fetcher: fetchGoogleIds
  },
  { provider: 'groq', connectionId: 'direct:groq', fetcher: fetchGroqIds },
  {
    provider: 'deepseek',
    connectionId: 'direct:deepseek',
    fetcher: fetchDeepSeekIds
  },
  {
    provider: 'deepinfra',
    connectionId: 'direct:deepinfra',
    fetcher: fetchDeepInfraIds
  },
  {
    provider: 'moonshot',
    connectionId: 'direct:moonshot',
    fetcher: async () => {
      const key = process.env.MOONSHOT_API_KEY
      if (!key) return null
      return fetchOpenAICompatibleIds(process.env.MOONSHOT_API_BASE_URL || 'https://api.moonshot.ai/v1', key)
    }
  },
  {
    provider: 'minimax',
    connectionId: 'direct:minimax',
    fetcher: async () => {
      const key = process.env.MINIMAX_API_KEY
      if (!key) return null
      return fetchOpenAICompatibleIds(process.env.MINIMAX_API_BASE_URL || 'https://api.minimax.io/v1', key)
    }
  },
  {
    provider: 'mimo',
    connectionId: 'direct:mimo',
    fetcher: async () => {
      const key = process.env.MIMO_API_KEY
      if (!key) return null
      return fetchOpenAICompatibleIds(process.env.MIMO_API_BASE_URL || 'https://api.xiaomimimo.com/v1', key)
    }
  },
  { provider: 'zai', connectionId: 'direct:zai', fetcher: fetchZaiIds },
  {
    provider: 'zai_coding',
    connectionId: 'direct:zai_coding',
    fetcher: fetchZaiCodingIds
  },
  {
    provider: 'togetherai',
    connectionId: 'direct:togetherai',
    fetcher: fetchTogetherIds
  },
  {
    provider: 'fireworks',
    connectionId: 'direct:fireworks',
    fetcher: fetchFireworksIds
  },
  {
    provider: 'baseten',
    connectionId: 'direct:baseten',
    fetcher: async () => {
      const key = process.env.BASETEN_API_KEY
      if (!key) return null
      return fetchOpenAICompatibleIds(process.env.BASETEN_API_BASE_URL || 'https://inference.baseten.co/v1', key)
    }
  },
  {
    provider: 'cerebras',
    connectionId: 'direct:cerebras',
    fetcher: async () => {
      const key = process.env.CEREBRAS_API_KEY
      if (!key) return null
      return fetchOpenAICompatibleIds(process.env.CEREBRAS_API_BASE_URL || 'https://api.cerebras.ai/v1', key)
    }
  },
  {
    provider: 'mistral',
    connectionId: 'direct:mistral',
    fetcher: fetchMistralIds
  },
  { provider: 'fal', connectionId: 'direct:fal', fetcher: fetchFalIds },
  {
    provider: 'replicate',
    connectionId: 'direct:replicate',
    fetcher: fetchReplicateIds
  },
  {
    provider: 'luma',
    connectionId: 'direct:luma',
    fetcher: async () => null,
    note: 'Sync uses a curated manual list, not a live model-list API call.'
  },
  {
    provider: 'elevenlabs',
    connectionId: 'direct:elevenlabs',
    fetcher: async () => null,
    note: 'Sync currently uses a curated manual list, not a live model-list API call.'
  },
  {
    provider: 'deepgram',
    connectionId: 'direct:deepgram',
    fetcher: async () => null,
    note: 'Sync currently uses a curated manual list, not a live model-list API call.'
  },
  {
    provider: 'assemblyai',
    connectionId: 'direct:assemblyai',
    fetcher: async () => null,
    note: 'Sync currently uses a curated manual list, not a live model-list API call.'
  },
  {
    provider: 'cohere',
    connectionId: 'direct:cohere',
    fetcher: fetchCohereIds
  }
]

async function compareProvider(definition: ComparisonDefinition, catalog: CatalogModel[]): Promise<ComparisonResult> {
  const catalogIds = getCatalogIdsForConnection(catalog, definition.connectionId)

  try {
    const sourceIds = await definition.fetcher()
    if (sourceIds === null) {
      return {
        provider: definition.provider,
        connectionId: definition.connectionId,
        fetchMode: 'manual-or-skipped',
        sourceCount: 0,
        catalogCount: catalogIds.length,
        onlyInSource: [],
        onlyInCatalog: catalogIds.slice(0, 25),
        note: definition.note
      }
    }

    const sourceSet = new Set(sourceIds)
    const catalogSet = new Set(catalogIds)

    return {
      provider: definition.provider,
      connectionId: definition.connectionId,
      fetchMode: 'live-api',
      sourceCount: sourceIds.length,
      catalogCount: catalogIds.length,
      onlyInSource: sourceIds.filter((id) => !catalogSet.has(id)).slice(0, 25),
      onlyInCatalog: catalogIds.filter((id) => !sourceSet.has(id)).slice(0, 25),
      hasGpt4oInSource: definition.provider === 'openai' ? sourceSet.has('gpt-4o') : undefined,
      hasGpt4oInCatalog: definition.provider === 'openai' ? catalogSet.has('gpt-4o') : undefined
    }
  } catch (error) {
    return {
      provider: definition.provider,
      connectionId: definition.connectionId,
      fetchMode: 'error',
      sourceCount: 0,
      catalogCount: catalogIds.length,
      onlyInSource: [],
      onlyInCatalog: catalogIds.slice(0, 25),
      note: definition.note,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function printPretty(results: ComparisonResult[]) {
  console.log(`Model catalog source comparison (${new Date().toISOString()})`)
  console.log('')

  for (const result of results) {
    const status =
      result.fetchMode === 'error'
        ? 'ERROR'
        : result.onlyInSource.length || result.onlyInCatalog.length
          ? 'MISMATCH'
          : 'OK'

    console.log(`${result.provider} [${result.connectionId}] -> ${status}`)
    console.log(`  source=${result.sourceCount} catalog=${result.catalogCount} mode=${result.fetchMode}`)

    if (result.provider === 'openai') {
      console.log(
        `  gpt-4o source=${result.hasGpt4oInSource ? 'yes' : 'no'} catalog=${result.hasGpt4oInCatalog ? 'yes' : 'no'}`
      )
    }

    if (result.onlyInSource.length) {
      console.log(`  only in source (${result.onlyInSource.length} shown):`)
      for (const id of result.onlyInSource) console.log(`    + ${id}`)
    }

    if (result.onlyInCatalog.length) {
      console.log(`  only in catalog (${result.onlyInCatalog.length} shown):`)
      for (const id of result.onlyInCatalog) console.log(`    - ${id}`)
    }

    if (result.note) {
      console.log(`  note: ${result.note}`)
    }

    if (result.error) {
      console.log(`  error: ${result.error}`)
    }

    console.log('')
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const catalog = await getCatalog()
  const definitions = options.providerFilter
    ? COMPARISONS.filter((entry) => entry.provider === options.providerFilter)
    : COMPARISONS

  if (!definitions.length) {
    throw new Error(`Unknown provider filter: ${options.providerFilter}`)
  }

  const results = await Promise.all(definitions.map((entry) => compareProvider(entry, catalog)))
  const payload = {
    checkedAt: new Date().toISOString(),
    results
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  printPretty(results)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
