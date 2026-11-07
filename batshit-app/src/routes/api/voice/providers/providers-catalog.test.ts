// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const summary = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/voiceService', () => ({ buildVoiceProviderSummary: summary }))
import { GET } from './+server'
beforeEach(() => { summary.mockReset(); summary.mockResolvedValue([]) })
describe('voice provider catalog refresh intent', () => {
  it.each([
    ['', false, false], ['?catalog=refresh', true, false], ['?refresh=1', true, true], ['?catalog=other', false, false]
  ])('keeps plain/runtime reads local and accepts only explicit picker refresh: %s', async (query, refreshCatalog, forceCatalog) => {
    const result = await GET({ locals: { user: { id: 'u' } }, url: new URL(`http://local/api/voice/providers${query}`) } as never)
    expect(result.status).toBe(200)
    expect(summary).toHaveBeenCalledExactlyOnceWith('u', { refreshCatalog, forceCatalog })
  })
  it('retains signed-in access before any metadata read', async () => {
    expect((await GET({ locals: {}, url: new URL('http://local/api/voice/providers?catalog=refresh') } as never)).status).toBe(401)
    expect(summary).not.toHaveBeenCalled()
  })
})
