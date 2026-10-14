import { describe, expect, it } from 'vitest'
import { isOpenAICompletionsOnlyModel, resolveReviewedCatalogIdentity } from './catalogModelIdentity'

const anthropic = (name: string) => resolveReviewedCatalogIdentity({ connectionId: 'direct:anthropic', name })

describe('BL-68 reviewed catalog identity: Anthropic snapshot dates', () => {
  it('maps the three dated 4.5 snapshots to the alias the gateway lists', () => {
    expect(anthropic('claude-haiku-4-5-20251001')).toEqual({ name: 'claude-haiku-4.5', rule: 'anthropic-snapshot-date' })
    expect(anthropic('claude-sonnet-4-5-20250929')).toEqual({ name: 'claude-sonnet-4.5', rule: 'anthropic-snapshot-date' })
    expect(anthropic('claude-opus-4-5-20251101')).toEqual({ name: 'claude-opus-4.5', rule: 'anthropic-snapshot-date' })
  })

  it('handles the other published snapshot shapes the same way', () => {
    expect(anthropic('claude-opus-4-1-20250805')?.name).toBe('claude-opus-4.1')
    expect(anthropic('claude-opus-4-20250514')?.name).toBe('claude-opus-4')
    expect(anthropic('claude-3-haiku-20240307')?.name).toBe('claude-3-haiku')
  })

  it('applies to Anthropic\'s own connection only', () => {
    for (const connectionId of ['vercel-gateway', 'openrouter', 'direct:replicate', 'direct:deepinfra', null]) {
      expect(resolveReviewedCatalogIdentity({ connectionId, name: 'claude-haiku-4-5-20251001' })).toBeNull()
    }
  })

  it('leaves an undated id alone, so the rows that already merge are untouched', () => {
    expect(anthropic('claude-opus-4-6')).toBeNull()
    expect(anthropic('claude-sonnet-5')).toBeNull()
  })

  it('takes only a real calendar date, never any eight digits', () => {
    expect(anthropic('claude-haiku-4-5-20251301')).toBeNull()
    expect(anthropic('claude-haiku-4-5-20251000')).toBeNull()
    expect(anthropic('claude-haiku-4-5-99991001')).toBeNull()
    expect(anthropic('claude-haiku-4-5-2025100')).toBeNull()
    expect(anthropic('gpt-haiku-4-5-20251001')).toBeNull()
  })
})

describe('BL-68 OpenAI models that only run on the legacy completions endpoint', () => {
  it('names the four, exactly', () => {
    for (const id of ['babbage-002', 'davinci-002', 'gpt-3.5-turbo-instruct', 'gpt-3.5-turbo-instruct-0914']) {
      expect(isOpenAICompletionsOnlyModel(id)).toBe(true)
    }
  })

  it('is an exact list, not a pattern', () => {
    for (const id of ['gpt-3.5-turbo', 'gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo-instruct-2099', 'text-embedding-3-small']) {
      expect(isOpenAICompletionsOnlyModel(id)).toBe(false)
    }
  })
})
