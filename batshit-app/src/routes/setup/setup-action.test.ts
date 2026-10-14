import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  createAdminUser: vi.fn(),
  createSession: vi.fn(),
  hasUsers: vi.fn()
}))
vi.mock('$lib/services/auth.server', () => ({
  authService: fixture,
  resolveSessionCookieName: () => 'fixture-first-admin',
  resolveSessionCookieSecure: () => false
}))
import { actions } from './+page.server'

function event(fields: Record<string, string | Blob> = {}) {
  const form = new FormData()
  for (const [key, value] of Object.entries({
    email: 'fixture@example.invalid', password: 'synthetic-password',
    confirmPassword: 'synthetic-password', displayName: 'Fixture', ...fields
  })) form.set(key, value)
  return {
    request: { formData: async () => form },
    cookies: { set: vi.fn() }
  } as any
}

describe('first-admin setup action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fixture.createAdminUser.mockResolvedValue({ success: true, user: { id: 'fixture', email: 'fixture@example.invalid', is_admin: true } })
    fixture.createSession.mockResolvedValue({ token: 'synthetic-session' })
  })

  it('uses service admission even when called directly without a page load, and sets no cookie on refusal', async () => {
    fixture.createAdminUser.mockResolvedValue({ success: false, status: 409, error: 'Saved account state exists.' })
    const input = event()
    const result = await actions.setup(input)
    expect(result).toMatchObject({ status: 409, data: { error: 'Saved account state exists.' } })
    expect(fixture.hasUsers).not.toHaveBeenCalled()
    expect(fixture.createSession).not.toHaveBeenCalled()
    expect(input.cookies.set).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('synthetic-password')
  })

  it('preserves the successful auto-login redirect and HTTP-only session cookie', async () => {
    const input = event()
    await expect(actions.setup(input)).rejects.toMatchObject({ status: 303, location: '/' })
    expect(input.cookies.set).toHaveBeenCalledWith('fixture-first-admin', 'synthetic-session', {
      path: '/', httpOnly: true, secure: false, sameSite: 'lax', maxAge: undefined
    })
  })

  it('does not create a session or cookie after service failure', async () => {
    fixture.createAdminUser.mockRejectedValue(new Error('Account admission failed.'))
    const input = event()
    expect(await actions.setup(input)).toMatchObject({ status: 500, data: { error: 'Account admission failed.' } })
    expect(fixture.createSession).not.toHaveBeenCalled()
    expect(input.cookies.set).not.toHaveBeenCalled()
  })

  it.each([
    { password: '' }, { email: '' }, { displayName: '' },
    { confirmPassword: 'different-password' }, { password: 'short', confirmPassword: 'short' },
    { email: new Blob(['not-text']) }, { password: new Blob(['not-text']) }
  ])('rejects invalid form fields before service admission: %j', async (fields) => {
    const input = event(fields)
    expect(await actions.setup(input)).toMatchObject({ status: 400 })
    expect(fixture.createAdminUser).not.toHaveBeenCalled()
    expect(fixture.createSession).not.toHaveBeenCalled()
    expect(input.cookies.set).not.toHaveBeenCalled()
  })
})
