import { describe, expect, it, vi } from 'vitest'
import { POST } from '../../../../routes/api/native-tools/guard-result/+server'

describe('retired HTTP result-guard route', () => {
  it('refuses before reading any untrusted body, regardless of claimed run details', async () => {
    const getReader = vi.fn()
    const request = { headers: new Headers({ 'x-batshit-agent-token': 'arc_old.bsac_secret' }), body: { getReader } } as unknown as Request
    const response = await POST({ request } as any)
    expect(response.status).toBe(403)
    expect(getReader).not.toHaveBeenCalled()
  })
})
