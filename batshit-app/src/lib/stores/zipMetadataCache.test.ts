import { beforeEach, describe, expect, it } from 'vitest'

import {
  cacheMissingZipMetadata,
  chunkZipMetadataIds,
  clearZipMetadataCache,
  haveSameZipMetadataEntries,
  isZipMetadataMissCached
} from './zipMetadataCache.svelte'

describe('zipMetadataCache', () => {
  beforeEach(() => {
    clearZipMetadataCache()
  })

  it('treats a fresh Map with the same cached metadata entries as unchanged', () => {
    const zipA = { id: 'zip-a', tokens: 100 }
    const zipB = { id: 'zip-b', tokens: 200 }

    const current = new Map([
      ['zip-a', zipA],
      ['zip-b', zipB]
    ])
    const next = new Map([
      ['zip-a', zipA],
      ['zip-b', zipB]
    ])

    expect(haveSameZipMetadataEntries(current, next)).toBe(true)
  })

  it('detects changed cached metadata entries', () => {
    const current = new Map([['zip-a', { id: 'zip-a', tokens: 100 }]])
    const next = new Map([['zip-a', { id: 'zip-a', tokens: 100 }]])

    expect(haveSameZipMetadataEntries(current, next)).toBe(false)
  })

  it('splits zip metadata requests into bounded batches', () => {
    const ids = Array.from({ length: 205 }, (_value, index) => `zip-${index}`)

    const batches = chunkZipMetadataIds(ids, 100)

    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(100)
    expect(batches[1]).toHaveLength(100)
    expect(batches[2]).toHaveLength(5)
  })

  it('tracks temporary missing zip metadata misses', () => {
    cacheMissingZipMetadata(['zip-missing'], 10, 1000)

    expect(isZipMetadataMissCached('zip-missing', 1005)).toBe(true)
    expect(isZipMetadataMissCached('zip-missing', 1011)).toBe(false)
  })
})
