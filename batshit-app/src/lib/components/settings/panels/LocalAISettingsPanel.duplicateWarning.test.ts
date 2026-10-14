import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { jsonResponse } from '$lib/test-utils/userSettingsRoute'
import LocalAISettingsPanel from './LocalAISettingsPanel.svelte'

/**
 * BL-962: the duplicate-address warning is worked out from `servers`, which holds the built-in
 * defaults until a real read of the saved servers succeeded. It must not be drawn from the
 * defaults: after a failed read the cards are hidden and so is the warning about them.
 *
 * With the real definitions the two programs that share a port (vLLM and oMLX, both on 8000) are
 * both OFF by default, and a disabled program never counts, so no warning could show on defaults
 * anyway. This file makes both of them ON by default (a definition change that could happen) so
 * the gate is what decides. The route and the panel both read the same changed definitions.
 */

vi.mock('$lib/data/localAiServers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/data/localAiServers')>()
  return {
    ...actual,
    LOCAL_AI_SERVER_DEFINITIONS: actual.LOCAL_AI_SERVER_DEFINITIONS.map((definition) =>
      definition.id === 'vllm' || definition.id === 'omlx'
        ? { ...definition, enabledByDefault: true }
        : definition
    )
  }
})

useRedisTestServer()

const USER = 'll962_dup_user'
const WARNING = /vLLM and oMLX are both set to http:\/\/localhost:8000/

type RouteModule = typeof import('../../../../routes/api/settings/local-ai/+server')
let route: RouteModule

beforeAll(async () => {
  route = await import('../../../../routes/api/settings/local-ai/+server')
}, 60_000)

let failGets = false

function installRoute() {
  failGets = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
      const method = (init.method ?? 'GET').toUpperCase()
      if (url.split('?')[0] === '/api/settings/local-ai' && method === 'GET') {
        if (failGets) return jsonResponse({ success: false, error: 'Redis unavailable' }, 500)
        return (await route.GET({ locals: { user: { id: USER } } } as any)) as Response
      }
      return jsonResponse({ error: `not routed in this test: ${method} ${url}` }, 404)
    })
  )
}

describe('Local AI duplicate-address warning waits for a real read (BL-962)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('after a failed read the defaults that share a port do not draw the duplicate warning', async () => {
    installRoute()
    failGets = true
    render(LocalAISettingsPanel, { props: { data: { user: { id: USER }, userSettings: null } } })
    await screen.findByTestId('local-ai-load-error')
    expect(screen.queryByText(WARNING)).toBeNull()
  }, 60_000)

  it('guard for the test above (a working read of a user with no saved servers does draw the warning, so the absence above is the gate)', async () => {
    installRoute()
    render(LocalAISettingsPanel, { props: { data: { user: { id: USER }, userSettings: null } } })
    await waitFor(() => expect(screen.getByText(WARNING)).toBeTruthy(), { timeout: 10_000 })
    expect(screen.queryByTestId('local-ai-load-error')).toBeNull()
  }, 60_000)
})
