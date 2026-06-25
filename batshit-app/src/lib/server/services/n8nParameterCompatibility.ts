import type { CompatibilityMatrixEntry, CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'
import { getParameterSchema } from '$lib/data/parameter-schemas'
import { redis } from '$lib/server/redis'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
const CACHE_KEY = 'compatibility:matrix:v1'

const N8N_MATRIX_KEY = 'compatibility:matrix:n8n:v1'

type NodeTypeDescription = {
  name?: string
  type?: string
  displayName?: string
  outputs?: string[]
  properties?: Array<{ name?: string }>
}

type N8NApiConfig = {
  baseUrl: string
  apiKey?: string | null
}

type N8NUiAuthConfig = {
  email?: string | null
  password?: string | null
}

async function loadSavedApiKey(service: string, userId?: string | null): Promise<string | null> {
  if (!userId) return null
  const mod = await import('$lib/services/apiKey.server')
  return mod.apiKeyService.retrieve(service, userId)
}

const NODE_TYPE_ENDPOINTS = [
  { path: '/rest/node-types', requiresKey: true },
  { path: '/rest/node-types?includeVersions=true', requiresKey: true },
  { path: '/api/v1/node-types', requiresKey: true },
  { path: '/api/v1/node-types?includeVersions=true', requiresKey: true },
  { path: '/types/nodes.json', requiresKey: false }
]

const PROVIDER_NODE_MATCHERS: Array<{ provider: string; match: RegExp }> = [
  { provider: 'azure-openai', match: /azure.*openai/i },
  { provider: 'google-vertex', match: /vertex/i },
  { provider: 'vercel-gateway', match: /vercel.*gateway/i },
  { provider: 'baseten', match: /baseten/i },
  { provider: 'alibaba', match: /alibaba|dashscope/i },
  { provider: 'minimax', match: /minimax/i },
  { provider: 'moonshot', match: /moonshot|kimi/i },
  { provider: 'nvidia', match: /nvidia|nemotron|(?:^|\s)nim(?:\s|$)/i },
  { provider: 'openrouter', match: /openrouter/i },
  { provider: 'xai', match: /xai|grok/i },
  { provider: 'cohere', match: /cohere/i },
  { provider: 'lemonade', match: /lemonade/i },
  { provider: 'huggingface', match: /hugging\s*face|huggingface/i },
  { provider: 'openai', match: /openai/i },
  { provider: 'anthropic', match: /anthropic/i },
  { provider: 'google', match: /google|gemini|palm/i },
  { provider: 'mistral', match: /mistral|codestral/i },
  { provider: 'groq', match: /groq/i },
  { provider: 'deepseek', match: /deepseek/i },
  { provider: 'ollama', match: /ollama/i },
  { provider: 'aws-bedrock', match: /bedrock/i }
]

const CHAT_NODE_HINT = /lmchat|chat\s*model|chat\s*llm/i

function isLanguageModelNode(node: NodeTypeDescription): boolean {
  if (Array.isArray(node.outputs) && node.outputs.includes('ai_languageModel')) {
    return true
  }
  const label = [node.name, node.type, node.displayName].filter(Boolean).join(' ').toLowerCase()
  return CHAT_NODE_HINT.test(label)
}

const PARAMETER_SYNONYMS: Record<string, string> = {
  maxtokenstosample: 'maxTokens',
  maxtokens: 'maxTokens',
  maxoutputtokens: 'maxTokens',
  toptokens: 'topK',
  topp: 'topP',
  topprobs: 'topP',
  presencepenalty: 'presencePenalty',
  frequencypenalty: 'frequencyPenalty',
  stop: 'stopSequences',
  stopsequence: 'stopSequences',
  stopsequences: 'stopSequences',
  logitbias: 'logitBias',
  responseformat: 'responseFormat',
  jsonmode: 'responseFormat',
  seed: 'seed'
}

const N8N_OPENAI_COMPATIBLE_PARAMETERS = [
  'frequencyPenalty',
  'maxTokens',
  'presencePenalty',
  'responseFormat',
  'temperature',
  'topP'
]

const CURATED_N8N_PROVIDER_FALLBACKS: Record<string, string[]> = {
  baseten: N8N_OPENAI_COMPATIBLE_PARAMETERS
}

const SCHEMA_PROVIDER_OVERRIDES: Record<string, string> = {
  'azure-openai': 'openai',
  openrouter: 'openai',
  'vercel-gateway': 'openai',
  xai: 'openai',
  lemonade: 'openai',
  baseten: 'openai',
  alibaba: 'openai',
  minimax: 'openai',
  moonshot: 'openai',
  nvidia: 'openai',
  cohere: 'openai',
  huggingface: 'default',
  'aws-bedrock': 'anthropic',
  'google-vertex': 'google'
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function buildBaseUrlCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  const candidates = new Set<string>([normalized])
  const trimmed = [
    normalized.replace(/\/api\/v1\/?$/, ''),
    normalized.replace(/\/api\/?$/, ''),
    normalized.replace(/\/rest\/?$/, '')
  ]
  for (const candidate of trimmed) {
    if (candidate) {
      candidates.add(candidate)
    }
  }
  return Array.from(candidates)
}

async function resolveN8nApiConfig(userId?: string | null): Promise<N8NApiConfig> {
  const [envApiKey, envBaseUrl] = await Promise.all([
    getRuntimeEnv('N8N_API_KEY'),
    getRuntimeEnv('N8N_API_URL')
  ])
  const apiKey =
    envApiKey || (await loadSavedApiKey('n8n_api_key', userId))
  const rawBase =
    envBaseUrl || (await loadSavedApiKey('n8n_api_url', userId))
  const baseUrl = (rawBase || 'http://localhost:5678').replace(/\/+$/, '')
  return { baseUrl, apiKey }
}

async function resolveN8nUiAuthConfig(userId?: string | null): Promise<N8NUiAuthConfig> {
  const [envEmail, envPassword] = await Promise.all([
    getRuntimeEnv('N8N_UI_EMAIL'),
    getRuntimeEnv('N8N_UI_PASSWORD')
  ])
  const email = envEmail || (await loadSavedApiKey('n8n_ui_email', userId))
  const password =
    envPassword || (await loadSavedApiKey('n8n_ui_password', userId))
  return { email, password }
}

function extractNodeTypes(payload: any): NodeTypeDescription[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload as NodeTypeDescription[]
  if (Array.isArray(payload?.data)) return payload.data as NodeTypeDescription[]
  if (Array.isArray(payload?.nodeTypes)) return payload.nodeTypes as NodeTypeDescription[]
  if (Array.isArray(payload?.nodes)) return payload.nodes as NodeTypeDescription[]
  return []
}

function parseSetCookie(header: string | null): string[] {
  if (!header) return []
  // Split on commas that start a new cookie (avoid Expires=... commas)
  const parts = header.split(/,(?=[^;]+?=)/g)
  return parts.map((part) => part.split(';')[0]?.trim()).filter(Boolean)
}

async function fetchNodeTypesViaLogin(
  baseUrl: string,
  auth: N8NUiAuthConfig
): Promise<NodeTypeDescription[]> {
  if (!auth.email || !auth.password) return []

  const response = await fetch(`${baseUrl}/rest/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      emailOrLdapLoginId: auth.email,
      email: auth.email,
      password: auth.password
    }),
    signal: AbortSignal.timeout(10_000)
  })

  if (!response.ok) return []

  const header =
    typeof (response.headers as any).getSetCookie === 'function'
      ? ((response.headers as any).getSetCookie() as string[]).join(',')
      : response.headers.get('set-cookie')
  const cookies = parseSetCookie(header)
  if (!cookies.length) return []

  const nodeResponse = await fetch(`${baseUrl}/types/nodes.json`, {
    headers: {
      Accept: 'application/json',
      Cookie: cookies.join('; ')
    },
    signal: AbortSignal.timeout(10_000)
  })

  if (!nodeResponse.ok) return []
  const payload = await nodeResponse.json().catch(() => null)
  return extractNodeTypes(payload)
}

async function fetchNodeTypes(config: N8NApiConfig): Promise<NodeTypeDescription[]> {
  const baseCandidates = buildBaseUrlCandidates(config.baseUrl)

  for (const baseUrl of baseCandidates) {
    for (const endpoint of NODE_TYPE_ENDPOINTS) {
      if (endpoint.requiresKey && !config.apiKey) {
        continue
      }

      const response = await fetch(`${baseUrl}${endpoint.path}`, {
        headers: config.apiKey
          ? {
              'X-N8N-API-KEY': config.apiKey,
              Accept: 'application/json'
            }
          : {
              Accept: 'application/json'
            },
        signal: AbortSignal.timeout(10_000)
      })

      if (!response.ok) {
        continue
      }

      const payload = await response.json().catch(() => null)
      const nodes = extractNodeTypes(payload)
      if (nodes.length) return nodes
    }
  }

  return []
}

function resolveProvider(node: NodeTypeDescription): string | null {
  if (!isLanguageModelNode(node)) return null

  const label = [node.name, node.type, node.displayName].filter(Boolean).join(' ').toLowerCase()
  if (!label) return null

  for (const entry of PROVIDER_NODE_MATCHERS) {
    if (entry.match.test(label)) return entry.provider
  }

  return null
}

function buildDefinitionLookup(provider: string) {
  const schemaProvider = SCHEMA_PROVIDER_OVERRIDES[provider] ?? provider
  const schema = getParameterSchema(schemaProvider)
  const names = new Map<string, string>()

  const addDefinition = (name: string) => {
    names.set(normalizeKey(name), name)
  }

  for (const definition of schema.base) {
    addDefinition(definition.name)
  }

  if (schema.modelOverrides) {
    for (const overrides of Object.values(schema.modelOverrides)) {
      overrides.forEach((definition) => addDefinition(definition.name))
    }
  }

  return names
}

function mapParameterName(raw: string, lookup: Map<string, string>): string | null {
  const normalized = normalizeKey(raw)
  if (lookup.has(normalized)) {
    return lookup.get(normalized) ?? null
  }
  if (PARAMETER_SYNONYMS[normalized]) {
    return PARAMETER_SYNONYMS[normalized]
  }
  return null
}

function extractAllowedParameters(node: NodeTypeDescription, provider: string): string[] {
  const lookup = buildDefinitionLookup(provider)
  const props = Array.isArray(node.properties) ? node.properties : []
  const allowed = new Set<string>()

  const stack: Array<{ name?: string; options?: any; values?: any; typeOptions?: any }> = [...props]

  while (stack.length) {
    const prop = stack.pop()
    if (!prop) continue
    if (typeof prop.name === 'string') {
      const mapped = mapParameterName(prop.name, lookup)
      if (mapped) {
        allowed.add(mapped)
      }
    }

    if (Array.isArray(prop.options)) {
      stack.push(...prop.options)
    }
    if (Array.isArray(prop.values)) {
      stack.push(...prop.values)
    }

    const typeOptions = prop.typeOptions
    if (typeOptions) {
      if (Array.isArray(typeOptions.options)) {
        stack.push(...typeOptions.options)
      }
      if (Array.isArray(typeOptions.values)) {
        stack.push(...typeOptions.values)
      }
    }
  }

  return Array.from(allowed)
}

export async function runN8nCompatibilitySync(options?: {
  userId?: string | null
}): Promise<CompatibilityMatrixSnapshot> {
  const config = await resolveN8nApiConfig(options?.userId ?? null)
  const nodeTypes = await fetchNodeTypes(config)
  if (!nodeTypes.length) {
    const uiAuth = await resolveN8nUiAuthConfig(options?.userId ?? null)
    const baseCandidates = buildBaseUrlCandidates(config.baseUrl)
    let fetched: NodeTypeDescription[] = []
    for (const baseUrl of baseCandidates) {
      fetched = await fetchNodeTypesViaLogin(baseUrl, uiAuth)
      if (fetched.length) break
    }

    if (fetched.length) {
      nodeTypes.push(...fetched)
    }
  }

  if (!nodeTypes.length) {
    throw new Error(
      'No node types returned from n8n. Check N8N_API_URL and N8N_API_KEY, or add N8N_UI_EMAIL / N8N_UI_PASSWORD for UI auth.'
    )
  }

  const providerMap = new Map<string, Set<string>>()

  for (const node of nodeTypes) {
    const provider = resolveProvider(node)
    if (!provider) continue

    const allowed = extractAllowedParameters(node, provider)
    if (!allowed.length) continue

    if (!providerMap.has(provider)) {
      providerMap.set(provider, new Set())
    }

    const bucket = providerMap.get(provider)!
    for (const param of allowed) {
      bucket.add(param)
    }
  }

  // Some verified n8n chat-model providers can appear in the node picker before
  // /types/nodes.json exposes a node definition. Keep these explicit and small.
  for (const [provider, params] of Object.entries(CURATED_N8N_PROVIDER_FALLBACKS)) {
    if (providerMap.has(provider)) continue
    providerMap.set(provider, new Set(params))
  }

  const entries: CompatibilityMatrixEntry[] = []
  for (const [provider, params] of providerMap.entries()) {
    entries.push({
      scope: {
        connection: 'n8n',
        provider
      },
      allow: Array.from(params).sort()
    })
  }
  if (!entries.length) {
    throw new Error('No chat model parameters detected in n8n node types. Check provider mappings.')
  }

  const snapshot: CompatibilityMatrixSnapshot = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    entries
  }

  await redis.json.set(N8N_MATRIX_KEY, '$', snapshot)
  await redis.del(CACHE_KEY)

  return snapshot
}

export async function loadN8nCompatibilitySnapshot(): Promise<CompatibilityMatrixSnapshot | null> {
  const snapshot = (await redis.json.get(N8N_MATRIX_KEY)) as CompatibilityMatrixSnapshot | null
  if (!snapshot?.entries || !Array.isArray(snapshot.entries)) {
    return null
  }
  return snapshot
}
