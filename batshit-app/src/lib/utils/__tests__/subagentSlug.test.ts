import { describe, expect, it } from 'vitest'

import {
  buildCliSubagentRuntimeId,
  resolveSubagentSlug
} from '../subagentSlug'

describe('subagentSlug', () => {
  it('uses the stored slug/id before display text', () => {
    expect(
      resolveSubagentSlug({
        id: 'api-helper',
        displayName: 'Renamed API Helper'
      })
    ).toBe('api_helper')
  })

  it('lets an explicit slug win when records gain one', () => {
    expect(
      resolveSubagentSlug({
        slug: 'manual_slug',
        id: 'old_id',
        displayName: 'Display Only'
      })
    ).toBe('manual_slug')
  })

  it('falls back to display name for legacy records without ids', () => {
    expect(resolveSubagentSlug({ displayName: 'Display Only' })).toBe('display_only')
  })

  it('builds managed CLI subagent runtime ids from the same slug sanitizer', () => {
    expect(buildCliSubagentRuntimeId('API Helper')).toBe('subagent_cli_api_helper')
  })
})
