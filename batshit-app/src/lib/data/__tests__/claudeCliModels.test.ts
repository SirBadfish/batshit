import { describe, expect, it } from 'vitest'

import { CLAUDE_CLI_MODEL_CHOICES } from '../claude-cli-models'

describe('Claude CLI model picker', () => {
  it('includes the current exact models and documented aliases proven on the managed pin', () => {
    const values = CLAUDE_CLI_MODEL_CHOICES.map(({ value }) => value)
    expect(values).toContain('opus')
    expect(values).toContain('fable')
    expect(values).toContain('sonnet')
    expect(values).toContain('claude-opus-5-5')
    expect(values).toContain('claude-fable-5-1')
    expect(values).toContain('claude-sonnet-5-5')
    expect(values).toContain('claude-haiku-5-5')
    expect(values).toContain('claude-sonnet-5')
    expect(values).toContain('fable[1m]')
    expect(new Set(values).size).toBe(values.length)
  })
})
