import { describe, expect, it } from 'vitest'
import { resolveAuthRedisUrl, resolveSessionCookieName } from './auth.server'

describe('resolveAuthRedisUrl', () => {
  it('uses REDIS_URL when present', () => {
    expect(resolveAuthRedisUrl({ REDIS_URL: 'redis://127.0.0.1:6380/0' })).toBe(
      'redis://127.0.0.1:6380/0'
    )
  })

  it('builds a URL from host, port, and db overrides', () => {
    expect(
      resolveAuthRedisUrl({
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6380',
        REDIS_DB: '3'
      })
    ).toBe('redis://127.0.0.1:6380/3')
  })

  it('defaults to the normal local Redis URL', () => {
    expect(resolveAuthRedisUrl({})).toBe('redis://localhost:6379')
  })
})

describe('resolveSessionCookieName', () => {
  it('keeps the normal Batshit cookie name by default', () => {
    expect(resolveSessionCookieName({})).toBe('batshit_session')
  })

  it('allows local smoke launchers to keep localhost sessions separate', () => {
    expect(resolveSessionCookieName({ BATSHIT_SESSION_COOKIE_NAME: 'batshit_session_smoke' })).toBe(
      'batshit_session_smoke'
    )
  })

  it('uses a separate cookie for Docker so localhost ports do not log each other out', () => {
    expect(resolveSessionCookieName({ BATSHIT_CONTAINERIZED: '1' })).toBe('batshit_session_docker')
  })

  it('allows launchers to provide an explicit cookie name', () => {
    expect(resolveSessionCookieName({ BATSHIT_SESSION_COOKIE_NAME: 'batshit_session_custom' })).toBe(
      'batshit_session_custom'
    )
  })
})
