import { describe, expect, it } from 'vitest'

import {
  CODEX_SUBMODEL_CHOICES,
  supportsCodexFastMode,
  supportsCodexXhighReasoning
} from '../codex-models'

describe('Codex model picker', () => {
  it('tracks the current ChatGPT-backed Codex model roster in display order', () => {
    expect(CODEX_SUBMODEL_CHOICES).toEqual([
      { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { value: 'gpt-5.5', label: 'GPT-5.5' }
    ])
  })

  it('keeps current reasoning and Fast-mode compatibility aligned with the roster', () => {
    for (const { value } of CODEX_SUBMODEL_CHOICES) {
      expect(supportsCodexXhighReasoning(value), value).toBe(true)
      expect(supportsCodexFastMode(value), value).toBe(true)
    }
    expect(supportsCodexXhighReasoning('gpt-5.3-codex-spark')).toBe(false)
    expect(supportsCodexFastMode('gpt-5.3-codex-spark')).toBe(false)
  })
})
