import { describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ getSession: vi.fn(), deleteSession: vi.fn(), cancel: vi.fn() }))
vi.mock('$lib/services/auth.server', () => ({ authService: { getSession: fixture.getSession, deleteSession: fixture.deleteSession }, resolveSessionCookieName: () => 'fixture-session' }))
vi.mock('$lib/server/services/chatgptPlanHost', () => ({ cancelChatgptPlanSignIn: fixture.cancel }))
import { POST } from './+server'

describe('logout while ChatGPT custody is unavailable', () => {
  it('deletes the signed-in session and cookie even if pending OAuth cancellation throws', async () => {
    fixture.getSession.mockResolvedValue({ user_id: 'fixture-user' })
    fixture.deleteSession.mockResolvedValue(undefined)
    fixture.cancel.mockImplementation(() => { throw new Error('synthetic custody failure') })
    const cookies = { get: vi.fn(() => 'fixture-token'), delete: vi.fn() }
    const response = await POST({ cookies } as any)
    expect(fixture.deleteSession).toHaveBeenCalledWith('fixture-token')
    expect(cookies.delete).toHaveBeenCalledWith('fixture-session', { path: '/' })
    expect(await response.json()).toEqual({ success: true })
  })
})
