/**
 * BL-369 review 5: creating a command for an existing skill whose files are missing answers 409
 * with the reason (the folder it looked in), never a generic 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

vi.mock('$lib/server/redis', () => ({
  redis: {
    exists: vi.fn(async () => 0),
    json: { get: vi.fn(), set: vi.fn() }
  }
}))

vi.mock('$lib/server/services/skillRegistry', () => ({
  getSkill: vi.fn(),
  normalizeSkillId: vi.fn((value: string) => value),
  upsertSkill: vi.fn()
}))

vi.mock('$lib/server/services/systemSlashCommands', () => ({
  ensureSystemSlashCommands: vi.fn()
}))

import { POST } from './+server'
import { redis } from '$lib/server/redis'
import { getSkill } from '$lib/server/services/skillRegistry'

function buildEvent(body: Record<string, unknown>): RequestEvent {
  return {
    request: new Request('http://localhost/api/slash-commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: 'user-1' } }
  } as unknown as RequestEvent
}

describe('POST /api/slash-commands for a skill whose files are missing (BL-369)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers 409 with the reason and writes nothing', async () => {
    vi.mocked(getSkill).mockRejectedValue(
      Object.assign(new Error('The files for skill "zc_notes" are missing from /tmp/zc/skills/zc_notes.'), {
        code: 'SKILL_FILES_MISSING'
      })
    )

    const response = await POST(buildEvent({ name: 'zc-notes', type: 'skill', skill_id: 'zc_notes' }))

    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload).toMatchObject({ code: 'SKILL_FILES_MISSING' })
    expect(payload.error).toContain('are missing from /tmp/zc/skills/zc_notes')
    expect(redis.json.set).not.toHaveBeenCalled()
  })
})
