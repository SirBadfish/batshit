import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: vi.fn()
}))

vi.mock('$lib/server/services/skillRuntimeToolService', () => ({
  executeSkillRuntimeAction: vi.fn()
}))

import { POST } from './+server'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { executeSkillRuntimeAction } from '$lib/server/services/skillRuntimeToolService'

function buildEvent(body: Record<string, unknown>): RequestEvent {
  const request = new Request('http://localhost/api/skills/runtime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  return {
    request,
    locals: { user: { id: 'user-1' } }
  } as unknown as RequestEvent
}

describe('POST /api/skills/runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the shared skill runtime payload for authorized callers', async () => {
    vi.mocked(resolveNativeToolUser).mockResolvedValue({
      userId: 'user-1',
      auth: 'service'
    })
    vi.mocked(executeSkillRuntimeAction).mockResolvedValue({
      success: true,
      action: 'invoke',
      skill: {
        id: 'speech_setup',
        name: 'Speech Setup',
        description: 'Canonical speech setup',
        references: ['references/runtime-preflight.md'],
        scripts: []
      },
      skillMarkdown: '# Speech Setup',
      warnings: [],
      dependencyStatuses: []
    } as any)

    const response = await POST(
      buildEvent({
        userId: 'user-1',
        skillId: 'speech_setup',
        action: 'invoke'
      })
    )

    expect(response.status).toBe(200)
    const payload = await response.json()

    expect(resolveNativeToolUser).toHaveBeenCalled()
    expect(executeSkillRuntimeAction).toHaveBeenCalledWith({
      userId: 'user-1',
      skillId: 'speech_setup',
      action: 'invoke',
      path: undefined,
      maxChars: undefined
    })
    expect(payload.auth).toBe('service')
    expect(payload.skill.id).toBe('speech_setup')
  })

  it('rejects unauthorized requests', async () => {
    vi.mocked(resolveNativeToolUser).mockResolvedValue(null)

    const response = await POST(
      buildEvent({
        skillId: 'speech_setup',
        action: 'list'
      })
    )

    expect(response.status).toBe(401)
    const payload = await response.json()
    expect(payload.error).toBe('Unauthorized')
  })
})
