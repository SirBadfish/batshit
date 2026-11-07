import { describe, expect, it } from 'vitest'

import {
  CLAUDE_CLI_MODEL_CHOICES,
  CLAUDE_CLI_RETIRED_MODELS,
  findRetiredClaudeCliModel
} from '../claude-cli-models'

describe('Claude CLI models that left the list', () => {
  it('never flags a listed model or one Batshit never listed', () => {
    for (const { value } of CLAUDE_CLI_MODEL_CHOICES) expect(findRetiredClaudeCliModel(value), value).toBeNull()
    for (const typed of ['gpt-7-typed-by-hand', '', 'codex']) {
      expect(findRetiredClaudeCliModel(typed), typed).toBeNull()
    }
  })

  it('a retired id is never also on the list', () => {
    const claudeListed = new Set(CLAUDE_CLI_MODEL_CHOICES.map((choice) => choice.value as string))
    expect(CLAUDE_CLI_RETIRED_MODELS.filter((entry) => claudeListed.has(entry.value))).toEqual([])
  })
})
