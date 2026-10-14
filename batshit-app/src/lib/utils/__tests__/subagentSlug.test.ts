import { describe, expect, it } from 'vitest'

import {
  buildCliSubagentRuntimeId,
  buildCliWorkerRuntimeId,
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

  // BL-285 (2026-09-27): a Worker used `subagent_cli_<slot>` like a Subagent, so a Subagent
  // slugged `worker_<agent>_<n>` shared a primary's Worker folder. A Subagent's slug can never
  // hold "-" (the sanitizer folds it into "_"), and a Worker's runtime id always does.
  it('keeps a Worker slot out of every Subagent runtime id', () => {
    const slot = 'worker_cooper_1'
    expect(buildCliWorkerRuntimeId(slot)).toBe('subagent_cli-worker_cooper_1')
    expect(buildCliWorkerRuntimeId(slot)).not.toBe(buildCliSubagentRuntimeId(slot))
    for (const name of [slot, 'worker-cooper-1', 'Worker Cooper 1', 'subagent_cli-worker_cooper_1', '-worker_cooper_1']) {
      const subagentRuntimeId = buildCliSubagentRuntimeId(resolveSubagentSlug({ id: name }))
      expect(subagentRuntimeId).not.toContain('-')
      expect(subagentRuntimeId).not.toBe(buildCliWorkerRuntimeId(slot))
    }
  })
})
