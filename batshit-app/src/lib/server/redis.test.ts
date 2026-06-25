import { describe, expect, it } from 'vitest'
import { resolveRedisConnectionUrl } from './redisConnection'

describe('resolveRedisConnectionUrl', () => {
  it('prefers REDIS_URL when provided', () => {
    expect(resolveRedisConnectionUrl({
      REDIS_URL: 'redis://127.0.0.1:6380/2',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REDIS_DB: '0'
    })).toBe('redis://127.0.0.1:6380/2')
  })

  it('builds a URL from host, port, and db overrides', () => {
    expect(resolveRedisConnectionUrl({
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6380',
      REDIS_DB: '4'
    })).toBe('redis://127.0.0.1:6380/4')
  })

  it('uses local Redis defaults when no overrides exist', () => {
    expect(resolveRedisConnectionUrl({})).toBe('redis://localhost:6379')
  })
})
