import { describe, expect, it } from 'vitest'

import { applyUnavailableWebSearchMetadata } from './webSearchAvailability'

describe('applyUnavailableWebSearchMetadata', () => {
  it('marks query-only search payloads as resultsUnavailable', () => {
    const result = applyUnavailableWebSearchMetadata({
      type: 'search',
      query: 'official Svelte 5 docs',
      queries: ['official Svelte 5 docs', 'Svelte 5 docs site:svelte.dev'],
      results: []
    }) as Record<string, any>

    expect(result.resultsUnavailable).toBe(true)
    expect(result.totalMatches).toBe(0)
    expect(result.queries).toEqual([
      'official Svelte 5 docs',
      'Svelte 5 docs site:svelte.dev'
    ])
  })

  it('does not mark opened-page payloads as resultsUnavailable', () => {
    const result = applyUnavailableWebSearchMetadata({
      type: 'open_page',
      query: 'https://svelte.dev/docs',
      url: 'https://svelte.dev/docs',
      results: [
        {
          title: 'https://svelte.dev/docs',
          url: 'https://svelte.dev/docs'
        }
      ]
    }) as Record<string, any>

    expect(result.resultsUnavailable).toBeUndefined()
  })
})
