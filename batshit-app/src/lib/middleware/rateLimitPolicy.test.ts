import { describe, expect, it } from 'vitest'
import { isAuthRateLimitedPath, shouldApplyBroadApiRateLimit } from './rateLimitPolicy'

describe('rateLimitPolicy', () => {
  it('keeps auth endpoints on the stricter auth limiter path', () => {
    expect(isAuthRateLimitedPath('/api/auth/login')).toBe(true)
    expect(isAuthRateLimitedPath('/login', 'POST')).toBe(true)
    expect(isAuthRateLimitedPath('/setup', 'POST')).toBe(true)
    expect(isAuthRateLimitedPath('/login', 'GET')).toBe(false)
    expect(isAuthRateLimitedPath('/setup', 'GET')).toBe(false)
    // /api/login and /api/register were never real routes (G-0239d).
    expect(isAuthRateLimitedPath('/api/login')).toBe(false)
    expect(isAuthRateLimitedPath('/api/register')).toBe(false)
    expect(isAuthRateLimitedPath('/api/messages/example')).toBe(false)
  })

  it('does not broad-limit signed-in app traffic', () => {
    expect(
      shouldApplyBroadApiRateLimit({
        path: '/api/messages/example',
        rateLimitingDisabled: false,
        isAuthenticatedUser: true
      })
    ).toBe(false)
  })

  it('broad-limits unauthenticated API traffic', () => {
    expect(
      shouldApplyBroadApiRateLimit({
        path: '/api/messages/example',
        rateLimitingDisabled: false,
        isAuthenticatedUser: false
      })
    ).toBe(true)
  })

  it('does not broad-limit non-API paths or disabled local smoke traffic', () => {
    expect(
      shouldApplyBroadApiRateLimit({
        path: '/chat',
        rateLimitingDisabled: false,
        isAuthenticatedUser: false
      })
    ).toBe(false)
    expect(
      shouldApplyBroadApiRateLimit({
        path: '/api/messages/example',
        rateLimitingDisabled: true,
        isAuthenticatedUser: false
      })
    ).toBe(false)
  })
})
