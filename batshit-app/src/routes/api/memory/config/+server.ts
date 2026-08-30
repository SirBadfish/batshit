import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  getMemoryConfig,
  getMemoryIndexMeta,
  setMemoryConfig
} from '$lib/server/services/memory/memoryIndex'
import {
  BUILTIN_EMBEDDING_MODELS,
  canonicalEmbeddingModelId,
  detectPresetEmbeddingDims,
  MEMORY_API_EMBEDDING_PROVIDERS,
  suggestEmbeddingPrefixes
} from '$lib/server/services/memory/memoryEmbedder'
import { redis } from '$lib/server/redis'
import type { MemoryEmbeddingConfig } from '$lib/server/services/memory/memoryTypes'

const MASKED_KEY = '***'

function maskConfig(config: MemoryEmbeddingConfig): MemoryEmbeddingConfig {
  if (!config.localAi?.apiKey) return config
  return { ...config, localAi: { ...config.localAi, apiKey: MASKED_KEY } }
}

/**
 * SA-104 P5 — instance-level memory system configuration (`batshit:memory_config`)
 * plus the built-index state (`batshit:memory_index_meta`). Changing the embedding
 * model here does NOT silently re-index: the boot/write guards refuse mismatched
 * state loudly until the explicit reindex route runs (DL-104-10) — the panel drives
 * both steps together.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const [config, meta] = await Promise.all([getMemoryConfig(), getMemoryIndexMeta()])
    let indexMismatch = false
    if (meta) {
      try {
        indexMismatch = canonicalEmbeddingModelId(config.embedding) !== meta.embedding_model
      } catch {
        // An invalid stored config cannot match any built index.
        indexMismatch = true
      }
    }
    return json({
      embedding: maskConfig(config.embedding),
      indexMeta: meta,
      indexMismatch,
      builtinModels: BUILTIN_EMBEDDING_MODELS.map((model) => ({
        id: model.id,
        dims: model.dims
      })),
      apiProviders: [...MEMORY_API_EMBEDDING_PROVIDERS]
    })
  } catch (error) {
    console.error('[Memory Config] Load failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load memory config' },
      { status: 500 }
    )
  }
}

export const PUT: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { embedding?: MemoryEmbeddingConfig }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body?.embedding || typeof body.embedding !== 'object') {
    return json({ error: 'embedding configuration is required' }, { status: 400 })
  }

  try {
    const incoming = body.embedding
    // A masked local-ai key means "keep the stored one".
    if (incoming.localAi?.apiKey === MASKED_KEY) {
      const stored = (await getMemoryConfig()).embedding
      incoming.localAi = {
        ...incoming.localAi,
        apiKey: stored.localAi?.apiKey
      }
      if (!incoming.localAi.apiKey) delete incoming.localAi.apiKey
    }

    // preset lane (2026-08-26): the client sends the presetId plus optional
    // overrides; the SERVER snapshots provider/model from the live preset,
    // auto-fills known per-model prefixes, and probes the model once for its
    // true dimensionality when dims were not supplied. Loud failures here are
    // the design — a config that cannot embed must not be storable.
    if (incoming.lane === 'preset') {
      const presetId = String(incoming.preset?.presetId ?? '').trim()
      if (!presetId) {
        return json({ error: 'Choose a model preset for the embedding source.' }, { status: 400 })
      }
      const preset = (await redis.get(`model:${presetId}`).catch(() => null)) as Record<
        string,
        any
      > | null
      if (!preset) {
        return json(
          {
            error: `Model preset '${presetId}' was not found. Create a utility model preset in Settings → Models first.`
          },
          { status: 400 }
        )
      }
      const provider = String(preset.provider ?? '').trim().toLowerCase()
      const modelName = String(preset.modelId ?? '').trim()
      if (!provider || !modelName) {
        return json(
          { error: `Model preset '${presetId}' has no provider/model to embed with.` },
          { status: 400 }
        )
      }
      const suggested = suggestEmbeddingPrefixes(modelName)
      const documentPrefix =
        incoming.preset?.documentPrefix !== undefined
          ? incoming.preset.documentPrefix
          : suggested?.documentPrefix || undefined
      const queryPrefix =
        incoming.preset?.queryPrefix !== undefined
          ? incoming.preset.queryPrefix
          : suggested?.queryPrefix || undefined
      const base = { presetId, provider, modelName, documentPrefix, queryPrefix }
      const requestedDims = Number(incoming.preset?.dims ?? 0)
      const dims =
        Number.isFinite(requestedDims) && requestedDims > 0
          ? Math.floor(requestedDims)
          : await detectPresetEmbeddingDims(base, { userId: user.value.id })
      incoming.preset = { ...base, dims }
      incoming.modelId = `preset:${provider}:${modelName}`
    }

    const record = await setMemoryConfig(incoming)
    const meta = await getMemoryIndexMeta()
    return json({ embedding: maskConfig(record.embedding), indexMeta: meta })
  } catch (error) {
    console.error('[Memory Config] Save failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to save memory config' },
      { status: 400 }
    )
  }
}
