import { error, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { logger } from '$lib/utils/logger'
import { StreamEventAdapter } from '$lib/server/services/streamEventAdapter'
import { redis } from '$lib/server/redis'
import { generateMessageId } from '$lib/utils/messageId'
import { VercelAIBrain } from '$lib/server/services/vercelBrain'
import { ProviderManager } from '$lib/server/services/providers'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
// SA-011 Phase 1: Image generation support
import { generateImage } from 'ai'
// SA-011 Phase 3: Speech/TTS generation support
import { generateSpeech } from 'ai'
// SA-011 Phase 4: Structured object streaming support
import { streamText, Output, jsonSchema } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createLuma } from '@ai-sdk/luma'
import { createFal } from '@ai-sdk/fal'
import { createReplicate } from '@ai-sdk/replicate'
import { isDedicatedImageModel, detectImageModel, getImageProviderInfo } from '$lib/server/services/imageModelDetection'
import { isDedicatedSpeechModel, detectSpeechModel, getSpeechProviderInfo } from '$lib/server/services/speechModelDetection'
import { fetchVercelModelCatalog, type VercelCatalogEntry } from '$lib/server/services/vercelModelCatalog'
import type { ArtifactModelConfig, ArtifactModelRole } from '$lib/types/artifacts'
import { normalizeArtifactModelConfig } from '$lib/utils/artifactModelConfig'
import type { ModelConnectionInfo, ModelPurpose, SavedModel } from '$lib/types/savedModels'
import {
  isOpaqueArtifactRuntimeRequest,
  requireArtifactRuntimeClaims,
  resolveArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'
import {
  rewriteLoopbackUrlToDockerHostForRuntime,
  rewriteN8nWebhookUrlForRuntime
} from '$lib/server/services/runtimeUrlRewrites'
import {
  finishArtifactRunLog,
  markArtifactRunPrepared,
  recordArtifactRunEvent,
  startArtifactRunLog
} from '$lib/server/artifacts/artifactRunLogs'


const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_REQUESTS = 10
const MAX_PAYLOAD_CHARS = 20000
const MAX_IMAGE_INPUT_PAYLOAD_CHARS = 30_000_000
const DEFAULT_ARTIFACT_TEXT_MAX_TOKENS = 8192

async function resolveSavedArtifactApiKey(service: string, userId: string): Promise<string | null> {
  return await apiKeyService.retrieve(service, userId).catch(() => null)
}

async function resolveOpenAIApiKey(userId: string): Promise<string | null> {
  return await resolveSavedArtifactApiKey('openai', userId)
}

async function resolveFalApiKey(userId: string): Promise<string | null> {
  return await resolveSavedArtifactApiKey('fal', userId)
}

async function resolveLumaApiKey(userId: string): Promise<string | null> {
  return await resolveSavedArtifactApiKey('luma', userId)
}

async function resolveReplicateApiKey(userId: string): Promise<string | null> {
  return await resolveSavedArtifactApiKey('replicate', userId)
}

async function resolveXaiApiKey(userId: string): Promise<string | null> {
  return await resolveSavedArtifactApiKey('xai', userId)
}

type CompletionTransport = 'mode3' | 'webhook'
type WebhookBrainType = 'webhook' | 'n8n_workflow' | 'custom_webhook'

function artifactErrorMessage(err: unknown, fallback = 'Artifact completion failed'): string {
  if (typeof err === 'string' && err.trim()) {
    return err.trim()
  }

  if (err && typeof err === 'object') {
    const anyError = err as { message?: unknown; body?: unknown }
    if (typeof anyError.message === 'string' && anyError.message.trim()) {
      return anyError.message
    }
    const bodyMessage =
      anyError.body && typeof anyError.body === 'object'
        ? (anyError.body as Record<string, unknown>).message
        : null
    if (typeof bodyMessage === 'string' && bodyMessage.trim()) {
      return bodyMessage
    }
  }
  return fallback
}

class ArtifactStreamWriteError extends Error {
  readonly eventType: string
  readonly originalError: unknown

  constructor(eventType: string, originalError: unknown) {
    super(`Artifact completion stream closed before the ${eventType} event could be delivered`)
    this.name = 'ArtifactStreamWriteError'
    this.eventType = eventType
    this.originalError = originalError
  }
}

function isArtifactStreamWriteError(err: unknown): err is ArtifactStreamWriteError {
  return err instanceof ArtifactStreamWriteError ||
    Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'ArtifactStreamWriteError')
}

function artifactErrorLogValue(err: unknown, fallback = 'unknown error'): unknown {
  if (err instanceof ArtifactStreamWriteError) {
    return {
      message: err.message,
      eventType: err.eventType,
      originalError: artifactErrorLogValue(err.originalError, 'stream writer rejected without an error object')
    }
  }
  if (err instanceof Error) return err
  if (err === undefined) return `${fallback} (undefined)`
  if (err === null) return `${fallback} (null)`
  const message = artifactErrorMessage(err, fallback)
  return message || fallback
}

async function resolveArtifactWebhookUrlForRuntime(
  webhookUrl: string,
  brainType: WebhookBrainType,
  userId: string
): Promise<string> {
  if (brainType === 'n8n_workflow') {
    const savedN8nApiUrl = await apiKeyService.retrieve('n8n_api_url', userId).catch(() => null)
    return rewriteN8nWebhookUrlForRuntime(webhookUrl, savedN8nApiUrl) ?? webhookUrl
  }

  return rewriteLoopbackUrlToDockerHostForRuntime(webhookUrl) ?? webhookUrl
}

// SA-011 Phase 2: Reference image types
interface ImageReference {
  url?: string          // URL to image
  data?: string         // Base64 data URL
  mediaType?: string    // e.g., 'image/png'
  weight?: number       // 0-1, influence weight
}

interface LumaProviderOptions {
  style_ref?: ImageReference[]
  character_ref?: {
    identity0?: { images: string[] }
  }
  modify_image_ref?: ImageReference
  image_ref?: ImageReference[]
}

interface FalProviderOptions {
  image_url?: string
  image_size?: string
  imageSize?: string
  num_images?: number
  numImages?: number
  num_inference_steps?: number
  numInferenceSteps?: number
  guidance_scale?: number
  guidanceScale?: number
  seed?: number
  negative_prompt?: string
  negativePrompt?: string
  enable_safety_checker?: boolean
  enableSafetyChecker?: boolean
  sync_mode?: boolean
  syncMode?: boolean
  output_format?: 'png' | 'jpeg'
  outputFormat?: 'png' | 'jpeg'
  enable_prompt_expansion?: boolean
  enablePromptExpansion?: boolean
  [key: string]: any
}

interface XaiProviderOptions {
  resolution?: string
}

interface ProviderOptions {
  luma?: LumaProviderOptions
  fal?: FalProviderOptions
  xai?: XaiProviderOptions
}

type GeneratedImageSummary = {
  base64: string
  mediaType?: string
}

type DirectOpenAIImageResult = {
  images: GeneratedImageSummary[]
  usage?: Record<string, unknown>
}

interface PresetVisualOptions {
  n?: number
  size?: string
  aspectRatio?: string
}

interface PresetAudioOptions {
  voice?: string
  language?: string
  instructions?: string
}

interface CompletionRequestBody {
  artifactId?: string
  prompt?: string
  context?: any
  mode?: string
  webhookUrl?: string | null
  sessionId?: string | null
  model?: string | null
  userId?: string | null
  // SA-011 Phase 1: Image generation options
  n?: number            // Number of images to generate
  size?: string         // Image size for providers that support dimensions (e.g., '1024x1024')
  aspectRatio?: string  // Aspect ratio for Luma/Fal (e.g., '16:9')
  // SA-011 Phase 2: Reference image options
  images?: ImageReference[]       // Reference images for editing
  providerOptions?: ProviderOptions  // Provider-specific options
  // SA-011 Phase 3: Speech/TTS options
  voice?: string        // Voice to use (e.g., 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer')
  language?: string     // Language code (e.g., 'en', 'es')
  instructions?: string // Voice instructions (for gpt-4o-mini-tts)
  // SA-011 Phase 4: Structured object streaming options
  schema?: any          // JSON Schema for structured output
  schemaName?: string   // Optional name for the schema
  schemaDescription?: string  // Optional description
  // SA-042: Fabric field values for typed invocation
  fields?: Record<string, any> | null
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

const FAL_OPTION_KEY_MAP: Record<string, string> = {
  image_size: 'imageSize',
  num_images: 'numImages',
  num_inference_steps: 'numInferenceSteps',
  guidance_scale: 'guidanceScale',
  enable_safety_checker: 'enableSafetyChecker',
  output_format: 'outputFormat',
  sync_mode: 'syncMode',
  enable_prompt_expansion: 'enablePromptExpansion',
  negative_prompt: 'negativePrompt'
}

function normalizeFalOptions(options: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    const mappedKey = FAL_OPTION_KEY_MAP[key] ?? key
    normalized[mappedKey] = value
  }
  return normalized
}

function normalizeOpenAIImageMediaType(format: unknown): string {
  if (typeof format !== 'string') return 'image/png'
  const normalized = format.trim().toLowerCase()
  if (normalized === 'jpeg' || normalized === 'jpg') return 'image/jpeg'
  if (normalized === 'webp') return 'image/webp'
  return 'image/png'
}

function mediaTypeFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl)
  return match?.[1] ?? null
}

function extractOpenAIImageError(payload: unknown, statusText: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, any>
    if (typeof record.error?.message === 'string' && record.error.message.trim()) {
      return record.error.message
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message
    }
  }
  return statusText || 'OpenAI image generation failed'
}

function extractXAIImageError(payload: unknown, statusText: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, any>
    if (typeof record.error?.message === 'string' && record.error.message.trim()) {
      return record.error.message
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message
    }
    if (typeof record.detail === 'string' && record.detail.trim()) {
      return record.detail
    }
  }
  return statusText || 'xAI image generation failed'
}

function parseJsonPayload(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function providerErrorBodySnippet(text: string): string | null {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return null
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact
}

async function generatedImageFromOpenAIUrl(url: string): Promise<GeneratedImageSummary> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OpenAI returned an image URL, but Batshit could not fetch it (${response.status} ${response.statusText})`)
  }
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    base64: `data:${mediaType};base64,${bytes.toString('base64')}`,
    mediaType
  }
}

async function generatedImageFromXAIUrl(url: string): Promise<GeneratedImageSummary> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`xAI returned an image URL, but Batshit could not fetch it (${response.status} ${response.statusText})`)
  }
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg'
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    base64: `data:${mediaType};base64,${bytes.toString('base64')}`,
    mediaType
  }
}

async function generateOpenAIImageDirect({
  apiKey,
  model,
  prompt,
  n,
  size
}: {
  apiKey: string
  model: string
  prompt: string
  n: number
  size?: string
}): Promise<DirectOpenAIImageResult> {
  const requestBody: Record<string, unknown> = {
    model,
    prompt,
    n
  }
  if (size && size.trim()) {
    requestBody.size = size.trim()
  }

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractOpenAIImageError(payload, response.statusText))
  }

  const data = Array.isArray((payload as any)?.data) ? (payload as any).data : []
  const mediaType = normalizeOpenAIImageMediaType((payload as any)?.output_format)
  const images: GeneratedImageSummary[] = []

  for (const image of data) {
    if (typeof image?.b64_json === 'string' && image.b64_json.trim()) {
      images.push({
        base64: `data:${mediaType};base64,${image.b64_json}`,
        mediaType
      })
      continue
    }

    if (typeof image?.url === 'string' && image.url.trim()) {
      images.push(await generatedImageFromOpenAIUrl(image.url))
    }
  }

  return {
    images,
    usage:
      (payload as any)?.usage && typeof (payload as any).usage === 'object'
        ? (payload as any).usage
        : {}
  }
}

function imageReferenceToXAIImage(image: ImageReference): { type: 'image_url'; url: string } | null {
  const url = coerceString(image.url) ?? coerceString(image.data)
  if (!url) return null
  return { type: 'image_url', url }
}

async function fetchXAIImages({
  apiKey,
  endpoint,
  requestBody
}: {
  apiKey: string
  endpoint: 'generations' | 'edits'
  requestBody: Record<string, unknown>
}): Promise<DirectOpenAIImageResult> {
  const response = await fetch(`https://api.x.ai/v1/images/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })

  const responseText = await response.text().catch(() => '')
  const payload = parseJsonPayload(responseText)
  if (!response.ok) {
    const extracted = extractXAIImageError(payload, response.statusText)
    const bodySnippet = payload ? null : providerErrorBodySnippet(responseText)
    throw new Error(bodySnippet ? `${extracted}: ${bodySnippet}` : extracted)
  }

  const data = Array.isArray((payload as any)?.data) ? (payload as any).data : []
  const images: GeneratedImageSummary[] = []

  for (const image of data) {
    const mediaType =
      coerceString(image?.mime_type) ??
      coerceString(image?.mimeType) ??
      normalizeOpenAIImageMediaType((payload as any)?.output_format)

    if (typeof image?.b64_json === 'string' && image.b64_json.trim()) {
      images.push({
        base64: `data:${mediaType};base64,${image.b64_json}`,
        mediaType
      })
      continue
    }

    if (typeof image?.url === 'string' && image.url.trim()) {
      images.push(await generatedImageFromXAIUrl(image.url))
    }
  }

  return {
    images,
    usage:
      (payload as any)?.usage && typeof (payload as any).usage === 'object'
        ? (payload as any).usage
        : {}
  }
}

async function generateXAIImageDirect({
  apiKey,
  model,
  prompt,
  n,
  aspectRatio,
  resolution,
  images: inputImages
}: {
  apiKey: string
  model: string
  prompt: string
  n: number
  aspectRatio?: string
  resolution?: string
  images?: ImageReference[]
}): Promise<DirectOpenAIImageResult> {
  const sourceImages = (inputImages ?? [])
    .map((image) => imageReferenceToXAIImage(image))
    .filter((image): image is { type: 'image_url'; url: string } => Boolean(image))
    .slice(0, 3)
  const safeCount = Math.min(Math.max(1, Math.floor(n || 1)), 10)
  const commonBody: Record<string, unknown> = {
    model,
    prompt
  }
  const trimmedResolution = coerceString(resolution)
  if (trimmedResolution) commonBody.resolution = trimmedResolution

  const trimmedAspectRatio = coerceString(aspectRatio)
  if (trimmedAspectRatio && trimmedAspectRatio !== 'auto') {
    commonBody.aspect_ratio = trimmedAspectRatio
  }

  if (sourceImages.length === 0) {
    return await fetchXAIImages({
      apiKey,
      endpoint: 'generations',
      requestBody: {
        ...commonBody,
        response_format: 'b64_json',
        n: safeCount
      }
    })
  }

  const editBody: Record<string, unknown> = { ...commonBody }
  if (sourceImages.length === 1) {
    editBody.image = sourceImages[0]
    // xAI preserves the source aspect ratio for single-image edits.
    delete editBody.aspect_ratio
  } else {
    editBody.images = sourceImages
  }

  const combined: DirectOpenAIImageResult = { images: [], usage: {} }
  for (let index = 0; index < safeCount; index += 1) {
    const result = await fetchXAIImages({
      apiKey,
      endpoint: 'edits',
      requestBody: editBody
    })
    combined.images.push(...result.images)
    combined.usage = {
      ...combined.usage,
      [`edit_${index + 1}`]: result.usage ?? {}
    }
  }

  return combined
}

function resolvePresetVisualOptions(
  settings?: Record<string, any> | null
): PresetVisualOptions {
  if (!settings) return {}
  return {
    n: coerceNumber(settings.n),
    size: coerceString(settings.size),
    aspectRatio: coerceString(settings.aspectRatio)
  }
}

function resolvePresetAudioOptions(
  settings?: Record<string, any> | null
): PresetAudioOptions {
  if (!settings) return {}
  return {
    voice: coerceString(settings.voice),
    language: coerceString(settings.language),
    instructions: coerceString(settings.instructions)
  }
}

type ResolvedArtifactModel = {
  modelId: string | null
  connection?: ModelConnectionInfo | null
  providerSettings?: Record<string, any> | null
  purpose?: ModelPurpose | null
  visualMediaKind?: ArtifactVisualMediaKind | null
  source: 'auto' | 'preset' | 'manual' | 'primary' | 'none'
}

type ArtifactVisualMediaKind = 'image' | 'video' | '3d' | 'unknown'

type CatalogVariantEntry = {
  connectionId: string | null
  variant: {
    developerId?: string
    modelId?: string
    effectiveId?: string
    source?: string
  } | null
}

type CatalogModelMetadata = {
  connection: ModelConnectionInfo | null
  purpose: ModelPurpose | null
  visualMediaKind: ArtifactVisualMediaKind | null
  providerSettings: Record<string, any> | null
}

function normalizeCatalogLookupTerm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function catalogVariantEntries(entry: VercelCatalogEntry): CatalogVariantEntry[] {
  const variants = Object.entries(entry.idVariants ?? {}).map(([connectionId, variant]) => ({
    connectionId,
    variant
  }))
  if (variants.length > 0) return variants
  return [{ connectionId: entry.connectionId ?? null, variant: null }]
}

function catalogVariantMatchesModel(entry: VercelCatalogEntry, variantEntry: CatalogVariantEntry, modelId: string): boolean {
  const requested = normalizeCatalogLookupTerm(modelId)
  if (!requested) return false
  const variant = variantEntry.variant
  const candidates = [
    entry.id,
    entry.canonicalId,
    entry.name,
    variant?.effectiveId,
    variant?.modelId
  ]
  return candidates.some((candidate) => normalizeCatalogLookupTerm(candidate) === requested)
}

function catalogVariantScore(variantEntry: CatalogVariantEntry, preferredConnection?: ModelConnectionInfo | null): number {
  const connectionId = normalizeCatalogLookupTerm(variantEntry.connectionId)
  const preferredId = normalizeCatalogLookupTerm(preferredConnection?.id)
  const preferredService = normalizeCatalogLookupTerm(preferredConnection?.service)
  const source = normalizeCatalogLookupTerm(variantEntry.variant?.source)
  let score = 0
  if (preferredId && connectionId === preferredId) score += 30
  if (preferredService && connectionId === `direct:${preferredService}`) score += 25
  if (connectionId.startsWith('direct:') || source === 'direct') score += 10
  if (connectionId === 'vercel-gateway' || source === 'vercel') score += 5
  return score
}

function selectMatchingCatalogVariant(
  entry: VercelCatalogEntry,
  modelId: string,
  preferredConnection?: ModelConnectionInfo | null
): CatalogVariantEntry | null {
  const matches = catalogVariantEntries(entry).filter((variantEntry) =>
    catalogVariantMatchesModel(entry, variantEntry, modelId)
  )
  if (!matches.length) return null
  return matches.sort((left, right) =>
    catalogVariantScore(right, preferredConnection) - catalogVariantScore(left, preferredConnection)
  )[0]
}

function modelConnectionFromCatalog(
  entry: VercelCatalogEntry,
  selected: CatalogVariantEntry | null
): ModelConnectionInfo | null {
  const connectionId = selected?.connectionId ?? entry.connectionId ?? null
  const variantSource = normalizeCatalogLookupTerm(selected?.variant?.source)
  const entryTransport = normalizeCatalogLookupTerm(entry.transport)

  if (connectionId?.startsWith('direct:') || variantSource === 'direct') {
    const service =
      connectionId?.startsWith('direct:')
        ? connectionId.slice('direct:'.length)
        : entry.upstreamProvider ?? entry.provider
    return {
      id: connectionId ?? (service ? `direct:${service}` : undefined),
      type: 'direct',
      service: service || undefined
    }
  }

  if (connectionId === 'vercel-gateway' || variantSource === 'vercel' || (!connectionId && entryTransport === 'vercel-gateway')) {
    return { id: connectionId ?? 'vercel-gateway', type: 'vercel-gateway' }
  }

  if (connectionId?.startsWith('openrouter') || variantSource === 'openrouter' || entryTransport === 'openrouter') {
    return { id: connectionId ?? 'openrouter', type: 'openrouter', service: 'openrouter' }
  }

  return null
}

function inferConnectionFromModelId(modelId: string): ModelConnectionInfo | null {
  const imageProvider = detectImageModel(modelId).provider
  const speechProvider = detectSpeechModel(modelId).provider
  const provider = imageProvider ?? speechProvider
  if (!provider || provider === 'azure' || provider === 'google') return null
  return { id: `direct:${provider}`, type: 'direct', service: provider }
}

function lowerIncludesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

function detectArtifactVisualMediaKind({
  modelId,
  purpose,
  displayName,
  tags,
  features
}: {
  modelId: string
  purpose?: ModelPurpose | null
  displayName?: string | null
  tags?: string[] | null
  features?: Record<string, any> | null
}): ArtifactVisualMediaKind | null {
  if (detectImageModel(modelId).type !== 'text-only') return 'image'
  if (purpose !== 'visual') return null

  const featureRecord = features ?? {}
  if (featureRecord.videoGeneration === true || featureRecord.video === true) return 'video'
  if (featureRecord.threeD === true || featureRecord['3d'] === true || featureRecord.mesh === true) return '3d'
  if (
    featureRecord.imageGeneration === true ||
    featureRecord.image === true ||
    featureRecord.images === true ||
    featureRecord.textToImage === true ||
    featureRecord.image_generation === true
  ) {
    return 'image'
  }

  const searchable = [modelId, displayName ?? '', ...(tags ?? [])].join(' ').toLowerCase()
  if (lowerIncludesAny(searchable, ['video', 'sora', 'veo', 'runway', 'kling', 'pika', 'ray-', 'ray ', 'wan-'])) {
    return 'video'
  }
  if (lowerIncludesAny(searchable, ['3d', 'mesh', 'meshy', 'tripo', 'rodin'])) {
    return '3d'
  }
  if (
    lowerIncludesAny(searchable, [
      'image',
      'gpt-image',
      'dall-e',
      'dalle',
      'imagen',
      'flux',
      'photon',
      'stable-diffusion',
      'sdxl',
      'firefly',
      'ideogram',
      'recraft',
      'seedream',
      'nano-banana',
      'grok-imagine',
      'imagine-image'
    ])
  ) {
    return 'image'
  }

  return 'unknown'
}

function inferModelMetadataFromId(modelId: string, role?: ArtifactModelRole): CatalogModelMetadata {
  const isImage = detectImageModel(modelId).type !== 'text-only'
  const isSpeech = detectSpeechModel(modelId).type === 'dedicated'
  const purpose: ModelPurpose | null =
    isImage || role === 'visual'
      ? 'visual'
      : isSpeech || role === 'audio'
        ? 'audio'
        : null
  return {
    connection: inferConnectionFromModelId(modelId),
    purpose,
    visualMediaKind: purpose === 'visual'
      ? detectArtifactVisualMediaKind({ modelId, purpose })
      : null,
    providerSettings: null
  }
}

async function resolveModelMetadataFromCatalog(
  modelId: string,
  role?: ArtifactModelRole,
  preferredConnection?: ModelConnectionInfo | null
): Promise<CatalogModelMetadata> {
  const fallback = inferModelMetadataFromId(modelId, role)
  try {
    const catalog = await fetchVercelModelCatalog(false)
    for (const entry of catalog.models) {
      const selected = selectMatchingCatalogVariant(entry, modelId, preferredConnection)
      if (!selected) continue
      const purpose = entry.purpose ?? fallback.purpose
      const catalogConnection = modelConnectionFromCatalog(entry, selected)
      return {
        connection: fallback.connection?.service === 'xai'
          ? fallback.connection
          : catalogConnection ?? fallback.connection,
        purpose,
        visualMediaKind: purpose === 'visual'
          ? detectArtifactVisualMediaKind({
              modelId,
              purpose,
              displayName: entry.displayName,
              tags: entry.tags,
              features: entry.features
            })
          : null,
        providerSettings: null
      }
    }
  } catch (err) {
    console.warn('[Artifacts] Model catalog lookup failed during artifact model resolution:', err)
  }
  return fallback
}

function resolveArtifactRoleForMode(mode?: string | null): ArtifactModelRole {
  const normalized = (mode ?? '').toLowerCase()
  if (normalized === 'speech') return 'audio'
  if (normalized === 'generate' || normalized === 'edit' || normalized === 'image') return 'visual'
  if (normalized === 'embedding' || normalized === 'embed' || normalized === 'rerank' || normalized === 'vector') {
    return 'utility'
  }
  return 'primary'
}

function resolveRoleConfig(config: ArtifactModelConfig, role: ArtifactModelRole) {
  if (config.mode !== 'advanced') {
    return config.primary
  }
  if (role === 'primary') return config.primary
  const roleConfig = (config as Record<string, any>)[role] as any
  return roleConfig ?? { source: 'primary' }
}

async function resolveModelForRole({
  config,
  role
}: {
  config: ArtifactModelConfig
  role: ArtifactModelRole
}): Promise<ResolvedArtifactModel> {
  let roleConfig = resolveRoleConfig(config, role)

  if (role !== 'primary' && roleConfig.source === 'primary') {
    roleConfig = config.primary
  }

  if (roleConfig.source === 'primary') {
    roleConfig = { source: 'auto' }
  }

  if (roleConfig.source === 'none') {
    return { modelId: null, source: 'none' }
  }

  if (roleConfig.source === 'preset' && roleConfig.presetId) {
    const preset = (await redis.get(`model:${roleConfig.presetId}`)) as SavedModel | null
    if (preset?.modelId) {
      const effectiveModelId = preset.effectiveModelId ?? preset.modelId
      const catalogMetadata = await resolveModelMetadataFromCatalog(
        effectiveModelId,
        role,
        preset.connection ?? null
      )
      return {
        modelId: effectiveModelId,
        connection: preset.connection ?? catalogMetadata.connection ?? null,
        providerSettings: preset.settings ?? null,
        purpose: preset.purpose ?? catalogMetadata.purpose ?? null,
        visualMediaKind: catalogMetadata.visualMediaKind,
        source: 'preset'
      }
    }
  }

  if (roleConfig.source === 'manual' && roleConfig.modelId) {
    const catalogMetadata = await resolveModelMetadataFromCatalog(roleConfig.modelId, role)
    return {
      modelId: roleConfig.modelId,
      connection: catalogMetadata.connection,
      providerSettings: catalogMetadata.providerSettings,
      purpose: catalogMetadata.purpose,
      visualMediaKind: catalogMetadata.visualMediaKind,
      source: 'manual'
    }
  }

  return {
    modelId: null,
    source: roleConfig.source
  }
}

function validatePayloadSize(body: CompletionRequestBody) {
  const imagePayloadChars = Array.isArray(body.images)
    ? body.images.reduce((total, image) => {
        const data = typeof image?.data === 'string' ? image.data : ''
        return total + data.length
      }, 0)
    : 0
  if (imagePayloadChars > MAX_IMAGE_INPUT_PAYLOAD_CHARS) {
    throw error(413, 'Artifact image input payload too large')
  }

  const bodyForTextLimit = {
    ...body,
    images: Array.isArray(body.images)
      ? body.images.map((image) => ({
          ...image,
          data: typeof image?.data === 'string'
            ? `[image data ${image.data.length} chars]`
            : image?.data
        }))
      : body.images
  }
  const serialized = JSON.stringify(bodyForTextLimit)
  if (serialized.length > MAX_PAYLOAD_CHARS) {
    throw error(413, 'Artifact completion payload too large')
  }
}

async function enforceRateLimit(userId: string, artifactId: string) {
  const key = `ratelimit:artifact:${userId}:${artifactId}`
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS)
  }

  if (count > RATE_LIMIT_MAX_REQUESTS) {
    const ttl = await redis.ttl(key)
    const err = new Error('Rate limit exceeded')
    ;(err as any).retryAfter = ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SECONDS
    ;(err as any).limit = RATE_LIMIT_MAX_REQUESTS
    throw error(429, err)
  }
}

async function loadArtifact(artifactId: string) {
  const artifact = await redis.json.get(`artifact:${artifactId}`)
  if (!artifact) {
    throw error(404, 'Artifact not found')
  }
  return artifact as any
}

async function ensureAccess(artifact: any, userId: string) {
  const owned = artifact.user_id === userId
  const published = artifact.mode === 'published'
  if (!owned && !published) {
    throw error(403, 'Access denied')
  }
}

function buildSystemPrompt(artifact: any, globalPrompt?: string | null): string {
  const pieces: string[] = []
  if (globalPrompt) {
    pieces.push(`==== BATSHIT ARTIFACTS SYSTEM PROMPT ====`)
    pieces.push(globalPrompt)
  }

  const artifactPrompt = artifact.system_prompt || artifact.custom_prompt
  if (artifactPrompt) {
    pieces.push('==== ARTIFACT SYSTEM PROMPT ====')
    pieces.push(String(artifactPrompt))
  }

  if (pieces.length === 0) {
    return 'You are the Batshit artifacts runtime AI. Answer succinctly and stream tokens quickly.'
  }

  return pieces.join('\n\n')
}

function buildUserContent(prompt: string, context?: any, mode?: string) {
  const parts = [prompt]
  if (mode && mode !== 'complete') {
    parts.unshift(`Mode: ${mode}`)
  }
  if (context) {
    const pretty = typeof context === 'string' ? context : JSON.stringify(context, null, 2)
    parts.push('Context:')
    parts.push(pretty)
  }
  return parts.join('\n\n')
}

function resolveStructuredProviderSettings(
  connection?: ModelConnectionInfo | null,
  providerSettings?: Record<string, any> | null
) {
  if (!providerSettings || typeof providerSettings !== 'object') {
    return {
      requestSettings: {} as Record<string, any>,
      providerOptions: undefined as Record<string, Record<string, any>> | undefined
    }
  }

  const typed = providerSettings as Record<string, any>
  const inferredService = connection?.service ?? null
  const nested =
    inferredService && typed[inferredService] && typeof typed[inferredService] === 'object'
      ? (typed[inferredService] as Record<string, any>)
      : undefined

  const requestSettings = nested ? { ...typed, ...nested } : { ...typed }
  const providerOptions =
    inferredService && nested ? { [inferredService]: { ...nested } } : undefined

  return { requestSettings, providerOptions }
}

function numberSetting(source: Record<string, any>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function stringArraySetting(source: Record<string, any>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return [...value]
    }
  }
  return undefined
}

function resolveTextGenerationSettings(
  connection?: ModelConnectionInfo | null,
  providerSettings?: Record<string, any> | null
) {
  const { requestSettings, providerOptions } = resolveStructuredProviderSettings(
    connection,
    providerSettings
  )

  return {
    maxTokens:
      numberSetting(requestSettings, 'maxOutputTokens', 'maxTokens') ??
      DEFAULT_ARTIFACT_TEXT_MAX_TOKENS,
    temperature: numberSetting(requestSettings, 'temperature'),
    topP: numberSetting(requestSettings, 'topP'),
    topK: numberSetting(requestSettings, 'topK'),
    presencePenalty: numberSetting(requestSettings, 'presencePenalty'),
    frequencyPenalty: numberSetting(requestSettings, 'frequencyPenalty'),
    seed: numberSetting(requestSettings, 'seed'),
    stopSequences: stringArraySetting(requestSettings, 'stopSequences', 'stop'),
    providerOptions
  }
}

async function streamViaWebhook({
  webhookUrl,
  artifactId,
  prompt,
  context,
  mode,
  sessionId,
  systemPrompt,
  fields,
  webhookPassthrough,
  eventFetch,
  writer,
  streamAdapter
}: {
  webhookUrl: string
  artifactId: string
  prompt: string
  context: any
  mode?: string
  sessionId: string
  systemPrompt?: string | null
  fields?: Record<string, any> | null
  webhookPassthrough?: boolean
  eventFetch: typeof fetch
  writer: WritableStreamDefaultWriter<Uint8Array>
  streamAdapter: StreamEventAdapter
}) {
  // Webhook passthrough: send data directly as the body (no Batshit wrapper)
  // Used for n8n workflows that expect a specific payload shape.
  // Works for both paths: agent Fabric invoke (fields) and user UI click (context).
  let payload: Record<string, any>
  if (webhookPassthrough && fields && Object.keys(fields).length > 0) {
    // Agent Fabric path: field values become the body
    payload = { ...fields }
  } else if (webhookPassthrough && context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length > 0) {
    // User UI path: context (form data from window.batshit.complete) becomes the body
    payload = { ...context }
  } else {
    payload = {
      artifactId,
      prompt,
      context,
      mode: mode || 'complete',
      sessionId,
      artifactSystemPrompt: systemPrompt || null
    }
    // SA-042: Include fabric fields in webhook payload when present
    if (fields && Object.keys(fields).length > 0) {
      payload.fields = fields
    }
  }

  const response = await eventFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    throw error(response.status, 'Webhook completion failed')
  }

  const data = await response.json()
  const text =
    data?.text || data?.response || data?.result || (typeof data === 'string' ? data : JSON.stringify(data))

  await streamAdapter.emitChunk({ content: text })
  await streamAdapter.emitFinish({ usage: data?.usage })

  await streamAdapter.emitEnd({
    content: text,
    zipReferences: [],
    metadata: { transport: 'webhook', webhookUrl }
  })

  await streamAdapter.emitComplete()
  await writer.close()
}

async function streamViaMode3({
  artifact,
  prompt,
  context,
  mode,
  sessionId,
  messageId,
  model,
  connection,
  providerSettings,
  writer,
  streamAdapter,
  userId,
  systemPrompt,
  expectFileOutput = false
}: {
  artifact: any
  prompt: string
  context: any
  mode?: string
  sessionId: string
  messageId: string
  model: string
  connection?: ModelConnectionInfo | null
  providerSettings?: Record<string, any> | null
  writer: WritableStreamDefaultWriter<Uint8Array>
  streamAdapter: StreamEventAdapter
  userId: string
  systemPrompt?: string | null
  expectFileOutput?: boolean
}) {
  const compiledSystemPrompt = systemPrompt ?? buildSystemPrompt(artifact, null)
  const userContent = buildUserContent(prompt, context, mode)
  const generationSettings = resolveTextGenerationSettings(connection, providerSettings)

  const brain = new VercelAIBrain()
  const result = await brain.streamNativeMode({
    sessionId,
    messageId,
    userId,
      messages: [
      { role: 'system', content: compiledSystemPrompt },
      { role: 'user', content: userContent }
    ],
    model,
    connection,
    providerSettings,
    maxTokens: generationSettings.maxTokens,
    temperature: generationSettings.temperature,
    topP: generationSettings.topP,
    topK: generationSettings.topK,
    presencePenalty: generationSettings.presencePenalty,
    frequencyPenalty: generationSettings.frequencyPenalty,
    seed: generationSettings.seed,
    stopSequences: generationSettings.stopSequences,
    providerOptions: generationSettings.providerOptions,
    toolsEnabled: false
  })

  let aggregatedText = ''
  let usage: Record<string, any> | undefined
  let emittedFileCount = 0

  for await (const rawChunk of result.stream as any) {
    const chunkType = String(rawChunk?.type || '')
    switch (chunkType) {
      case 'text-delta': {
        const textChunk = rawChunk.text || ''
        if (textChunk) {
          aggregatedText += textChunk
          await streamAdapter.emitChunk({ content: textChunk })
        }
        break
      }
      case 'thinking': {
        if (rawChunk?.content) {
          await streamAdapter.emitThinking({ content: rawChunk.content })
        }
        break
      }
      case 'finish': {
        usage = rawChunk.usage || rawChunk.totalUsage
        if (usage) {
          await streamAdapter.emitFinish({ usage })
        }
        break
      }
      default:
        break
    }
  }

  // SA-010: Check for generated files from multimodal models that return images on result.files.
  try {
    const files = await (result as any).files
    if (files && Array.isArray(files) && files.length > 0) {
      logger.debug(`[Artifacts] Found ${files.length} generated file(s) from model ${model}`)
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        if (file.mediaType?.startsWith('image/')) {
          let base64Data: string | null = null

          // Priority 1: Use uint8Array and convert to proper data URL
          if (file.uint8Array) {
            const buffer = Buffer.from(file.uint8Array)
            base64Data = `data:${file.mediaType};base64,${buffer.toString('base64')}`
          }
          // Priority 2: Use base64 property, ensure it has data URL prefix
          else if (file.base64) {
            if (file.base64.startsWith('data:')) {
              base64Data = file.base64
            } else {
              // Raw base64 without prefix - add it
              base64Data = `data:${file.mediaType};base64,${file.base64}`
            }
          }

          if (base64Data) {
            logger.debug(`[Artifacts] Emitting image ${i + 1}/${files.length}, size: ${base64Data.length} chars`)
            await streamAdapter.emitFile({
              base64: base64Data,
              mediaType: file.mediaType,
              index: i,
              metadata: { model, fileIndex: i, totalFiles: files.length }
            })
            emittedFileCount += 1
          }
        }
      }
    }
  } catch (filesError) {
    // files property may not exist on all models - this is expected
    logger.debug('[Artifacts] No files property on result (expected for text-only models)')
  }

  if (expectFileOutput && emittedFileCount === 0) {
    throw new Error(
      `Artifact visual generation expected a generated file, but model '${model}' returned zero files. Use an image-capable model from sys.model_catalog.search and verify the saved user API key for that provider.`
    )
  }

  await streamAdapter.emitEnd({
    content: aggregatedText,
    zipReferences: [],
    metadata: {
      transport: 'mode3',
      model,
      usage
    }
  })

  await streamAdapter.emitComplete()
  await writer.close()
}

/**
 * SA-011 Phase 1 & 2: Generate images using dedicated image models.
 * Uses provider-specific image generation instead of streamText().
 * OpenAI dedicated image models call the Images API directly so unsupported
 * wrapper parameters such as response_format are not sent to GPT image models.
 * Phase 2 adds reference image support for editing, style transfer, and character consistency
 */
async function generateViaImageModel({
  prompt,
  model,
  writer,
  streamAdapter,
  userId,
  options = {}
}: {
  prompt: string
  model: string
  writer: WritableStreamDefaultWriter<Uint8Array>
  streamAdapter: StreamEventAdapter
  userId: string
  options?: {
    n?: number
    size?: string
    aspectRatio?: string
    // SA-011 Phase 2: Reference image options
    images?: ImageReference[]
    providerOptions?: ProviderOptions
  }
}) {
  const modelInfo = detectImageModel(model)
  const providerInfo = getImageProviderInfo(model)

  logger.debug(`[Artifacts] Generating image with dedicated model: ${model}`, {
    provider: providerInfo.provider,
    factoryModel: providerInfo.factoryModel,
    modelInfo
  })

  // Build generation options
  const requestedCount = options.n ?? 1
  const safeCount = modelInfo.supportsN
    ? Math.min(Math.max(1, Math.floor(requestedCount)), modelInfo.maxImagesPerCall)
    : 1
  const resolvedSize = modelInfo.supportsSize
    ? options.size ?? modelInfo.defaultSize ?? '1024x1024'
    : undefined
  const resolvedAspectRatio = modelInfo.supportsAspectRatio
    ? options.aspectRatio ?? modelInfo.defaultAspectRatio ?? '1:1'
    : undefined

  // Get the appropriate image model based on provider. OpenAI dedicated image models use
  // the Images API directly because GPT image-family models reject the legacy
  // response_format parameter sent by some wrappers.
  let imageModel: any
  let openAIApiKey: string | null = null
  let xaiApiKey: string | null = null

  switch (providerInfo.provider) {
    case 'openai': {
      const apiKey = await resolveOpenAIApiKey(userId)
      if (!apiKey) throw new Error('Saved OpenAI API key not configured for image generation')
      openAIApiKey = apiKey
      break
    }
    case 'luma': {
      const apiKey = await resolveLumaApiKey(userId)
      if (!apiKey) throw new Error('Saved Luma API key not configured for image generation')
      const luma = createLuma({ apiKey })
      imageModel = luma.image(providerInfo.factoryModel)
      break
    }
    case 'fal': {
      const apiKey = await resolveFalApiKey(userId)
      if (!apiKey) throw new Error('Saved Fal API key not configured for image generation')
      const fal = createFal({ apiKey })
      imageModel = fal.image(providerInfo.factoryModel)
      break
    }
    case 'replicate': {
      const apiKey = await resolveReplicateApiKey(userId)
      if (!apiKey) throw new Error('Saved Replicate API key not configured for image generation')
      const replicate = createReplicate({ authToken: apiKey } as any)
      imageModel = replicate.image(providerInfo.factoryModel)
      break
    }
    case 'xai': {
      const apiKey = await resolveXaiApiKey(userId)
      if (!apiKey) throw new Error('Saved xAI API key not configured for Grok Imagine image generation')
      xaiApiKey = apiKey
      break
    }
    default:
      throw new Error(`Image provider '${providerInfo.provider}' is not supported`)
  }

  const generateOptions: Parameters<typeof generateImage>[0] | null = openAIApiKey || xaiApiKey
    ? null
    : {
        model: imageModel,
        prompt,
        n: safeCount
      }

  // Add size or aspectRatio based on model capabilities
  const falImageSize =
    options.providerOptions?.fal?.imageSize ?? options.providerOptions?.fal?.image_size
  const resolvedResolution = coerceString(options.providerOptions?.xai?.resolution)
  if (generateOptions && modelInfo.supportsSize && resolvedSize) {
    ;(generateOptions as any).size = resolvedSize
  } else if (generateOptions && modelInfo.supportsAspectRatio && !falImageSize && resolvedAspectRatio) {
    ;(generateOptions as any).aspectRatio = resolvedAspectRatio
  }

  // SA-011 Phase 2: Add provider-specific options for reference images
  if (options.providerOptions) {
    const providerOpts: any = {}

    // Luma provider options (style_ref, character_ref, modify_image_ref, image_ref)
    if (providerInfo.provider === 'luma' && options.providerOptions.luma) {
      const lumaOpts = options.providerOptions.luma
      if (lumaOpts.style_ref) providerOpts.style_ref = lumaOpts.style_ref
      if (lumaOpts.character_ref) providerOpts.character_ref = lumaOpts.character_ref
      if (lumaOpts.modify_image_ref) providerOpts.modify_image_ref = lumaOpts.modify_image_ref
      if (lumaOpts.image_ref) providerOpts.image_ref = lumaOpts.image_ref
      if (Object.keys(providerOpts).length > 0) {
        ;(generateOptions as any).providerOptions = { luma: providerOpts }
      }
    }

    // Fal provider options for image-reference editing
    if (providerInfo.provider === 'fal' && options.providerOptions.fal) {
      const falOpts = options.providerOptions.fal
      const cleaned = normalizeFalOptions(
        Object.fromEntries(
          Object.entries(falOpts).filter(([, value]) => value !== undefined)
        )
      )
      if (Object.keys(cleaned).length > 0) {
        ;(generateOptions as any).providerOptions = { fal: cleaned }
      }
    }
  }

  // SA-011 Phase 2: Handle simple images array (convert to provider-specific format)
  if (options.images && options.images.length > 0 && !options.providerOptions) {
    const firstImage = options.images[0]
    const imageUrl = firstImage.url || firstImage.data

    if (imageUrl) {
      if (providerInfo.provider === 'fal') {
        ;(generateOptions as any).providerOptions = {
          fal: { image_url: imageUrl }
        }
      } else if (providerInfo.provider === 'luma') {
        ;(generateOptions as any).providerOptions = {
          luma: {
            modify_image_ref: {
              url: imageUrl,
              weight: firstImage.weight ?? 0.8
            }
          }
        }
      }
    }
  }

  logger.debug(`[Artifacts] Calling image generation with options:`, {
    transport: openAIApiKey ? 'openai-images-api' : xaiApiKey ? 'xai-images-api' : 'ai-sdk-generateImage',
    model: providerInfo.factoryModel,
    promptLength: prompt.length,
    n: safeCount,
    size: openAIApiKey ? resolvedSize : (generateOptions as any)?.size,
    aspectRatio: resolvedAspectRatio,
    resolution: resolvedResolution,
    inputImageCount: options.images?.length ?? 0,
    hasProviderOptions: !!(generateOptions as any)?.providerOptions
  })

  try {
    // Generate image(s)
    const result = openAIApiKey
      ? await generateOpenAIImageDirect({
          apiKey: openAIApiKey,
          model: providerInfo.factoryModel,
          prompt,
          n: safeCount,
          size: resolvedSize
        })
      : xaiApiKey
        ? await generateXAIImageDirect({
            apiKey: xaiApiKey,
            model: providerInfo.factoryModel,
            prompt,
            n: safeCount,
            aspectRatio: resolvedAspectRatio,
            resolution: resolvedResolution,
            images: options.images
          })
      : await generateImage(generateOptions!)

    // Process and emit images
    const anyResult = result as any
    const images = anyResult.images || (anyResult.image ? [anyResult.image] : [])
    logger.debug(`[Artifacts] Generated ${images.length} image(s) from ${model}`)

    if (images.length === 0) {
      throw new Error(`Model '${model}' returned zero generated images`)
    }

    let emittedFileCount = 0
    // Emit status update
    await streamAdapter.emitChunk({ content: `Generated ${images.length} image(s)` })

    for (let i = 0; i < images.length; i++) {
      const image = images[i]
      let base64Data: string | null = null
      let mediaType = 'image/png'

      // Convert to data URL
      if (image.uint8Array) {
        const buffer = Buffer.from(image.uint8Array)
        base64Data = `data:image/png;base64,${buffer.toString('base64')}`
      } else if (image.base64) {
        if (image.base64.startsWith('data:')) {
          base64Data = image.base64
          mediaType = mediaTypeFromDataUrl(image.base64) ?? image.mediaType ?? mediaType
        } else {
          mediaType = image.mediaType ?? mediaType
          base64Data = `data:${mediaType};base64,${image.base64}`
        }
      }

      if (base64Data) {
        logger.debug(`[Artifacts] Emitting generated image ${i + 1}/${images.length}, size: ${base64Data.length} chars`)
        await streamAdapter.emitFile({
          base64: base64Data,
          mediaType,
          index: i,
          metadata: {
            model,
            provider: providerInfo.provider,
            fileIndex: i,
            totalFiles: images.length,
            generationType: 'dedicated'
          }
        })
        emittedFileCount += 1
      }
    }

    if (emittedFileCount === 0) {
      throw new Error(`Model '${model}' returned images, but none could be converted into generated files`)
    }

    // Emit finish with any usage info
    const usage = (result as any).usage || {}
    await streamAdapter.emitFinish({ usage })

    // Emit end
    await streamAdapter.emitEnd({
      content: `Generated ${images.length} image(s)`,
      zipReferences: [],
      metadata: {
        transport: 'image-generation',
        model,
        provider: providerInfo.provider,
        imageCount: images.length
      }
    })

  } catch (genError: any) {
    if (isArtifactStreamWriteError(genError)) {
      throw genError
    }
    const message = artifactErrorMessage(genError, 'Image generation failed')
    console.error(`[Artifacts] Image generation failed:`, artifactErrorLogValue(genError, message))
    throw new Error(
      message.startsWith('Image generation failed')
        ? message
        : `Image generation failed: ${message}`
    )
  }

  await streamAdapter.emitComplete()
  await writer.close().catch(() => {})
}

/**
 * SA-011 Phase 3: Generate speech/TTS using dedicated speech models
 * Uses Vercel AI SDK's generateSpeech() for text-to-speech
 */
async function generateViaSpeechModel({
  text,
  model,
  writer,
  streamAdapter,
  userId,
  options = {}
}: {
  text: string
  model: string
  writer: WritableStreamDefaultWriter<Uint8Array>
  streamAdapter: StreamEventAdapter
  userId: string
  options?: {
    voice?: string
    language?: string
    instructions?: string
  }
}) {
  const modelInfo = detectSpeechModel(model)
  const providerInfo = getSpeechProviderInfo(model)

  logger.debug(`[Artifacts] Generating speech with model: ${model}`, {
    provider: providerInfo.provider,
    factoryModel: providerInfo.factoryModel,
    modelInfo
  })

  // Get the appropriate speech model based on provider
  let speechModel: any

  switch (providerInfo.provider) {
    case 'openai': {
      const apiKey = await resolveOpenAIApiKey(userId)
      if (!apiKey) throw new Error('Saved OpenAI API key not configured for speech generation')
      const openai = createOpenAI({ apiKey })
      speechModel = openai.speech(providerInfo.factoryModel)
      break
    }
    case 'fal': {
      const apiKey = await resolveFalApiKey(userId)
      if (!apiKey) throw new Error('Saved Fal API key not configured for speech generation')
      const fal = createFal({ apiKey })
      speechModel = fal.speech(providerInfo.factoryModel)
      break
    }
    default:
      throw new Error(
        `Speech provider '${providerInfo.provider}' is not yet supported. Supported: openai, fal`
      )
  }

  // Build generation options
  const generateOptions: Parameters<typeof generateSpeech>[0] = {
    model: speechModel,
    text
  }

  // Add voice if supported and provided
  if (modelInfo.supportsVoice && options.voice) {
    ;(generateOptions as any).voice = options.voice
  } else if (modelInfo.supportsVoice && modelInfo.defaultVoice) {
    ;(generateOptions as any).voice = modelInfo.defaultVoice
  }

  // Add language if supported and provided
  if (modelInfo.supportsLanguage && options.language) {
    ;(generateOptions as any).language = options.language
  }

  // Add provider-specific options
  if (providerInfo.provider === 'openai' && modelInfo.supportsInstructions && options.instructions) {
    ;(generateOptions as any).providerOptions = {
      openai: {
        instructions: options.instructions
      }
    }
  }

  logger.debug(`[Artifacts] Calling generateSpeech with options:`, {
    model: providerInfo.factoryModel,
    textLength: text.length,
    voice: (generateOptions as any).voice,
    language: (generateOptions as any).language
  })

  try {
    // Generate speech
    const result = await generateSpeech(generateOptions)

    // Get the audio data
    const audioData = result.audio

    if (audioData) {
      // Convert Uint8Array to base64
      let base64Audio: string
      if (audioData instanceof Uint8Array) {
        const buffer = Buffer.from(audioData)
        base64Audio = buffer.toString('base64')
      } else if (typeof audioData === 'string') {
        base64Audio = audioData
      } else {
        // Handle AudioData or other formats
        const buffer = Buffer.from(audioData as any)
        base64Audio = buffer.toString('base64')
      }

      // Determine media type based on model
      const mediaType = modelInfo.outputFormat === 'wav' ? 'audio/wav' : 'audio/mp3'

      logger.debug(`[Artifacts] Emitting audio, size: ${base64Audio.length} chars, mediaType: ${mediaType}`)

      // Emit status update
      await streamAdapter.emitChunk({ content: `Generated audio (${Math.round(base64Audio.length / 1024)}KB)` })

      // Emit audio event
      await streamAdapter.emitAudio({
        audioData: base64Audio,
        mediaType,
        index: 0,
        metadata: {
          model,
          provider: providerInfo.provider,
          voice: (generateOptions as any).voice,
          textLength: text.length
        }
      })
    }

    // Emit finish with any usage info
    const usage = (result as any).usage || {}
    await streamAdapter.emitFinish({ usage })

    // Emit end
    await streamAdapter.emitEnd({
      content: `Generated audio from ${text.length} characters of text`,
      zipReferences: [],
      metadata: {
        transport: 'speech-generation',
        model,
        provider: providerInfo.provider,
        voice: (generateOptions as any).voice
      }
    })

  } catch (genError: any) {
    console.error(`[Artifacts] Speech generation failed:`, genError)
    throw new Error(`Speech generation failed: ${genError.message}`)
  }

  await streamAdapter.emitComplete()
  await writer.close()
}

/**
 * SA-011 Phase 4: Stream structured objects using streamText + Output.object
 * Uses Vercel AI SDK v6 structured output streaming for progressive structured data generation
 */
async function generateViaObjectStream({
  prompt,
  context,
  mode,
  model,
  connection,
  providerSettings,
  schema,
  schemaName,
  schemaDescription,
  writer,
  streamAdapter,
  userId,
  systemPrompt
}: {
  prompt: string
  context?: any
  mode?: string
  model: string
  connection?: ModelConnectionInfo | null
  providerSettings?: Record<string, any> | null
  schema: any  // JSON Schema object
  schemaName?: string
  schemaDescription?: string
  writer: WritableStreamDefaultWriter<Uint8Array>
  streamAdapter: StreamEventAdapter
  userId: string
  systemPrompt?: string | null
}) {
  logger.debug(`[Artifacts] Streaming structured object with model: ${model}`, {
    schemaName,
    hasSchema: !!schema,
    connection: connection?.type ?? 'direct',
    service: connection?.service ?? null
  })

  const manager = await ProviderManager.createForUser(userId)
  const languageModel = manager.getModel(model, {
    transport: connection?.type,
    service: connection?.service ?? undefined
  })

  // Convert JSON Schema to AI SDK schema format for Output.object
  const schemaWrapper = jsonSchema(schema)
  const userContent = buildUserContent(prompt, context, mode)
  const systemContent =
    systemPrompt || 'You are the Batshit artifacts runtime AI. Answer succinctly and stream tokens quickly.'
  const { requestSettings, providerOptions } = resolveStructuredProviderSettings(
    connection,
    providerSettings
  )

  logger.debug(`[Artifacts] Calling streamText(Output.object)`, { promptLength: prompt.length })

  try {
    // Stream the structured object via Output.object
    const result = streamText({
      model: languageModel,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
      ],
      // The system entry is Batshit's own compiled artifact prompt (SA-098 D1).
      allowSystemInMessages: true,
      output: Output.object({
        schema: schemaWrapper,
        name: schemaName,
        description: schemaDescription
      }),
      ...(typeof requestSettings.temperature === 'number' ? { temperature: requestSettings.temperature } : {}),
      ...(typeof requestSettings.maxOutputTokens === 'number'
        ? { maxOutputTokens: requestSettings.maxOutputTokens }
        : {}),
      ...(typeof requestSettings.maxTokens === 'number' ? { maxOutputTokens: requestSettings.maxTokens } : {}),
      ...(typeof requestSettings.topP === 'number' ? { topP: requestSettings.topP } : {}),
      ...(typeof requestSettings.topK === 'number' ? { topK: requestSettings.topK } : {}),
      ...(typeof requestSettings.presencePenalty === 'number'
        ? { presencePenalty: requestSettings.presencePenalty }
        : {}),
      ...(typeof requestSettings.frequencyPenalty === 'number'
        ? { frequencyPenalty: requestSettings.frequencyPenalty }
        : {}),
      ...(Array.isArray(requestSettings.stop) ? { stopSequences: requestSettings.stop } : {}),
      ...(typeof requestSettings.seed === 'number' ? { seed: requestSettings.seed } : {}),
      ...(providerOptions ? { providerOptions } : {})
    })

    let partialIndex = 0

    // Stream partial objects as they're generated
    for await (const partialObject of result.partialOutputStream) {
      await streamAdapter.emitObjectPartial({
        object: partialObject,
        index: partialIndex++,
        metadata: { model }
      })
    }

    // Get the final object
    const finalObject = await result.output

    // Emit the final complete object
    await streamAdapter.emitObjectFinal({
      object: finalObject,
      metadata: { model, schemaName }
    })

    // Emit finish with usage info
    const usage = await result.usage
    await streamAdapter.emitFinish({ usage })

    // Emit end
    await streamAdapter.emitEnd({
      content: JSON.stringify(finalObject),
      zipReferences: [],
      metadata: {
        transport: 'object-streaming',
        model,
        schemaName,
        partialUpdates: partialIndex
      }
    })

  } catch (genError: any) {
    console.error(`[Artifacts] Object streaming failed:`, genError)
    throw new Error(`Object streaming failed: ${genError.message}`)
  }

  await streamAdapter.emitComplete()
  await writer.close()
}

export const POST: RequestHandler = async ({ request, locals, fetch }) => {
  const body = (await request.json()) as CompletionRequestBody
  const { artifactId, context = null, mode = 'complete', webhookUrl, sessionId: providedSessionId, model } = body

  // SA-042: Extract fabric field values from request body
  const fields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : null

  let prompt = typeof body.prompt === 'string' ? body.prompt : ''

  if (!artifactId || !prompt) {
    throw error(400, 'artifactId and prompt are required')
  }
  if (mode === 'object') {
    if (!body.schema) {
      throw error(400, 'schema is required when mode is object')
    }
    if (body.schema === null || typeof body.schema !== 'object' || Array.isArray(body.schema)) {
      throw error(400, 'schema must be a JSON object when mode is object')
    }
  }

  const runtimeClaims = isOpaqueArtifactRuntimeRequest(request)
    ? await requireArtifactRuntimeClaims(request, artifactId)
    : await resolveArtifactRuntimeClaims(request, artifactId)
  const auth = runtimeClaims
    ? { userId: runtimeClaims.userId }
    : await resolveNativeToolUser({
        request,
        localsUserId: locals.user?.id ?? null,
        claimedUserId: body.userId ?? null
      })
  const userId = auth?.userId
  if (!userId) {
    return apiError('Unauthorized', 401)
  }

  validatePayloadSize(body)
  await enforceRateLimit(userId, artifactId)

  const artifact = await loadArtifact(artifactId)
  const brainType: 'built_in' | 'webhook' | 'n8n_workflow' | 'custom_webhook' | 'none' =
    artifact.brain_type ||
    (artifact.webhook_url ? 'webhook' : artifact.ai_enabled === false ? 'none' : 'built_in')
  const configuredWebhookUrl = typeof artifact.webhook_url === 'string' ? artifact.webhook_url.trim() : ''
  const requestedWebhookUrl = typeof webhookUrl === 'string' ? webhookUrl.trim() : ''

  if (requestedWebhookUrl && requestedWebhookUrl !== configuredWebhookUrl) {
    throw error(403, 'Request-supplied webhook URLs are not allowed for artifact completion')
  }

  const usesWebhook =
    brainType === 'webhook' || brainType === 'n8n_workflow' || brainType === 'custom_webhook'
  const runtimeWebhookUrl =
    usesWebhook && configuredWebhookUrl
      ? await resolveArtifactWebhookUrlForRuntime(
          configuredWebhookUrl,
          brainType as WebhookBrainType,
          userId
        )
      : configuredWebhookUrl

  // Webhook passthrough: when enabled, fabric fields are sent directly as the webhook body
  // instead of being nested inside the standard Batshit wrapper payload
  const webhookPassthrough = artifact.metadata?.webhook_passthrough === true && usesWebhook

  // SA-042: Inject fabric field values into prompt context when present (skip for passthrough —
  // fields go directly to the webhook body, not into the prompt)
  if (!webhookPassthrough && fields && Object.keys(fields).length > 0) {
    const fieldLines = Object.entries(fields).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`).join('\n')
    prompt = `[Pre-filled field values]\n${fieldLines}\n\n${prompt}`
  }

  if (brainType === 'none') {
    throw error(400, 'AI is disabled for this artifact')
  }

  await ensureAccess(artifact, userId)

  const sessionId = providedSessionId || `artifact:${artifactId}:${userId}`
  const messageId = (await generateMessageId(sessionId)) || crypto.randomUUID()
  const runId = crypto.randomUUID()

  await startArtifactRunLog({
    runId,
    userId,
    artifactId,
    artifactName: artifact.name ?? null,
    artifactVersion: typeof artifact.version === 'number' ? artifact.version : null,
    sessionId,
    messageId,
    mode,
    brainType,
    requestedModel: typeof model === 'string' && model.trim().length ? model.trim() : null,
    prompt,
    promptChars: prompt.length,
    context,
    fields,
    requestOptions: {
      n: body.n,
      size: body.size,
      aspectRatio: body.aspectRatio,
      images: body.images,
      providerOptions: body.providerOptions,
      schema: body.schema,
      schemaName: body.schemaName,
      voice: body.voice,
      language: body.language,
      instructions: body.instructions
    }
  })

  const encoder = new TextEncoder()
  const stream = new TransformStream()
  const writer = stream.writable.getWriter()
  const streamAdapter = new StreamEventAdapter({
    sessionId,
    forward: async (event) => {
      const line = JSON.stringify(event) + '\n'
      try {
        await writer.write(encoder.encode(line))
      } catch (writeErr) {
        throw new ArtifactStreamWriteError(String(event.type || 'unknown'), writeErr)
      }
      await recordArtifactRunEvent(userId, artifactId, runId, event)
    },
    defaultMetadata: { artifactId, mode }
  })

  streamAdapter.setMessageId(messageId)
  const systemPrompt = buildSystemPrompt(artifact, await redis.get('batshit:artifacts_system_prompt') as string | null)
  const modelConfig = normalizeArtifactModelConfig(artifact.model_config ?? null, artifact.model ?? null)
  const role = resolveArtifactRoleForMode(mode)
  const resolvedFromConfig = await resolveModelForRole({
    config: modelConfig,
    role
  })
  const overrideModel = typeof model === 'string' && model.trim().length ? model.trim() : null
  const overrideMetadata = overrideModel
    ? await resolveModelMetadataFromCatalog(overrideModel, role)
    : null
  let resolvedModel = overrideModel ?? resolvedFromConfig.modelId
  let resolvedConnection = overrideModel ? overrideMetadata?.connection ?? null : resolvedFromConfig.connection ?? null
  let resolvedProviderSettings = overrideModel ? overrideMetadata?.providerSettings ?? null : resolvedFromConfig.providerSettings ?? null
  let resolvedPurpose = overrideModel ? overrideMetadata?.purpose ?? null : resolvedFromConfig.purpose ?? null
  let resolvedVisualMediaKind = overrideModel ? overrideMetadata?.visualMediaKind ?? null : resolvedFromConfig.visualMediaKind ?? null

  if (!resolvedModel) {
    let message: string
    if (!overrideModel && resolvedFromConfig.source === 'auto') {
      message = `No model selected for ${role} role. Set an exact model for this artifact or pass an explicit model for this run.`
    } else if (!overrideModel && resolvedFromConfig.source === 'preset') {
      message = `No model configured for ${role} role. The selected model preset is missing or invalid.`
    } else if (!overrideModel && resolvedFromConfig.source === 'manual') {
      message = `No model configured for ${role} role. Manual model ID is required.`
    } else {
      message = `No model configured for ${role} role`
    }
    await finishArtifactRunLog({
      userId,
      artifactId,
      runId,
      status: 'error',
      errorMessage: message,
      source: 'model_resolution'
    })
    throw error(400, message)
  }

  if (!resolvedPurpose && role === 'visual') resolvedPurpose = 'visual'
  if (!resolvedPurpose && role === 'audio') resolvedPurpose = 'audio'

  const connectionService = resolvedConnection?.service?.toLowerCase() ?? null
  const presetPurpose = resolvedPurpose
  const modelId = resolvedModel
  if (!resolvedVisualMediaKind && (presetPurpose === 'visual' || role === 'visual')) {
    resolvedVisualMediaKind = detectArtifactVisualMediaKind({ modelId, purpose: presetPurpose ?? 'visual' })
  }
  const presetVisualOptions = resolvePresetVisualOptions(resolvedProviderSettings)
  const presetAudioOptions = resolvePresetAudioOptions(resolvedProviderSettings)

  // SA-011 Phase 1: Check if model is a dedicated image generation model
  const forceImageProviders = new Set(['fal', 'luma', 'replicate', 'xai'])
  const wantsAudio = role === 'audio' || mode === 'speech' || presetPurpose === 'audio'
  const wantsVisual = role === 'visual' || presetPurpose === 'visual'
  // SA-011 Phase 3: Check if mode is speech or if model is a dedicated speech model
  const isSpeechMode = wantsAudio || isDedicatedSpeechModel(modelId)
  const isImageModel =
    !isSpeechMode &&
    (isDedicatedImageModel(modelId) ||
      (wantsVisual &&
        resolvedVisualMediaKind === 'image' &&
        connectionService &&
        forceImageProviders.has(connectionService)))
  const expectsGeneratedFile =
    isImageModel ||
    (wantsVisual && ['generate', 'edit', 'image'].includes((mode ?? '').toLowerCase()))
  // SA-011 Phase 4: Check if mode is object
  const isObjectMode = mode === 'object'

  const chosenTransport: CompletionTransport | 'image' | 'speech' | 'object' =
    isObjectMode
      ? 'object' as any  // SA-011 Phase 4: New transport type for structured object streaming
      : isSpeechMode
        ? 'speech' as any  // SA-011 Phase 3: New transport type for speech/TTS
        : isImageModel
          ? 'image' as any  // New transport type for dedicated image models
          : usesWebhook
            ? 'webhook'
            : 'mode3'

  if (chosenTransport === 'webhook' && !configuredWebhookUrl) {
    await finishArtifactRunLog({
      userId,
      artifactId,
      runId,
      status: 'error',
      errorMessage: 'A saved artifact webhook URL is required for this artifact',
      source: 'webhook_resolution'
    })
    throw error(400, 'A saved artifact webhook URL is required for this artifact')
  }

  await markArtifactRunPrepared({
    userId,
    artifactId,
    runId,
    role,
    configuredSource: resolvedFromConfig.source,
    resolvedModel: modelId,
    requestModel: overrideModel,
    connectionType: resolvedConnection?.type ?? null,
    connectionService: resolvedConnection?.service ?? null,
    purpose: presetPurpose ?? null,
    providerSettings: resolvedProviderSettings
      ? { ...resolvedProviderSettings, artifactVisualMediaKind: resolvedVisualMediaKind ?? undefined }
      : resolvedVisualMediaKind
        ? { artifactVisualMediaKind: resolvedVisualMediaKind }
        : resolvedProviderSettings,
    chosenTransport
  })

  // Kick off async streaming while returning the readable side immediately
  ;(async () => {
    let finalStatus: 'success' | 'error' = 'success'
    let finalError: string | null = null
    let finalException: unknown = null
    try {
      await streamAdapter.emitStart({ messageId, metadata: { transport: chosenTransport, runId } })

      if (chosenTransport === 'object') {
        // SA-011 Phase 4: Route to structured object streaming
        await generateViaObjectStream({
          prompt,
          context,
          mode,
          model: modelId,
          connection: resolvedConnection,
          providerSettings: resolvedProviderSettings,
          schema: body.schema,
          schemaName: body.schemaName,
          schemaDescription: body.schemaDescription,
          writer,
          streamAdapter,
          userId,
          systemPrompt
        })
      } else if (chosenTransport === 'speech') {
        const resolvedVoice = coerceString(body.voice) ?? presetAudioOptions.voice
        const resolvedLanguage = coerceString(body.language) ?? presetAudioOptions.language
        const resolvedInstructions =
          coerceString(body.instructions) ?? presetAudioOptions.instructions
        // SA-011 Phase 3: Route to dedicated speech/TTS generation
        await generateViaSpeechModel({
          text: prompt,
          model: modelId,
          writer,
          streamAdapter,
          userId,
          options: {
            voice: resolvedVoice,
            language: resolvedLanguage,
            instructions: resolvedInstructions
          }
        })
      } else if (chosenTransport === 'image') {
        const resolvedCount = coerceNumber(body.n) ?? presetVisualOptions.n
        const resolvedSize = coerceString(body.size) ?? presetVisualOptions.size
        const resolvedAspect = coerceString(body.aspectRatio) ?? presetVisualOptions.aspectRatio
        // SA-011 Phase 1: Route to dedicated image generation
        await generateViaImageModel({
          prompt,
          model: modelId,
          writer,
          streamAdapter,
          userId,
          options: {
            n: resolvedCount,
            size: resolvedSize,
            aspectRatio: resolvedAspect,
            // SA-011 Phase 2: Reference image options
            images: body.images,
            providerOptions: body.providerOptions
          }
        })
      } else if (chosenTransport === 'webhook') {
        await streamViaWebhook({
          webhookUrl: runtimeWebhookUrl,
          artifactId,
          prompt,
          context,
          mode,
          sessionId,
          systemPrompt,
          fields,
          webhookPassthrough,
          eventFetch: fetch,
          writer,
          streamAdapter
        })
      } else {
        await streamViaMode3({
          artifact,
          prompt,
          context,
          mode,
          sessionId,
          messageId,
          model: modelId,
          connection: resolvedConnection,
          providerSettings: resolvedProviderSettings,
          writer,
          streamAdapter,
          userId,
          systemPrompt,
          expectFileOutput: expectsGeneratedFile
        })
      }
    } catch (err: any) {
      finalStatus = 'error'
      finalException = err
      const message = artifactErrorMessage(err)
      finalError = message
      const streamWriteError = isArtifactStreamWriteError(err)
      if (streamWriteError) {
        console.warn('[Artifacts] Artifact completion stream closed before result delivery:', artifactErrorLogValue(err))
      } else {
        await streamAdapter.emitError({ error: message }).catch((emitErr) => {
          console.error(
            '[Artifacts] Failed to emit artifact completion error event:',
            artifactErrorLogValue(emitErr, 'artifact completion error event write failed')
          )
        })
      }
      await writer.close().catch(() => {})
    } finally {
      try {
        await finishArtifactRunLog({
          userId,
          artifactId,
          runId,
          status: finalStatus,
          errorMessage: finalError,
          error: finalException,
          source: isArtifactStreamWriteError(finalException) ? 'client_disconnect' : 'stream'
        })
      } catch (logErr) {
        console.error('[Artifacts] Failed to finish artifact run log:', logErr)
      }
    }
  })().catch((taskErr) => {
    console.error('[Artifacts] Artifact completion background task failed after safeguards:', taskErr)
  })

  return new Response(stream.readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    }
  })
}
