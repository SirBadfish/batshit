import { beforeEach, describe, expect, it, vi } from 'vitest'

const management = vi.hoisted(() => ({
  isManageableProgram: vi.fn(),
  applyKoboldCppProfile: vi.fn(),
  applyKoboldCppContext: vi.fn(),
  enableKoboldManagedSetup: vi.fn(),
  validKoboldContextIntent: vi.fn(),
  validKoboldProfileExpectation: vi.fn(),
  loadLocalAiModel: vi.fn(),
  readLocalAiManagement: vi.fn(),
  readLocalAiAvailability: vi.fn(),
  unloadLocalAiModel: vi.fn()
}))

vi.mock('$lib/server/services/localAiModelManagement', () => management)

import { GET, POST } from './+server'

function event(method: 'GET' | 'POST', url: string, body?: unknown, userId: string | null = 'user-1') {
  return {
    url: new URL(url),
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    locals: { user: userId ? { id: userId } : null }
  } as any
}

const KEY = 'a'.repeat(64)
const VALID_LOAD = {
  program: 'koboldcpp', action: 'load', modelId: 'Qwen.gguf', expectedConnectionKey: KEY
}

describe('/api/settings/local-ai/models connection gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    management.isManageableProgram.mockImplementation((program: unknown) =>
      ['koboldcpp', 'llama-cpp', 'omlx'].includes(String(program))
    )
    management.readLocalAiManagement.mockResolvedValue({
      programId: 'koboldcpp', connectionKey: KEY, manageable: true, models: []
    })
    management.readLocalAiAvailability.mockResolvedValue({
      availability: 'reachable', baseUrl: 'http://localhost:5001', openaiPath: '/v1', models: { data: [] }
    })
    management.validKoboldProfileExpectation.mockReturnValue(true)
    management.applyKoboldCppProfile.mockResolvedValue({ success: false, outcomeUnknown: true, message: 'Check native state.' })
    management.loadLocalAiModel.mockResolvedValue({ success: true, message: 'Loaded' })
    management.unloadLocalAiModel.mockResolvedValue({ success: true, pending: true, message: 'Unloading' })
  })

  it('requires a signed-in user before reading or mutating models', async () => {
    const get = await GET(event('GET', 'http://localhost/api/settings/local-ai/models?program=koboldcpp', undefined, null))
    const post = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', VALID_LOAD, null))
    expect(get.status).toBe(401)
    expect(post.status).toBe(401)
    expect(management.readLocalAiManagement).not.toHaveBeenCalled()
    expect(management.loadLocalAiModel).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['too short', 'a'.repeat(63)],
    ['not hexadecimal', `${'a'.repeat(63)}g`],
    ['uppercase hexadecimal', 'A'.repeat(64)]
  ])('refuses a %s connection key before calling the management service', async (_name, key) => {
    const payload = { ...VALID_LOAD }
    if (key === undefined) delete (payload as Partial<typeof payload>).expectedConnectionKey
    else payload.expectedConnectionKey = key as string
    const response = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', payload))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false, error: 'Refresh the model list before using model controls.'
    })
    expect(management.loadLocalAiModel).not.toHaveBeenCalled()
    expect(management.unloadLocalAiModel).not.toHaveBeenCalled()
  })

  it('forwards the fresh connection key to load and unload and preserves pending unload', async () => {
    const load = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', {
      ...VALID_LOAD, baseConfig: 'fast.kcpps'
    }))
    expect(load.status).toBe(200)
    expect(management.loadLocalAiModel).toHaveBeenCalledWith('user-1', 'koboldcpp', 'Qwen.gguf', {
      baseConfig: 'fast.kcpps', expectedConnectionKey: KEY
    })

    const unload = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', {
      program: 'omlx', action: 'unload', modelId: 'Qwen', expectedConnectionKey: KEY
    }))
    expect(unload.status).toBe(200)
    expect(management.unloadLocalAiModel).toHaveBeenCalledWith('user-1', 'omlx', 'Qwen', KEY)
    expect(await unload.json()).toEqual({
      success: true, message: 'Unloading', restarted: undefined, pending: true
    })
  })

  it('returns the current availability read for the saved connection', async () => {
    const response = await GET(event(
      'GET', 'http://localhost/api/settings/local-ai/models?program=llama-cpp&mode=availability'
    ))
    expect(response.status).toBe(200)
    expect(management.readLocalAiAvailability).toHaveBeenCalledWith('user-1', 'llama-cpp')
    expect(await response.json()).toEqual({
      success: true,
      availability: 'reachable',
      baseUrl: 'http://localhost:5001',
      openaiPath: '/v1',
      models: { data: [] }
    })
    expect(management.readLocalAiManagement).not.toHaveBeenCalled()
  })
})


describe('saved profile route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    management.isManageableProgram.mockImplementation((program: unknown) => ['koboldcpp', 'lmstudio', 'omlx', 'llama-cpp'].includes(String(program)))
    management.validKoboldProfileExpectation.mockReturnValue(true)
    management.applyKoboldCppProfile.mockResolvedValue({ success: false, outcomeUnknown: true, message: 'Check native state.' })
  })
  const expectation = { expectedConnectionKey: KEY, observedModel: 'Qwen', observedContext: 16384,
    expectedModel: 'Qwen', expectedContext: 65536, quiescenceConfirmed: true }
  it('forwards verification-only fields to the scoped service and preserves an uncertain answer', async () => {
    const response = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', {
      program: 'koboldcpp', action: 'apply-profile', modelId: 'large.kcpps', expectation
    }))
    expect(management.applyKoboldCppProfile).toHaveBeenCalledWith('user-1', 'large.kcpps', expectation)
    expect(await response.json()).toMatchObject({ success: false, outcomeUnknown: true, message: 'Check native state.' })
    expect(management.loadLocalAiModel).not.toHaveBeenCalled()
  })
  it.each(['lmstudio', 'omlx', 'llama-cpp'])('refuses profile application for %s', async program => {
    const response = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', {
      program, action: 'apply-profile', modelId: 'large.kcpps', expectation
    }))
    expect(response.status).toBe(400)
    expect(management.applyKoboldCppProfile).not.toHaveBeenCalled()
  })
  it('requires signed-in scope and validated expectations', async () => {
    const payload = { program: 'koboldcpp', action: 'apply-profile', modelId: 'large.kcpps', expectation }
    expect((await POST(event('POST', 'http://localhost/api/settings/local-ai/models', payload, null))).status).toBe(401)
    management.validKoboldProfileExpectation.mockReturnValue(false)
    expect((await POST(event('POST', 'http://localhost/api/settings/local-ai/models', payload))).status).toBe(400)
    expect(management.applyKoboldCppProfile).not.toHaveBeenCalled()
  })
})

describe('BL-1213 typed context route', () => {
  it('requires session ownership and a valid finite intent before preparing context', async () => {
    const intent = { registrationId: 'registered', modelId: 'model', contextTokens: 60000 }
    management.isManageableProgram.mockReturnValue(true)
    management.validKoboldContextIntent.mockReturnValue(true)
    management.applyKoboldCppContext.mockResolvedValue({ success: false, outcomeUnknown: true, message: 'Reported 60000; full setup remains unverified.' })
    const unauth = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', { program: 'koboldcpp', action: 'apply-context', intent }, null))
    expect(unauth.status).toBe(401)
    const result = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', { program: 'koboldcpp', action: 'apply-context', intent }))
    expect(result.status).toBe(200)
    expect(management.applyKoboldCppContext).toHaveBeenCalledWith('user-1', intent)
    management.validKoboldContextIntent.mockReturnValue(false)
    const bad = await POST(event('POST', 'http://localhost/api/settings/local-ai/models', { program: 'koboldcpp', action: 'apply-context', intent: { path: '/tmp', json: {} } }))
    expect(bad.status).toBe(400)
  })
})
