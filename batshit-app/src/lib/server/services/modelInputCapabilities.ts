import type { ModelCapabilities } from '$lib/types/savedModels'

export const IMAGE_INPUT_UNSUPPORTED_CODE = 'IMAGE_INPUT_UNSUPPORTED'

export type ImageInputUnsupportedRuntimeFailure = {
  code: typeof IMAGE_INPUT_UNSUPPORTED_CODE
  userMessage: string
}

export function modelAllowsImageInput(
  capabilities?: ModelCapabilities | null,
): boolean {
  if (!capabilities) return true
  return capabilities.vision !== false
}

export function buildImageInputUnsupportedMessage(options: {
  imageCount: number
  providerId?: string | null
  modelId?: string | null
}): string {
  const count = Math.max(1, Math.trunc(options.imageCount || 1))
  const modelLabel = [options.providerId, options.modelId]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' / ')
  const target = modelLabel || 'The selected model'
  const imageLabel = count === 1 ? 'image input' : 'image inputs'
  const clipLabel = count === 1 ? 'image clip' : 'image clips'

  return `${target} is saved as text-only in Batshit, but this message includes ${count} ${imageLabel}. Switch to a vision-capable model or remove the ${clipLabel}.`
}

export function classifyImageInputUnsupportedRuntimeFailure(options: {
  errorMessage: string
  providerId?: string | null
  modelId?: string | null
}): ImageInputUnsupportedRuntimeFailure | null {
  const errorMessage =
    typeof options.errorMessage === 'string' ? options.errorMessage.trim() : ''
  if (!errorMessage) return null

  const normalized = errorMessage.toLowerCase()
  const mentionsImage =
    normalized.includes('image input') ||
    normalized.includes('image inputs') ||
    normalized.includes('contain images') ||
    normalized.includes('contains images') ||
    normalized.includes('messages contain images') ||
    normalized.includes('vision')
  const rejectsImage =
    normalized.includes('does not support') ||
    normalized.includes('not support') ||
    normalized.includes('unsupported') ||
    normalized.includes('not supported')

  if (!mentionsImage || !rejectsImage) return null

  const modelLabel = [options.providerId, options.modelId]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' / ')
  const prefix = modelLabel
    ? `${modelLabel} rejected image inputs.`
    : 'The selected model rejected image inputs.'

  return {
    code: IMAGE_INPUT_UNSUPPORTED_CODE,
    userMessage: `${prefix} Switch to a vision-capable model or remove the image clips. Provider error: ${errorMessage}`,
  }
}
