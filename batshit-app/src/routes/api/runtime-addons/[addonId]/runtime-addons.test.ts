import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeAddonStatus: vi.fn(),
  prepareRuntimeAddon: vi.fn(),
  controlRuntimeAddon: vi.fn()
}))

vi.mock('$lib/server/services/runtimeAddons', () => ({
  getRuntimeAddonStatus: mocks.getRuntimeAddonStatus,
  prepareRuntimeAddon: mocks.prepareRuntimeAddon,
  controlRuntimeAddon: mocks.controlRuntimeAddon
}))

import { GET, POST } from './+server'

function request(body?: Record<string, unknown>) {
  return new Request('http://localhost/api/runtime-addons/fbx2vrma', {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
}

describe('/api/runtime-addons/[addonId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires an authenticated session', async () => {
    const response = await GET({
      locals: {},
      params: { addonId: 'fbx2vrma' },
      url: new URL('http://localhost/api/runtime-addons/fbx2vrma')
    } as any)

    expect(response.status).toBe(401)
  })

  it('loads prepared runtime add-on status for the Admin UI', async () => {
    mocks.prepareRuntimeAddon.mockResolvedValue({
      id: 'fbx2vrma',
      canStartAutomatically: false,
      operatorCommand: 'docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker'
    })

    const response = await GET({
      locals: { user: { id: 'user-1' } },
      params: { addonId: 'fbx2vrma' },
      url: new URL('http://localhost/api/runtime-addons/fbx2vrma?prepare=1')
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.prepareRuntimeAddon).toHaveBeenCalledWith('fbx2vrma')
    await expect(response.json()).resolves.toMatchObject({
      addon: {
        id: 'fbx2vrma',
        canStartAutomatically: false
      }
    })
  })

  it('starts approved add-ons through the runtime add-on service', async () => {
    mocks.controlRuntimeAddon.mockResolvedValue({
      success: true,
      operation: 'start',
      addonId: 'fbx2vrma'
    })

    const response = await POST({
      locals: { user: { id: 'user-1' } },
      params: { addonId: 'fbx2vrma' },
      request: request({ operation: 'start' })
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.controlRuntimeAddon).toHaveBeenCalledWith('fbx2vrma', 'start')
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      operation: 'start',
      addonId: 'fbx2vrma'
    })
  })

  it('returns 503 when the operator is unavailable', async () => {
    mocks.controlRuntimeAddon.mockResolvedValue({
      success: false,
      operation: 'start',
      addonId: 'fbx2vrma',
      error: 'Runtime add-on operator is not configured.'
    })

    const response = await POST({
      locals: { user: { id: 'user-1' } },
      params: { addonId: 'fbx2vrma' },
      request: request({ operation: 'start' })
    } as any)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Runtime add-on operator is not configured.'
    })
  })
})
