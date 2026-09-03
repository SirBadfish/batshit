/**
 * SA-104 memory embedding pipeline (DL-104-10: local-first, zero API keys required).
 *
 * Three lanes behind one interface (preflight §3.2):
 *  - `builtin`   in-process ONNX via @huggingface/transformers (the default; weights
 *                download once into the managed-installs root, never bundled).
 *  - `local-ai`  any OpenAI-compatible local runtime (Ollama / LM Studio / llama.cpp /
 *                vLLM) through AI SDK embedMany.
 *  - `api`       provider embeddings as an optional upgrade; key resolution ships with
 *                the Settings surface (P5) and selecting it before then fails loudly.
 *
 * Hard finding from the P0 spike: task prefixes are a per-model contract. Skipping them
 * measurably breaks retrieval (nomic dropped 1/3 of hard queries). Every model spec here
 * therefore carries document/query templates, and all embedding goes through them.
 */

import { embedMany } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import path from 'node:path'
import { resolveManagedInstallsRoot } from '$lib/server/services/voiceLocalRuntimePaths'
import type { MemoryEmbeddingConfig } from './memoryTypes'

export interface MemoryEmbedder {
  /** Canonical id recorded on every record and in the index meta, e.g. 'builtin:embeddinggemma-300m@768'. */
  readonly modelId: string
  readonly dims: number
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

interface BuiltinModelSpec {
  /** Config-facing id ('builtin:' + slug). */
  id: string
  hfModelId: string
  dims: number
  /** Quantization is part of the spec: changing it changes vectors, so it is pinned per id. */
  dtype: 'fp32' | 'q8'
  documentTemplate: (text: string) => string
  queryTemplate: (text: string) => string
}

/**
 * Built-in in-process models (P2 registry). embeddinggemma is the product default
 * (P0 §3.2 + the 2026-08-25 landscape re-check); MiniLM is the low-resource option.
 * Prompt formats are each model's documented contract — do not "simplify" them.
 */
export const BUILTIN_EMBEDDING_MODELS: readonly BuiltinModelSpec[] = [
  {
    id: 'builtin:embeddinggemma-300m',
    hfModelId: 'onnx-community/embeddinggemma-300m-ONNX',
    dims: 768,
    dtype: 'q8',
    documentTemplate: (text) => `title: none | text: ${text}`,
    queryTemplate: (text) => `task: search result | query: ${text}`
  },
  {
    id: 'builtin:all-minilm-l6-v2',
    hfModelId: 'Xenova/all-MiniLM-L6-v2',
    dims: 384,
    dtype: 'q8',
    documentTemplate: (text) => text,
    queryTemplate: (text) => text
  }
]

export const DEFAULT_MEMORY_EMBEDDING_CONFIG: MemoryEmbeddingConfig = {
  lane: 'builtin',
  modelId: 'builtin:embeddinggemma-300m'
}

export function canonicalEmbeddingModelId(config: MemoryEmbeddingConfig): string {
  if (config.lane === 'builtin') {
    const spec = requireBuiltinSpec(config.modelId)
    return `${spec.id}@${spec.dims}`
  }
  if (config.lane === 'preset') {
    const preset = requirePresetConfig(config)
    return `preset:${preset.provider}:${preset.modelName}@${preset.dims}`
  }
  if (config.lane === 'local-ai') {
    const localAi = requireLocalAiConfig(config)
    return `local-ai:${localAi.modelName}@${localAi.dims}`
  }
  const api = requireApiConfig(config)
  return `api:${api.provider}:${api.modelName}@${api.dims}`
}

export function requirePresetConfig(
  config: MemoryEmbeddingConfig
): NonNullable<MemoryEmbeddingConfig['preset']> {
  if (!config.preset?.presetId || !config.preset.provider || !config.preset.modelName || !config.preset.dims) {
    throw new Error(
      "Memory embedding lane 'preset' requires preset.presetId, preset.provider, preset.modelName, and preset.dims in batshit:memory_config. Re-save the Memory System configuration."
    )
  }
  return config.preset
}

function requireBuiltinSpec(modelId: string): BuiltinModelSpec {
  const spec = BUILTIN_EMBEDDING_MODELS.find((candidate) => candidate.id === modelId)
  if (!spec) {
    const known = BUILTIN_EMBEDDING_MODELS.map((candidate) => candidate.id).join(', ')
    throw new Error(
      `Unknown builtin memory embedding model '${modelId}'. Known builtin models: ${known}.`
    )
  }
  return spec
}

function requireLocalAiConfig(config: MemoryEmbeddingConfig): NonNullable<MemoryEmbeddingConfig['localAi']> {
  if (!config.localAi?.baseUrl || !config.localAi.modelName || !config.localAi.dims) {
    throw new Error(
      "Memory embedding lane 'local-ai' requires localAi.baseUrl, localAi.modelName, and localAi.dims in batshit:memory_config."
    )
  }
  return config.localAi
}

function requireApiConfig(config: MemoryEmbeddingConfig): NonNullable<MemoryEmbeddingConfig['api']> {
  if (!config.api?.provider || !config.api.modelName || !config.api.dims) {
    throw new Error(
      "Memory embedding lane 'api' requires api.provider, api.modelName, and api.dims in batshit:memory_config."
    )
  }
  return config.api
}

/**
 * Stored embeddings are JSON: full-precision doubles print ~20 characters per float
 * (~15KB per 768d record). Seven significant decimals keep cosine geometry intact far
 * below quantization noise while halving record and backup size.
 */
function compactVector(vector: number[]): number[] {
  return vector.map((value) => Number(value.toFixed(7)))
}

function assertEmbeddingDims(vectors: number[][], expected: number, modelId: string): void {
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new Error(
        `Memory embedding dimension mismatch: model '${modelId}' returned ${vector.length} dims, expected ${expected}. ` +
          'If the embedding model changed, run the explicit memory re-index path instead of writing mixed-dimension vectors.'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// builtin lane — in-process @huggingface/transformers
// ---------------------------------------------------------------------------

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist(): number[][] }>

export type BuiltinModelProgress = (progress: {
  status?: string
  file?: string
  progress?: number
}) => void

interface TransformersEnv {
  cacheDir: string
}

interface TransformersModule {
  env: TransformersEnv
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { dtype: string; progress_callback?: BuiltinModelProgress }
  ): Promise<FeatureExtractionPipeline>
}

let transformersModulePromise: Promise<TransformersModule> | null = null
const builtinPipelines = new Map<string, Promise<FeatureExtractionPipeline>>()

function resolveBuiltinModelCacheDir(): string {
  return path.join(resolveManagedInstallsRoot(), 'memory-embedder', 'models')
}

// '@huggingface/transformers', base64-hidden the same way voiceLocalRuntimePaths hides
// managed paths: @vercel/nft statically evaluates plain string joins, and a resolvable
// specifier would drag onnxruntime's ~300MB binary tree into the hosted registry build's
// serverless bundle (verified 2026-08-25). Buffer.from defeats the evaluator.
const TRANSFORMERS_MODULE_SPECIFIER_BASE64 = 'QGh1Z2dpbmdmYWNlL3RyYW5zZm9ybWVycw=='

async function loadTransformersModule(): Promise<TransformersModule> {
  if (!transformersModulePromise) {
    const specifier = Buffer.from(TRANSFORMERS_MODULE_SPECIFIER_BASE64, 'base64').toString('utf8')
    transformersModulePromise = import(/* @vite-ignore */ specifier).then((mod) => {
      const transformers = mod as unknown as TransformersModule
      transformers.env.cacheDir = resolveBuiltinModelCacheDir()
      return transformers
    })
    transformersModulePromise.catch(() => {
      transformersModulePromise = null
    })
  }
  return transformersModulePromise
}

function getBuiltinPipeline(
  spec: BuiltinModelSpec,
  progressCallback?: BuiltinModelProgress
): Promise<FeatureExtractionPipeline> {
  const existing = builtinPipelines.get(spec.id)
  if (existing) return existing

  const created = loadTransformersModule().then((transformers) =>
    transformers.pipeline('feature-extraction', spec.hfModelId, {
      dtype: spec.dtype,
      progress_callback: progressCallback
    })
  )
  builtinPipelines.set(spec.id, created)
  created.catch(() => {
    builtinPipelines.delete(spec.id)
  })
  return created
}

/**
 * Downloads (first run) and loads a builtin model so memory-enable flows can surface
 * progress before the first embedding call needs it.
 */
export async function ensureBuiltinModelReady(
  modelId: string,
  progressCallback?: BuiltinModelProgress
): Promise<void> {
  await getBuiltinPipeline(requireBuiltinSpec(modelId), progressCallback)
}

class BuiltinMemoryEmbedder implements MemoryEmbedder {
  readonly modelId: string
  readonly dims: number

  constructor(private readonly spec: BuiltinModelSpec) {
    this.modelId = `${spec.id}@${spec.dims}`
    this.dims = spec.dims
  }

  private async run(texts: string[]): Promise<number[][]> {
    const extractor = await getBuiltinPipeline(this.spec)
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    const vectors = output.tolist().map(compactVector)
    assertEmbeddingDims(vectors, this.dims, this.modelId)
    return vectors
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return this.run(texts.map((text) => this.spec.documentTemplate(text)))
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.run([this.spec.queryTemplate(text)])
    return vector
  }
}

// ---------------------------------------------------------------------------
// local-ai lane — OpenAI-compatible runtime through AI SDK embedMany
// ---------------------------------------------------------------------------

class LocalAiMemoryEmbedder implements MemoryEmbedder {
  readonly modelId: string
  readonly dims: number
  private readonly documentPrefix: string
  private readonly queryPrefix: string
  private readonly model: ReturnType<ReturnType<typeof createOpenAI>['embeddingModel']>

  constructor(
    localAi: NonNullable<MemoryEmbeddingConfig['localAi']>,
    // SA-102 P5 (DL-102-14): the key from the ONE shared encrypted store. It
    // wins over the legacy `localAi.apiKey` in `batshit:memory_config`, which
    // was a second place for the same secret.
    sharedApiKey: string | null = null
  ) {
    this.modelId = `local-ai:${localAi.modelName}@${localAi.dims}`
    this.dims = localAi.dims
    this.documentPrefix = localAi.documentPrefix ?? ''
    this.queryPrefix = localAi.queryPrefix ?? ''
    const resolvedKey =
      sharedApiKey?.trim() ||
      (localAi.apiKey && localAi.apiKey.trim().length > 0 ? localAi.apiKey.trim() : '')
    const client = createOpenAI({
      baseURL: localAi.baseUrl,
      // Most local programs require the header but ignore the value; the ones
      // that check it (oMLX, LM Studio 0.4 tokens, vLLM/SGLang --api-key) get
      // the user's stored key.
      apiKey: resolvedKey || 'local-ai'
    })
    this.model = client.embeddingModel(localAi.modelName)
  }

  private async run(values: string[]): Promise<number[][]> {
    const { embeddings } = await embedMany({ model: this.model, values })
    const vectors = embeddings.map(compactVector)
    assertEmbeddingDims(vectors, this.dims, this.modelId)
    return vectors
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return this.run(texts.map((text) => `${this.documentPrefix}${text}`))
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.run([`${this.queryPrefix}${text}`])
    return vector
  }
}

// ---------------------------------------------------------------------------
// api lane — provider embeddings (SA-104 P5; the documented optional upgrade)
// ---------------------------------------------------------------------------

/** Providers the api lane supports in v1. OpenAI is the documented upgrade example. */
export const MEMORY_API_EMBEDDING_PROVIDERS = ['openai'] as const

class ApiMemoryEmbedder implements MemoryEmbedder {
  readonly modelId: string
  readonly dims: number
  private modelPromise: Promise<
    ReturnType<ReturnType<typeof createOpenAI>['embeddingModel']>
  > | null = null

  constructor(
    private readonly api: NonNullable<MemoryEmbeddingConfig['api']>,
    private readonly userId?: string
  ) {
    this.modelId = `api:${api.provider}:${api.modelName}@${api.dims}`
    this.dims = api.dims
  }

  /**
   * Keys are NEVER stored in `batshit:memory_config` (backup secret-exclusion holds).
   * They resolve lazily per process through the standard provider-access path: the
   * user's encrypted key first (when a user context exists), then environment.
   */
  private getModel() {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const provider = this.api.provider.trim().toLowerCase()
        if (provider !== 'openai') {
          throw new Error(
            `Memory embedding lane 'api' supports provider(s) ${MEMORY_API_EMBEDDING_PROVIDERS.join(', ')} in v1 (got '${this.api.provider}'). ` +
              "Use the 'builtin' or 'local-ai' lane for local models."
          )
        }
        const { resolveProviderAccess } = await import('$lib/server/services/providers')
        const access = await resolveProviderAccess(this.userId ?? null)
        const apiKey = access.apiKeys.openai
        if (!apiKey) {
          throw new Error(
            'Memory embedding lane \'api\' needs an OpenAI API key. None was found in ' +
              (this.userId ? 'the saved API keys or environment.' : 'the environment (no user context for saved keys).') +
              ' Add one in Settings → API Keys, or switch the memory embedding lane.'
          )
        }
        return createOpenAI({ apiKey }).embeddingModel(this.api.modelName)
      })()
      this.modelPromise.catch(() => {
        this.modelPromise = null
      })
    }
    return this.modelPromise
  }

  private async run(values: string[]): Promise<number[][]> {
    const model = await this.getModel()
    const { embeddings } = await embedMany({ model, values })
    const vectors = embeddings.map(compactVector)
    assertEmbeddingDims(vectors, this.dims, this.modelId)
    return vectors
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return this.run(texts)
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.run([text])
    return vector
  }
}

// ---------------------------------------------------------------------------
// preset lane — a saved Model Manager preset supplies provider/model/connection
// (2026-08-26; Josh's call: create the embedding model as a utility preset once,
// then just pick it here — cloud or local, one flow)
// ---------------------------------------------------------------------------

/** Local AI runtime ids a preset's `provider` can point at (OpenAI-compatible /v1). */
export const MEMORY_LOCAL_RUNTIME_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'dmr',
  'lmstudio',
  'llama-cpp',
  'vllm'
])

/** Cloud providers with a direct embedding factory in the installed AI SDK set. */
export const MEMORY_PRESET_CLOUD_EMBEDDING_PROVIDERS = ['openai', 'google', 'mistral'] as const

/**
 * Per-model task-prefix contracts we can fill in automatically (the P0 hard finding:
 * skipping nomic's prefixes measurably breaks retrieval). Extend the table as more
 * prefix-contract models become common; unknown models embed bare, which is correct
 * for most (OpenAI, Google, Mistral, MiniLM-style locals).
 */
const KNOWN_EMBEDDING_PREFIXES: ReadonlyArray<{
  match: RegExp
  documentPrefix: string
  queryPrefix: string
}> = [
  { match: /nomic-embed/i, documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' },
  { match: /snowflake-arctic-embed/i, documentPrefix: '', queryPrefix: 'Represent this sentence for searching relevant passages: ' }
]

export function suggestEmbeddingPrefixes(
  modelName: string
): { documentPrefix: string; queryPrefix: string } | null {
  const known = KNOWN_EMBEDDING_PREFIXES.find((entry) => entry.match.test(modelName))
  return known ? { documentPrefix: known.documentPrefix, queryPrefix: known.queryPrefix } : null
}

interface SavedPresetRecordLike {
  id?: string
  modelId?: string
  effectiveModelId?: string
  modelName?: string
  provider?: string
  purpose?: string
  connection?: { type?: string }
}

async function loadSavedPreset(presetId: string): Promise<SavedPresetRecordLike | null> {
  const { redis } = await import('$lib/server/redis')
  return (await redis.get(`model:${presetId}`).catch(() => null)) as SavedPresetRecordLike | null
}

/**
 * Resolves a preset to a concrete embedding target. Pure decision logic over the
 * loaded records so the routing (and every loud failure) is unit-testable without
 * network: the caller supplies the live preset, Local AI summaries, and API keys.
 */
export function resolvePresetEmbeddingTarget(input: {
  presetId: string
  snapshot: { provider: string; modelName: string }
  preset: SavedPresetRecordLike | null
  localAiServers: Array<{ id: string; baseUrl: string; openaiPath?: string; enabled?: boolean }>
  apiKeys: Record<string, string | undefined>
}):
  | { kind: 'openai-compatible'; baseURL?: string; apiKey: string; modelId: string }
  | { kind: 'google' | 'mistral'; apiKey: string; modelId: string } {
  const { preset, snapshot, presetId } = input
  if (!preset) {
    throw new Error(
      `The memory embedding model preset '${presetId}' no longer exists. Pick a preset again in Settings → Memory → Memory System (and re-index if the model changed).`
    )
  }
  const provider = String(preset.provider ?? '').trim().toLowerCase()
  const modelId = String(preset.effectiveModelId ?? preset.modelId ?? '').trim()
  if (
    provider !== snapshot.provider.trim().toLowerCase() ||
    modelId !== snapshot.modelName.trim()
  ) {
    throw new Error(
      `The memory embedding preset '${presetId}' changed since it was saved here (was ${snapshot.provider}/${snapshot.modelName}, now ${provider || '?'}/${modelId || '?'}). ` +
        'Re-save the Memory System configuration and run Re-Index Memories so stored vectors match.'
    )
  }
  const transport = preset.connection?.type
  if (transport === 'openrouter' || transport === 'vercel-gateway') {
    throw new Error(
      `The preset '${presetId}' routes through ${transport}, which has no embeddings endpoint. Use a preset with a direct provider connection.`
    )
  }

  if (MEMORY_LOCAL_RUNTIME_PROVIDERS.has(provider)) {
    const server = input.localAiServers.find((entry) => entry.id === provider)
    if (!server || !server.baseUrl) {
      throw new Error(
        `The preset '${presetId}' points at the local runtime '${provider}', but that runtime has no base URL configured in Settings → Local AI.`
      )
    }
    const baseUrl = server.baseUrl.replace(/\/+$/, '')
    const openaiPath = (server.openaiPath ?? '').replace(/\/+$/, '')
    return {
      kind: 'openai-compatible',
      baseURL: openaiPath ? `${baseUrl}${openaiPath}` : baseUrl,
      apiKey: 'local-ai',
      modelId
    }
  }

  const apiKey = input.apiKeys[provider]
  if (provider === 'openai') {
    if (!apiKey) throw new Error(missingKeyMessage(provider))
    return { kind: 'openai-compatible', apiKey, modelId }
  }
  if (provider === 'google' || provider === 'mistral') {
    if (!apiKey) throw new Error(missingKeyMessage(provider))
    return { kind: provider, apiKey, modelId }
  }
  throw new Error(
    `Memory embeddings support presets on these providers right now: ${MEMORY_PRESET_CLOUD_EMBEDDING_PROVIDERS.join(', ')} (cloud) and the Local AI runtimes (${[...MEMORY_LOCAL_RUNTIME_PROVIDERS].join(', ')}). ` +
      `The preset '${presetId}' uses '${provider}', which has no embeddings path here yet.`
  )
}

function missingKeyMessage(provider: string): string {
  return `The memory embedding preset needs a ${provider} API key and none was found in the saved API keys or environment. Add one in Settings → API Keys.`
}

class PresetMemoryEmbedder implements MemoryEmbedder {
  readonly modelId: string
  readonly dims: number
  private readonly documentPrefix: string
  private readonly queryPrefix: string
  private modelPromise: Promise<Parameters<typeof embedMany>[0]['model']> | null = null

  constructor(
    private readonly preset: NonNullable<MemoryEmbeddingConfig['preset']>,
    private readonly userId?: string
  ) {
    this.modelId = `preset:${preset.provider}:${preset.modelName}@${preset.dims}`
    this.dims = preset.dims
    this.documentPrefix = preset.documentPrefix ?? ''
    this.queryPrefix = preset.queryPrefix ?? ''
  }

  private getModel() {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const record = await loadSavedPreset(this.preset.presetId)
        const { resolveProviderAccess } = await import('$lib/server/services/providers')
        const access = await resolveProviderAccess(this.userId ?? null)
        let localAiServers: Array<{ id: string; baseUrl: string; openaiPath?: string }> = []
        const provider = String(record?.provider ?? '').trim().toLowerCase()
        if (MEMORY_LOCAL_RUNTIME_PROVIDERS.has(provider)) {
          if (!this.userId) {
            throw new Error(
              `The memory embedding preset '${this.preset.presetId}' points at a local runtime, which needs a signed-in user context to resolve its base URL.`
            )
          }
          const { listLocalAiServers } = await import('$lib/server/services/localAiServers')
          localAiServers = await listLocalAiServers(this.userId)
        }
        const target = resolvePresetEmbeddingTarget({
          presetId: this.preset.presetId,
          snapshot: { provider: this.preset.provider, modelName: this.preset.modelName },
          preset: record,
          localAiServers,
          apiKeys: access.apiKeys as Record<string, string | undefined>
        })
        if (target.kind === 'openai-compatible') {
          return createOpenAI({
            apiKey: target.apiKey,
            ...(target.baseURL ? { baseURL: target.baseURL } : {})
          }).embeddingModel(target.modelId)
        }
        if (target.kind === 'google') {
          const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
          return createGoogleGenerativeAI({ apiKey: target.apiKey }).embeddingModel(target.modelId)
        }
        const { createMistral } = await import('@ai-sdk/mistral')
        return createMistral({ apiKey: target.apiKey }).embeddingModel(target.modelId)
      })()
      this.modelPromise.catch(() => {
        this.modelPromise = null
      })
    }
    return this.modelPromise
  }

  private async run(values: string[]): Promise<number[][]> {
    const model = await this.getModel()
    const { embeddings } = await embedMany({ model, values })
    const vectors = embeddings.map(compactVector)
    // dims === 0 is probe mode (dimension auto-detection at config save).
    if (this.dims > 0) assertEmbeddingDims(vectors, this.dims, this.modelId)
    return vectors
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return this.run(texts.map((text) => `${this.documentPrefix}${text}`))
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.run([`${this.queryPrefix}${text}`])
    return vector
  }
}

/**
 * Embeds one probe string through the preset path to measure the model's true
 * output dimensionality — so users never have to know what "768" means.
 */
export async function detectPresetEmbeddingDims(
  preset: Omit<NonNullable<MemoryEmbeddingConfig['preset']>, 'dims'>,
  options?: CreateMemoryEmbedderOptions & {
    /** Test seam: replaces the real network probe. */
    probe?: (embedder: MemoryEmbedder) => Promise<number[]>
  }
): Promise<number> {
  const embedder = new PresetMemoryEmbedder(
    { ...preset, dims: 0 },
    options?.userId ?? undefined
  )
  const vector = options?.probe
    ? await options.probe(embedder)
    : await embedder.embedQuery('Batshit memory embedding dimension probe.')
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('The embedding model returned an empty vector during dimension detection.')
  }
  return vector.length
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface CreateMemoryEmbedderOptions {
  /** User context for api-lane key resolution (saved keys before env). */
  userId?: string | null
  /**
   * SA-102 P5 (DL-102-14): the local program's key from the one shared
   * encrypted store. Resolved by the caller because the store read is async and
   * this factory is deliberately synchronous.
   */
  localAiApiKey?: string | null
}

export function createMemoryEmbedder(
  config: MemoryEmbeddingConfig,
  options?: CreateMemoryEmbedderOptions
): MemoryEmbedder {
  switch (config.lane) {
    case 'builtin':
      return new BuiltinMemoryEmbedder(requireBuiltinSpec(config.modelId))
    case 'preset':
      return new PresetMemoryEmbedder(requirePresetConfig(config), options?.userId ?? undefined)
    case 'local-ai':
      return new LocalAiMemoryEmbedder(requireLocalAiConfig(config), options?.localAiApiKey ?? null)
    case 'api':
      return new ApiMemoryEmbedder(requireApiConfig(config), options?.userId ?? undefined)
    default:
      throw new Error(`Unknown memory embedding lane '${(config as MemoryEmbeddingConfig).lane}'.`)
  }
}

/**
 * SA-102 P5 (DL-102-14): the async front door for the `local-ai` lane.
 *
 * `createMemoryEmbedder` stays synchronous — most lanes need nothing async —
 * but the local lane's key now lives in the shared encrypted store, and reading
 * it is async. This resolves that one value (migrating a legacy
 * `batshit:memory_config` key into the store on the way) and then calls the
 * factory. Every caller that may hit the local lane should use this.
 */
export async function createMemoryEmbedderAsync(
  config: MemoryEmbeddingConfig,
  options?: CreateMemoryEmbedderOptions
): Promise<MemoryEmbedder> {
  if (config.lane !== 'local-ai') {
    return createMemoryEmbedder(config, options)
  }
  const { resolveMemoryLocalAiApiKey } = await import(
    '$lib/server/services/localProgramApiKeys'
  )
  const resolved = await resolveMemoryLocalAiApiKey({
    baseUrl: config.localAi?.baseUrl ?? null,
    configuredApiKey: config.localAi?.apiKey ?? null,
    userId: options?.userId ?? null
  })
  return createMemoryEmbedder(config, { ...options, localAiApiKey: resolved.apiKey })
}
