import { describe, expect, it } from 'vitest'
import {
  hostedVercelAppDisabledResponse,
  isHostedAppExemptPath,
  shouldBlockHostedVercelAppRequest,
  isHostedVercelRegistryDeployment
} from './hostedAppGuard'

function request(pathname: string, env: Record<string, string | undefined> = {}) {
  return shouldBlockHostedVercelAppRequest({
    env,
    url: new URL(`https://app.batshit.ai${pathname}`)
  })
}

describe('hosted app guard', () => {
  it('blocks the hosted Vercel app surface by default', () => {
    expect(request('/setup', { VERCEL: '1' })).toBe(true)
    expect(request('/login', { VERCEL: 'true' })).toBe(true)
    expect(request('/', { VERCEL: '1' })).toBe(true)
  })

  it('allows normal self-hosted production runtimes outside Vercel', () => {
    expect(request('/setup', { NODE_ENV: 'production' })).toBe(false)
  })

  it('allows explicit hosted app opt-in', () => {
    expect(request('/setup', { VERCEL: '1', BATSHIT_ENABLE_HOSTED_APP: '1' })).toBe(false)
  })

  it('keeps public registry and protected cron endpoints reachable on Vercel', () => {
    expect(isHostedAppExemptPath('/registry/catalog.json')).toBe(true)
    expect(isHostedAppExemptPath('/registry/compatibility-matrix.json')).toBe(true)
    expect(isHostedAppExemptPath('/api/admin/cron/model-catalog')).toBe(true)
    expect(isHostedAppExemptPath('/api/admin/cron/compatibility-matrix')).toBe(true)

    expect(request('/registry/catalog.json', { VERCEL: '1' })).toBe(false)
    expect(request('/api/admin/cron/model-catalog', { VERCEL: '1' })).toBe(false)
  })

  it('treats Vercel without the hosted-app opt-in as a registry-only deployment', () => {
    expect(isHostedVercelRegistryDeployment({ VERCEL: '1' })).toBe(true)
    expect(isHostedVercelRegistryDeployment({ VERCEL: 'true' })).toBe(true)
  })

  it('does not treat self-hosted or opted-in hosted runtimes as registry-only', () => {
    expect(isHostedVercelRegistryDeployment({})).toBe(false)
    expect(isHostedVercelRegistryDeployment({ NODE_ENV: 'production' })).toBe(false)
    expect(
      isHostedVercelRegistryDeployment({ VERCEL: '1', BATSHIT_ENABLE_HOSTED_APP: '1' })
    ).toBe(false)
  })

  it('returns a non-indexable disabled response', () => {
    const response = hostedVercelAppDisabledResponse()

    expect(response.status).toBe(410)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
