import { describe, expect, it } from 'vitest'

import {
  applyArtifactPowerSourceToMetadata,
  getArtifactPowerSourceOption,
  resolveArtifactPowerSource
} from './artifactPowerSource'

describe('artifact power source resolution', () => {
  it('keeps runtime brain types mapped to their user-facing source', () => {
    expect(resolveArtifactPowerSource({ brain_type: 'built_in' })).toBe('built_in')
    expect(resolveArtifactPowerSource({ brain_type: 'webhook' })).toBe('n8n_workflow')
    expect(resolveArtifactPowerSource({ brain_type: 'n8n_workflow' })).toBe('n8n_workflow')
    expect(resolveArtifactPowerSource({ brain_type: 'custom_webhook' })).toBe('custom_webhook')
  })

  it('uses explicit integration source metadata for source-backed artifacts', () => {
    expect(resolveArtifactPowerSource({ brain_type: 'none', metadata: { source_type: 'comfyui' } })).toBe('comfyui')
    expect(resolveArtifactPowerSource({ brain_type: 'none', metadata: { source_type: 'huggingface' } })).toBe('huggingface')
    expect(resolveArtifactPowerSource({ brain_type: 'none', metadata: { source_type: 'gradio' } })).toBe('gradio')
  })

  it('maps power sources back to runtime fields', () => {
    expect(getArtifactPowerSourceOption('comfyui')).toMatchObject({
      brainType: 'none',
      sourceType: 'comfyui',
      usesWebhook: false
    })
    expect(getArtifactPowerSourceOption('n8n_workflow')).toMatchObject({
      brainType: 'n8n_workflow',
      sourceType: 'n8n',
      usesWebhook: true
    })
  })

  it('writes source_type without dropping existing metadata', () => {
    expect(applyArtifactPowerSourceToMetadata({ run_only: true }, 'huggingface')).toEqual({
      run_only: true,
      source_type: 'huggingface'
    })
  })
})
