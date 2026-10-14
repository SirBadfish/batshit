import { describe, expect, it } from 'vitest'

import {
  CODEX_RETIRED_MODELS,
  CODEX_SUBMODEL_CHOICES,
  findRetiredCodexModel,
  supportsCodexFastMode,
  supportsCodexXhighReasoning
} from '../codex-models'
import {
  CLAUDE_CLI_MODEL_CHOICES,
  CLAUDE_CLI_RETIRED_MODELS,
  findRetiredClaudeCliModel
} from '../claude-cli-models'

describe('Codex model picker', () => {
  it('tracks the current ChatGPT-backed Codex model roster in display order', () => {
    expect(CODEX_SUBMODEL_CHOICES).toMatchObject([
      { value: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 258_400 },
      { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 258_400 },
      { value: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 258_400 },
      { value: 'gpt-6-luna', label: 'GPT-6 Luna', contextWindow: 258_400 },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 258_400 },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 258_400 },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 258_400 },
      { value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 258_400 }
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

// BL-158: a model that left a list is known by id; one Batshit never listed is never flagged.
describe('models that left the CLI lists', () => {
  it('knows gpt-5.4, the model Josh\'s codex_cli_subagent kept', () => {
    expect(findRetiredCodexModel('gpt-5.4')).toEqual({ value: 'gpt-5.4', label: 'GPT-5.4', leftOn: '2026-09-06' })
    expect(findRetiredCodexModel(' gpt-5.3-codex-spark ')?.leftOn).toBe('2026-09-18')
  })

  it('never flags a listed model or one Batshit never listed', () => {
    for (const { value } of CODEX_SUBMODEL_CHOICES) expect(findRetiredCodexModel(value), value).toBeNull()
    for (const { value } of CLAUDE_CLI_MODEL_CHOICES) expect(findRetiredClaudeCliModel(value), value).toBeNull()
    for (const typed of ['gpt-7-typed-by-hand', '', 'codex']) {
      expect(findRetiredCodexModel(typed), typed).toBeNull()
      expect(findRetiredClaudeCliModel(typed), typed).toBeNull()
    }
    expect(findRetiredCodexModel(null)).toBeNull()
  })

  it('a retired id is never also on the list, and each is listed once', () => {
    const listed = new Set(CODEX_SUBMODEL_CHOICES.map((choice) => choice.value as string))
    const retired = CODEX_RETIRED_MODELS.map((entry) => entry.value)
    expect(retired.filter((value) => listed.has(value))).toEqual([])
    expect(new Set(retired).size).toBe(retired.length)
    const claudeListed = new Set(CLAUDE_CLI_MODEL_CHOICES.map((choice) => choice.value as string))
    expect(CLAUDE_CLI_RETIRED_MODELS.filter((entry) => claudeListed.has(entry.value))).toEqual([])
  })
})
