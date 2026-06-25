import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  useControl: vi.fn(),
  recordPortableSkillTokenControlExecution: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveNativeToolUser
}))

vi.mock('$lib/server/services/fabricRegistry', () => ({
  useControl: mocks.useControl
}))

vi.mock('$lib/server/services/portableSkillTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/portableSkillTokens')>()
  return {
    ...actual,
    recordPortableSkillTokenControlExecution: mocks.recordPortableSkillTokenControlExecution
  }
})

import { POST } from './+server'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/controls/use', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('/api/controls/use portable skill token lane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'portable-skill',
      portableSkillToken: {
        id: 'pst_1',
        userId: 'user-1',
        label: 'Voice setup',
        families: ['voice-engines'],
        tokenPrefix: 'bspt_test',
        tokenSuffix: 'secret',
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null
      },
      portableSkillAllowedControlIds: [
        'sys.voice.engine.health_check',
        'sys.voice.engine.complete_local_setup'
      ]
    })
  })

  it('forces allowRisky and the token-derived control allow-list', async () => {
    mocks.useControl.mockResolvedValue({
      success: true,
      controlId: 'sys.voice.engine.complete_local_setup',
      dryRun: false,
      riskLevel: 'confirm',
      status: 'published',
      result: { ok: true }
    })

    const response = await POST({
      request: request({
        controlId: 'sys.voice.engine.complete_local_setup',
        input: { engineId: 'demo' },
        allowRisky: false,
        allowedControlIds: ['sys.artifact.create']
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        controlId: 'sys.voice.engine.complete_local_setup',
        allowRisky: true,
        actorType: 'portable-skill',
        allowedControlIds: ['sys.voice.engine.health_check', 'sys.voice.engine.complete_local_setup']
      })
    )
    expect(mocks.recordPortableSkillTokenControlExecution).toHaveBeenCalledWith({
      userId: 'user-1',
      tokenId: 'pst_1',
      tokenLabel: 'Voice setup',
      controlId: 'sys.voice.engine.complete_local_setup',
      success: true,
      errorCode: null
    })
  })

  it('fails loudly before execution when the token lacks the required family', async () => {
    const response = await POST({
      request: request({
        controlId: 'sys.artifact.create',
        input: {}
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(403)
    expect(mocks.useControl).not.toHaveBeenCalled()
    const payload = await response.json()
    expect(payload.error.message).toContain('requires Portable Skill Token scope: Artifacts')
    expect(payload.error.message).toContain('Voice Engines')
    expect(mocks.recordPortableSkillTokenControlExecution).toHaveBeenCalledWith({
      userId: 'user-1',
      tokenId: 'pst_1',
      tokenLabel: 'Voice setup',
      controlId: 'sys.artifact.create',
      success: false,
      errorCode: 'CONTROL_NOT_ALLOWED'
    })
  })
})
