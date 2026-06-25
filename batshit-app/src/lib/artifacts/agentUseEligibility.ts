import { resolveArtifactSourceKind } from '$lib/artifacts/artifactSourceBadge'

export type ArtifactAgentUseIneligibleReason = 'external_embed' | 'panel_runtime'

export interface ArtifactAgentUseEligibility {
  eligible: boolean
  reason?: ArtifactAgentUseIneligibleReason
  message?: string
}

export const USER_ONLY_EMBED_AGENT_USE_MESSAGE =
  "Gradio/HuggingFace embeds are user-only and can't be used by agents."

export const USER_ONLY_COMFYUI_AGENT_USE_MESSAGE =
  "ComfyUI panel artifacts are user-run for now; agents can't run them until Batshit has a backend ComfyUI runner."

function normalizeBrainType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed || null
}

function hasNoBatshitCompletionRuntime(artifact: any): boolean {
  const brainType = normalizeBrainType(artifact?.brain_type)
  if (brainType === 'none') return true
  if (!brainType && artifact?.ai_enabled === false) return true
  return false
}

export function isArtifactUserOnlyEmbed(artifact: any): boolean {
  const sourceKind = resolveArtifactSourceKind(artifact)
  if (sourceKind !== 'huggingface' && sourceKind !== 'gradio') return false
  return hasNoBatshitCompletionRuntime(artifact)
}

export function isArtifactUserOnlyPanelRuntime(artifact: any): boolean {
  const sourceKind = resolveArtifactSourceKind(artifact)
  if (sourceKind !== 'comfyui') return false
  return hasNoBatshitCompletionRuntime(artifact)
}

export function resolveArtifactAgentUseEligibility(artifact: any): ArtifactAgentUseEligibility {
  if (isArtifactUserOnlyEmbed(artifact)) {
    return {
      eligible: false,
      reason: 'external_embed',
      message: USER_ONLY_EMBED_AGENT_USE_MESSAGE
    }
  }

  if (isArtifactUserOnlyPanelRuntime(artifact)) {
    return {
      eligible: false,
      reason: 'panel_runtime',
      message: USER_ONLY_COMFYUI_AGENT_USE_MESSAGE
    }
  }

  return { eligible: true }
}

export function isArtifactAgentUseEligible(artifact: any): boolean {
  return resolveArtifactAgentUseEligibility(artifact).eligible
}
