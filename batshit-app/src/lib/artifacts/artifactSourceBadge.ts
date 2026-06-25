import type { IconRef } from '$lib/icons/iconTypes'

export type ArtifactSourceKind =
  | 'built_in'
  | 'comfyui'
  | 'huggingface'
  | 'gradio'
  | 'n8n'
  | 'custom'
  | 'static'

export interface ArtifactSourceBadge {
  kind: ArtifactSourceKind
  label: string
  iconRef: IconRef
}

const SOURCE_BADGES: Record<ArtifactSourceKind, ArtifactSourceBadge> = {
  built_in: {
    kind: 'built_in',
    label: 'Built-in AI',
    iconRef: { kind: 'lucide', id: 'sparkles' }
  },
  comfyui: {
    kind: 'comfyui',
    label: 'ComfyUI',
    iconRef: { kind: 'brand', slug: 'comfyui-color', fixed: true }
  },
  huggingface: {
    kind: 'huggingface',
    label: 'HuggingFace',
    iconRef: { kind: 'brand', slug: 'huggingface-color', fixed: true }
  },
  gradio: {
    kind: 'gradio',
    label: 'Gradio',
    iconRef: { kind: 'brand', slug: 'gradio-color', fixed: true }
  },
  n8n: {
    kind: 'n8n',
    label: 'n8n',
    iconRef: { kind: 'brand', slug: 'n8n-color', fixed: true }
  },
  custom: {
    kind: 'custom',
    label: 'Custom',
    iconRef: { kind: 'lucide', id: 'wrench' }
  },
  static: {
    kind: 'static',
    label: 'Static',
    iconRef: { kind: 'lucide', id: 'box' }
  }
}

export function normalizeArtifactSourceKind(value: unknown): ArtifactSourceKind | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '-')
  if (!normalized) return null

  if (normalized === 'built-in' || normalized.includes('built-in-ai') || normalized === 'batshit') return 'built_in'
  if (normalized.includes('comfy')) return 'comfyui'
  if (normalized.includes('hugging') || normalized === 'hf' || normalized.includes('hf-space')) return 'huggingface'
  if (normalized.includes('gradio')) return 'gradio'
  if (normalized.includes('n8n')) return 'n8n'
  if (normalized.includes('custom')) return 'custom'
  if (normalized === 'none' || normalized.includes('no-ai') || normalized.includes('static')) return 'static'

  return null
}

export function resolveArtifactMetadataSourceKind(
  metadata: Record<string, any> | null | undefined
): ArtifactSourceKind | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const candidates = [
    metadata.artifact_source,
    metadata.artifactSource,
    metadata.source_type,
    metadata.sourceType,
    metadata.source,
    metadata.provider,
    metadata.origin,
    metadata.runtime,
    metadata.brain_source,
    metadata.brainSource
  ]

  for (const candidate of candidates) {
    const normalized = normalizeArtifactSourceKind(candidate)
    if (normalized) return normalized
  }

  if (metadata.hf_space || metadata.huggingface_space || metadata.huggingFaceSpace) return 'huggingface'
  if (metadata.gradio_app || metadata.gradioApp) return 'gradio'
  if (metadata.comfy_workflow || metadata.comfyWorkflow || metadata.comfyui_workflow) return 'comfyui'
  if (metadata.n8n_workflow || metadata.n8nWorkflow || metadata.webhook_passthrough === true) return 'n8n'

  return null
}

function iconSource(artifact: any): ArtifactSourceKind | null {
  const iconRef = artifact?.icon_ref
  if (!iconRef || typeof iconRef !== 'object' || iconRef.kind !== 'brand') return null
  return normalizeArtifactSourceKind(iconRef.slug)
}

export function resolveArtifactSourceKind(artifact: any): ArtifactSourceKind {
  const explicit = resolveArtifactMetadataSourceKind(artifact?.metadata)
  if (explicit) return explicit

  const brainType = normalizeArtifactSourceKind(artifact?.brain_type)
  if (brainType) return brainType

  const webhookUrl = typeof artifact?.webhook_url === 'string' ? artifact.webhook_url : ''
  if (webhookUrl.toLowerCase().includes('n8n')) return 'n8n'

  const icon = iconSource(artifact)
  if (icon) return icon

  return 'custom'
}

export function getArtifactSourceBadge(artifact: any): ArtifactSourceBadge {
  return SOURCE_BADGES[resolveArtifactSourceKind(artifact)]
}
