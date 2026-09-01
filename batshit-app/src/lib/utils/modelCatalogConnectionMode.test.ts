import { describe, expect, it } from 'vitest'

import {
  isManualEntryCatalogConnection,
  isManualEntryDirectProvider
} from './modelCatalogConnectionMode'

describe('modelCatalogConnectionMode', () => {
  it('keeps only providers without a live catalog in manual-entry mode', () => {
    expect(isManualEntryDirectProvider('alibaba')).toBe(true)
    expect(isManualEntryDirectProvider('stepfun')).toBe(true)

    for (const provider of [
      'togetherai',
      'fireworks',
      'baseten',
      'cerebras',
      'minimax',
      'mimo',
      'qwen_token_plan',
      'cohere'
    ]) {
      expect(isManualEntryDirectProvider(provider)).toBe(false)
    }
  })

  it('uses the same provider rule for Settings connection selectors', () => {
    expect(isManualEntryCatalogConnection('direct:alibaba')).toBe(true)
    expect(isManualEntryCatalogConnection('direct:stepfun')).toBe(true)
    expect(isManualEntryCatalogConnection('direct:togetherai')).toBe(false)
    expect(isManualEntryCatalogConnection('direct:fireworks')).toBe(false)
    expect(isManualEntryCatalogConnection('direct:baseten')).toBe(false)
    expect(isManualEntryCatalogConnection('direct:cerebras')).toBe(false)
    expect(isManualEntryCatalogConnection('direct:qwen_token_plan')).toBe(false)
  })

  it('keeps custom provider connections manual without adding them to the provider catalog', () => {
    expect(isManualEntryCatalogConnection('direct:custom_my_provider')).toBe(true)
    expect(isManualEntryCatalogConnection('vercel-gateway')).toBe(false)
    expect(isManualEntryCatalogConnection(null)).toBe(false)
  })
})
