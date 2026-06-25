import { dev } from '$app/environment';
import type { RequestEvent } from '@sveltejs/kit'

type RateLimitPeriod = 's' | 'm' | 'h' | 'd'
type RateLimitRule = [limit: number, period: RateLimitPeriod]
type RateLimitCheckResult = {
  limited: boolean
  reason?: string
}

type RateLimitConfig = {
  IP?: RateLimitRule
  IPUA?: RateLimitRule
}

type Bucket = {
  count: number
  resetAt: number
}

const PERIOD_MS: Record<RateLimitPeriod, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000
}

const buckets = new Map<string, Bucket>()
let cleanupCursor = 0

function resolveClientAddress(event: RequestEvent) {
  try {
    return event.getClientAddress()
  } catch {
    return (
      event.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      event.request.headers.get('x-real-ip') ||
      'unknown'
    )
  }
}

function maybeCleanupExpiredBuckets(now: number) {
  cleanupCursor += 1
  if (cleanupCursor % 100 !== 0) return

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key)
    }
  }
}

export class InMemoryRateLimiter {
  constructor(private readonly config: RateLimitConfig) {}

  async check(event: RequestEvent): Promise<RateLimitCheckResult> {
    const now = Date.now()
    maybeCleanupExpiredBuckets(now)

    const ip = resolveClientAddress(event)
    const userAgent = event.request.headers.get('user-agent') || 'unknown'
    const checks: Array<[kind: keyof RateLimitConfig, value: string, rule: RateLimitRule]> = []

    if (this.config.IP) checks.push(['IP', ip, this.config.IP])
    if (this.config.IPUA) checks.push(['IPUA', `${ip}:${userAgent}`, this.config.IPUA])

    for (const [kind, value, [limit, period]] of checks) {
      const windowMs = PERIOD_MS[period]
      const key = `${kind}:${value}:${period}`
      const current = buckets.get(key)
      const bucket =
        current && current.resetAt > now
          ? current
          : {
              count: 0,
              resetAt: now + windowMs
            }

      bucket.count += 1
      buckets.set(key, bucket)

      if (bucket.count > limit) {
        return {
          limited: true,
          reason: `${kind} exceeded ${limit}/${period}`
        }
      }
    }

    return { limited: false }
  }
}

export function resetRateLimiterBucketsForTest() {
  buckets.clear()
  cleanupCursor = 0
}

// Rate limiter for authentication endpoints (stricter)
// Development: Very lenient to prevent blocking during development
// Production: 100 requests per hour per IP
export const authRateLimiter = new InMemoryRateLimiter({
  IP: dev ? [10000, 'h'] : [100, 'h'],
  IPUA: dev ? [10000, 'h'] : [100, 'h'],
})

// Rate limiter for general API endpoints (more lenient)
// Development: Very lenient to prevent blocking during rapid page loads
// Production: 1000 requests per hour per IP
export const apiRateLimiter = new InMemoryRateLimiter({
  IP: dev ? [50000, 'h'] : [1000, 'h'],
  IPUA: dev ? [50000, 'h'] : [1000, 'h'],
})
