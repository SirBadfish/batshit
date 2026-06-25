import { describe, expect, it } from 'vitest'

import {
  normalizeCliRuntimeModel,
  resolveCliSubagentExecutableModel,
} from '../cliSubagentModelResolution'

describe('cliSubagentModelResolution', () => {
  it('treats plain CLI lane labels as selectors instead of runnable models', () => {
    expect(normalizeCliRuntimeModel('codex', 'codex')).toBeNull()
    expect(normalizeCliRuntimeModel('claude', 'claude')).toBeNull()
  })

  it('uses provider-specific Codex model when saved model is the Codex lane label', () => {
    expect(
      resolveCliSubagentExecutableModel(
        {
          primary_model_name: 'codex',
          model: 'codex',
          provider_specific_settings: {
            codex_model: 'gpt-5.5',
          },
          codex_settings: null,
          claude_settings: null,
        },
        'codex',
      ),
    ).toBe('gpt-5.5')
  })
})
