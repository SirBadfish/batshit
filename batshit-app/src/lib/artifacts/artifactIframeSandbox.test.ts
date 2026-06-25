import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ARTIFACT_IFRAME_SANDBOX,
  EXTERNAL_EMBED_IFRAME_SANDBOX,
  getArtifactIframeSandbox
} from './artifactIframeSandbox'

describe('artifact iframe sandbox policy', () => {
  it('keeps normal artifacts in the strict default sandbox', () => {
    expect(getArtifactIframeSandbox({ brain_type: 'built_in' })).toBe(DEFAULT_ARTIFACT_IFRAME_SANDBOX)
  })

  it('does not add allow-same-origin for external embeds', () => {
    expect(EXTERNAL_EMBED_IFRAME_SANDBOX).not.toContain('allow-same-origin')
  })

  it('allows user-activated browser escapes for HuggingFace and Gradio embeds', () => {
    const huggingFaceSandbox = getArtifactIframeSandbox({
      brain_type: 'none',
      metadata: { source_type: 'huggingface' }
    })
    const gradioSandbox = getArtifactIframeSandbox({
      brain_type: 'none',
      metadata: { source_type: 'gradio' }
    })

    for (const sandbox of [huggingFaceSandbox, gradioSandbox]) {
      expect(sandbox).toBe(EXTERNAL_EMBED_IFRAME_SANDBOX)
      expect(sandbox).toContain('allow-popups')
      expect(sandbox).toContain('allow-popups-to-escape-sandbox')
      expect(sandbox).toContain('allow-top-navigation-by-user-activation')
    }
  })
})
