import { describe, expect, it } from 'vitest'

import {
  canonicalizeCatalogDeveloperId,
  catalogDeveloperIdsMatch
} from './catalogDeveloperIdentity'

describe('catalogDeveloperIdentity', () => {
  it.each(['zai', 'z-ai', 'z.ai', 'zai-org', 'zai_coding', 'zai-coding'])(
    'groups the verified Z.ai alias %s under zai',
    (alias) => {
      expect(canonicalizeCatalogDeveloperId(alias)).toBe('zai')
    }
  )

  it('normalizes case and whitespace without rewriting unknown developers', () => {
    expect(canonicalizeCatalogDeveloperId('  Anthropic  ')).toBe('anthropic')
    expect(canonicalizeCatalogDeveloperId('open-ai')).toBe('open-ai')
  })

  it('matches only exact canonical aliases rather than fuzzy lookalikes', () => {
    expect(catalogDeveloperIdsMatch('z-ai', 'zai-org')).toBe(true)
    expect(catalogDeveloperIdsMatch('open-ai', 'openai')).toBe(false)
    expect(catalogDeveloperIdsMatch('zhipu', 'zai')).toBe(false)
  })
})
