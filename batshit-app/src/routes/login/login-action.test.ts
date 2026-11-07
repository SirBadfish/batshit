import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ authenticate: vi.fn(), createSession: vi.fn(), hasUsers: vi.fn() }))
vi.mock('$lib/services/auth.server', () => ({
  authService: fixture, resolveSessionCookieName: () => 'fixture-session', resolveSessionCookieSecure: () => false
}))
import { actions } from './+page.server'

function event() {
  const form = new FormData()
  form.set('email', 'fixture@example.invalid'); form.set('password', 'synthetic-password')
  return { request: { formData: async () => form }, cookies: { set: vi.fn() }, url: new URL('http://localhost/login') } as any
}
describe('sign-in initialization custody', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fixture.authenticate.mockResolvedValue({ id: 'fixture', email: 'fixture@example.invalid', is_admin: true })
    fixture.createSession.mockResolvedValue({ token: 'synthetic-session' })
  })
  it('publishes the existing cookie and redirect only after successful session admission', async () => {
    const input = event()
    await expect(actions.login(input)).rejects.toMatchObject({ status: 303, location: '/' })
    expect(input.cookies.set).toHaveBeenCalledWith('fixture-session', 'synthetic-session', expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }))
  })
  it('keeps initialization failure separate from an invalid password and publishes no cookie', async () => {
    fixture.createSession.mockRejectedValue(new Error('synthetic-private-initialization-detail'))
    const input = event()
    const result = await actions.login(input)
    expect(result).toMatchObject({ status: 503, data: { error: expect.stringContaining('Your account was authenticated and kept') } })
    expect(JSON.stringify(result)).not.toContain('synthetic-private-initialization-detail')
    expect(JSON.stringify(result)).not.toContain('synthetic-password')
    expect(input.cookies.set).not.toHaveBeenCalled()
    expect(fixture.createSession).toHaveBeenCalledTimes(1)
  })
  it('retains invalid-password refusal before any session initialization', async () => {
    fixture.authenticate.mockResolvedValue(null)
    const input = event()
    expect(await actions.login(input)).toMatchObject({ status: 401, data: { error: 'Invalid email or password' } })
    expect(fixture.createSession).not.toHaveBeenCalled()
    expect(input.cookies.set).not.toHaveBeenCalled()
  })
})
