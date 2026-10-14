import snapshot from './chatgpt-plan-published-metadata.json'
import type { PublishedModelMetadata } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'

// Exact official model pages checked 2026-10-01. This dated snapshot does not
// imply that a catalog fetch reverified the documentation or account limits.
// Never prefix-match a family, infer a new slug, or import paid catalog data.
const publishedModels = snapshot as Record<string, PublishedModelMetadata>

export function chatgptPlanPublishedMetadata(slug: string): PublishedModelMetadata | undefined {
  const entry = Object.hasOwn(publishedModels, slug) ? publishedModels[slug] : undefined
  return entry ? { ...entry, inputModalities: [...entry.inputModalities], outputModalities: [...entry.outputModalities] } : undefined
}

/** Read projection and save normalization: never writes/guesses a context budget. */
export function withChatgptPlanPublishedMetadata(preset: SavedModel): SavedModel {
  const publishedMetadata = chatgptPlanPublishedMetadata(preset.modelId)
  return {
    ...preset,
    publishedMetadata,
    capabilities: {
      ...preset.capabilities,
      // An explicit saved text-only restriction is intent, not missing metadata.
      ...(publishedMetadata ? { vision: preset.capabilities?.vision === false ? false : publishedMetadata.inputModalities.includes('image') } : {}),
      streaming: true, tools: true, audio: false, image: false
    }
  }
}
