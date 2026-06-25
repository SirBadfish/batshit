import type { IconRef } from '$lib/icons/iconTypes'
import {
  normalizeArtifactSourceKind,
  resolveArtifactMetadataSourceKind,
  type ArtifactSourceKind
} from '$lib/artifacts/artifactSourceBadge'
import type { ArtifactBrainType } from '$lib/types/artifacts'

export type ArtifactPowerSource =
  | 'built_in'
  | 'n8n_workflow'
  | 'comfyui'
  | 'huggingface'
  | 'gradio'
  | 'custom_webhook'
  | 'none'

export interface ArtifactPowerSourceOption {
  value: ArtifactPowerSource
  label: string
  description: string
  brainType: ArtifactBrainType
  sourceType: ArtifactSourceKind
  usesWebhook: boolean
  acceptsSystemPrompt: boolean
  iconRef: IconRef
}

export const ARTIFACT_POWER_SOURCE_OPTIONS: ArtifactPowerSourceOption[] = [
  {
    value: 'built_in',
    label: 'Built-in AI',
    description: 'Uses Batshit model providers through the artifact completion runtime.',
    brainType: 'built_in',
    sourceType: 'built_in',
    usesWebhook: false,
    acceptsSystemPrompt: true,
    iconRef: { kind: 'lucide', id: 'sparkles' }
  },
  {
    value: 'n8n_workflow',
    label: 'n8n Workflow',
    description: 'Calls an n8n webhook and tags the artifact with the n8n source badge.',
    brainType: 'n8n_workflow',
    sourceType: 'n8n',
    usesWebhook: true,
    acceptsSystemPrompt: true,
    iconRef: { kind: 'brand', slug: 'n8n-color', fixed: true }
  },
  {
    value: 'comfyui',
    label: 'ComfyUI',
    description: 'Runs a ComfyUI-backed artifact through Batshit artifact proxy helpers.',
    brainType: 'none',
    sourceType: 'comfyui',
    usesWebhook: false,
    acceptsSystemPrompt: false,
    iconRef: { kind: 'brand', slug: 'comfyui-color', fixed: true }
  },
  {
    value: 'huggingface',
    label: 'HuggingFace',
    description: 'Uses a HuggingFace Space or HuggingFace-backed artifact integration.',
    brainType: 'none',
    sourceType: 'huggingface',
    usesWebhook: false,
    acceptsSystemPrompt: false,
    iconRef: { kind: 'brand', slug: 'huggingface-color', fixed: true }
  },
  {
    value: 'gradio',
    label: 'Gradio',
    description: 'Embeds or wraps a standalone Gradio app that is not hosted as a HuggingFace Space.',
    brainType: 'none',
    sourceType: 'gradio',
    usesWebhook: false,
    acceptsSystemPrompt: false,
    iconRef: { kind: 'brand', slug: 'gradio-color', fixed: true }
  },
  {
    value: 'custom_webhook',
    label: 'Custom Webhook',
    description: 'Calls a non-n8n endpoint through the artifact webhook runtime.',
    brainType: 'custom_webhook',
    sourceType: 'custom',
    usesWebhook: true,
    acceptsSystemPrompt: true,
    iconRef: { kind: 'lucide', id: 'wrench' }
  },
  {
    value: 'none',
    label: 'Static / No AI',
    description: 'Keeps the artifact as a UI-only mini-app with no Batshit completion runtime.',
    brainType: 'none',
    sourceType: 'static',
    usesWebhook: false,
    acceptsSystemPrompt: false,
    iconRef: { kind: 'lucide', id: 'box' }
  }
]

const POWER_SOURCE_BY_VALUE = Object.fromEntries(
  ARTIFACT_POWER_SOURCE_OPTIONS.map((option) => [option.value, option])
) as Record<ArtifactPowerSource, ArtifactPowerSourceOption>

export function getArtifactPowerSourceOption(value: ArtifactPowerSource): ArtifactPowerSourceOption {
  return POWER_SOURCE_BY_VALUE[value] ?? POWER_SOURCE_BY_VALUE.built_in
}

export function getArtifactPowerSourceLabel(value: ArtifactPowerSource): string {
  return getArtifactPowerSourceOption(value).label
}

function sourceKindToPowerSource(sourceKind: ArtifactSourceKind | null): ArtifactPowerSource | null {
  if (!sourceKind) return null
  if (sourceKind === 'built_in') return 'built_in'
  if (sourceKind === 'n8n') return 'n8n_workflow'
  if (sourceKind === 'custom') return 'custom_webhook'
  if (sourceKind === 'static') return 'none'
  return sourceKind
}

export function resolveArtifactPowerSource(artifact: any): ArtifactPowerSource {
  const explicitSource = sourceKindToPowerSource(resolveArtifactMetadataSourceKind(artifact?.metadata))
  const brainType = artifact?.brain_type

  if (explicitSource && (brainType === 'none' || !brainType)) return explicitSource
  if (explicitSource === 'comfyui' || explicitSource === 'huggingface' || explicitSource === 'gradio') {
    return explicitSource
  }

  if (brainType === 'webhook' || brainType === 'n8n_workflow') return 'n8n_workflow'
  if (brainType === 'custom_webhook') return 'custom_webhook'
  if (brainType === 'built_in') return 'built_in'
  if (brainType === 'none') return explicitSource ?? 'none'

  if (typeof artifact?.webhook_url === 'string' && artifact.webhook_url.trim()) {
    return artifact.webhook_url.toLowerCase().includes('n8n') ? 'n8n_workflow' : 'custom_webhook'
  }

  if (artifact?.ai_enabled === false) {
    return explicitSource ?? 'none'
  }

  const iconSource = normalizeArtifactSourceKind(artifact?.icon_ref?.slug)
  return sourceKindToPowerSource(iconSource) ?? 'built_in'
}

export function applyArtifactPowerSourceToMetadata(
  metadata: Record<string, any> | null | undefined,
  powerSource: ArtifactPowerSource
): Record<string, any> {
  const option = getArtifactPowerSourceOption(powerSource)
  return {
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    source_type: option.sourceType
  }
}
