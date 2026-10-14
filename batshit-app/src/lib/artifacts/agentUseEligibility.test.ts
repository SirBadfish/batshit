import { describe, expect, it } from 'vitest'

import {
  hasNoBatshitCompletionRuntime,
  isArtifactAgentUseEligible,
  resolveArtifactAgentUseEligibility,
  USER_ONLY_COMFYUI_AGENT_USE_MESSAGE,
  USER_ONLY_EMBED_AGENT_USE_MESSAGE
} from './agentUseEligibility'

describe('artifact agent use eligibility', () => {
  it('marks HuggingFace Space embeds as user-only when they have no Batshit completion runtime', () => {
    const result = resolveArtifactAgentUseEligibility({
      brain_type: 'none',
      ai_enabled: false,
      metadata: { source_type: 'huggingface' }
    })

    expect(result).toEqual({
      eligible: false,
      reason: 'external_embed',
      message: USER_ONLY_EMBED_AGENT_USE_MESSAGE
    })
  })

  it('marks standalone Gradio embeds as user-only', () => {
    expect(
      isArtifactAgentUseEligible({
        brain_type: 'none',
        metadata: { source_type: 'gradio' }
      })
    ).toBe(false)
  })

  it('allows source-tagged native artifacts when a Batshit runtime exists', () => {
    expect(
      isArtifactAgentUseEligible({
        brain_type: 'custom_webhook',
        metadata: { source_type: 'huggingface' }
      })
    ).toBe(true)
  })

  it('marks ComfyUI panel artifacts as user-only when they have no Batshit completion runtime', () => {
    const result = resolveArtifactAgentUseEligibility({
      brain_type: 'none',
      ai_enabled: false,
      metadata: { source_type: 'comfyui' }
    })

    expect(result).toEqual({
      eligible: false,
      reason: 'panel_runtime',
      message: USER_ONLY_COMFYUI_AGENT_USE_MESSAGE
    })
  })

  it('allows ComfyUI-tagged artifacts when a backend Batshit runtime exists', () => {
    expect(
      isArtifactAgentUseEligible({
        brain_type: 'custom_webhook',
        metadata: { source_type: 'comfyui' }
      })
    ).toBe(true)
  })
})

describe('which artifacts Batshit can run (BL-89 review)', () => {
  // Mirrors `/api/artifacts/complete`: brain_type || (webhook_url ? 'webhook' : ai_enabled === false ? 'none' : 'built_in').
  it.each([
    ['brain_type none', { brain_type: 'none' }, true],
    ['brain_type none, even with a webhook URL', { brain_type: 'none', webhook_url: 'https://n8n.example/webhook/a' }, true],
    ['a legacy record with AI off', { ai_enabled: false }, true],
    ['a legacy record with AI off and a webhook URL', { ai_enabled: false, webhook_url: 'https://n8n.example/webhook/a' }, false],
    ['built-in AI', { brain_type: 'built_in' }, false],
    ['a legacy record with nothing set', {}, false]
  ])('%s', (_label, artifact, noRuntime) => {
    expect(hasNoBatshitCompletionRuntime(artifact)).toBe(noRuntime)
  })
})
