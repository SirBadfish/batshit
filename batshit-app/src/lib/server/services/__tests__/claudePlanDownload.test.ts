// @vitest-environment node
/**
 * SA-139 P2 review (tools N1): without a request guard, the Claude plan run downloads a linked tool
 * image with the SDK's own download, and every download hears the run's end signal.
 */
import { describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ calls: [] as Array<{ url: URL; abortSignal?: AbortSignal }> }))
vi.mock('ai', async () => ({
  ...(await vi.importActual<typeof import('ai')>('ai')),
  createDownload: () => async (options: { url: URL; abortSignal?: AbortSignal }) => {
    seen.calls.push(options)
    return { data: new Uint8Array([1]), mediaType: 'image/png' }
  }
}))

import { defaultClaudePlanDownload } from '../claudePlanModel'

describe('defaultClaudePlanDownload', () => {
  it('hands the run\'s end signal to every download it makes, and skips URLs the model reads itself', async () => {
    const ended = new AbortController()
    const results = await defaultClaudePlanDownload(ended.signal)([
      { url: new URL('https://example.com/a.png'), isUrlSupportedByModel: false },
      { url: new URL('https://example.com/b.png'), isUrlSupportedByModel: true }
    ])
    expect(seen.calls.map(call => call.url.href)).toEqual(['https://example.com/a.png'])
    expect(seen.calls[0].abortSignal).toBe(ended.signal)
    expect(results[1]).toBeNull()
  })
})
