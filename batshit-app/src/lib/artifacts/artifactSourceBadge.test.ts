import { describe, expect, it } from 'vitest'

import { resolveArtifactSourceKind } from './artifactSourceBadge'

describe('artifact source badge resolution', () => {
  it('prefers explicit source metadata', () => {
    expect(resolveArtifactSourceKind({ metadata: { source_type: 'comfyui' } })).toBe('comfyui')
    expect(resolveArtifactSourceKind({ metadata: { sourceType: 'hf-space' } })).toBe('huggingface')
    expect(resolveArtifactSourceKind({ metadata: { artifact_source: 'standalone-gradio' } })).toBe('gradio')
  })

  it('falls back to runtime and webhook shape', () => {
    expect(resolveArtifactSourceKind({ brain_type: 'built_in' })).toBe('built_in')
    expect(resolveArtifactSourceKind({ brain_type: 'n8n_workflow' })).toBe('n8n')
    expect(resolveArtifactSourceKind({ brain_type: 'custom_webhook' })).toBe('custom')
    expect(resolveArtifactSourceKind({ brain_type: 'none' })).toBe('static')
    expect(resolveArtifactSourceKind({ webhook_url: 'https://example.n8n.cloud/webhook/demo' })).toBe('n8n')
  })

  it('uses known brand icons when metadata is absent', () => {
    expect(resolveArtifactSourceKind({ icon_ref: { kind: 'brand', slug: 'huggingface-color' } })).toBe('huggingface')
    expect(resolveArtifactSourceKind({ icon_ref: { kind: 'brand', slug: 'n8n-color' } })).toBe('n8n')
  })

  it('defaults unknown artifacts to custom', () => {
    expect(resolveArtifactSourceKind({ name: 'Tiny Tool' })).toBe('custom')
  })
})
