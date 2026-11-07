// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { RequestEvent } from '@sveltejs/kit'
const leaves = vi.hoisted(() => ({ capture: vi.fn(), assert: vi.fn(), auth: vi.fn(), source: vi.fn() }))
vi.mock('../skillSessions', () => ({ captureSkillReadChoice: leaves.capture, assertSkillReadChoice: leaves.assert }))
vi.mock('../nativeToolAuth', () => ({ resolveNativeToolUser: leaves.auth }))
vi.mock('../skillRuntimeToolService', () => ({ executeSkillRuntimeAction: leaves.source }))
vi.mock('../skillRegistry', () => ({ getSkill: vi.fn(async () => ({ id: 'skill_one', user_id: 'cli-owner', name: 'One',
  source: 'custom', skill_markdown: '# One', bundle_files: [] })), evaluateSkillDependencies: vi.fn() }))
vi.mock('../slashCommandCapabilities', async original => ({ ...await original<typeof import('../slashCommandCapabilities')>(),
  resolveSkillAccessForActor: vi.fn(async () => ({ ok: true, skillId: 'skill_one', command: { id: 'skill-one', skill_id: 'skill_one' } })) }))
import { redis } from '$lib/server/redis'
const CLI_SKILL_READ_HEADER = 'x-batshit-skill-read-id'
import { POST as runtimePost } from '../../../../routes/api/skills/runtime/+server'

/**
 * The source of a managed helper's `native_skill` call. SA-139 R4 removed the CLI Primary's
 * registered skill-read runs (and `/api/skills/deliver`), so every call reads its source
 * directly and gets no read receipt. The caller here is a CLI Subagent's run credential, the
 * lane that still reads through this route until R5.
 */
const auth = { auth: 'session', userId: 'cli-owner' }
const result = (content = 'Instructions', action = 'read') => ({ success: true, action,
  ...(action === 'invoke' ? { skill: { id: 'skill_one', name: 'One' }, skillMarkdown: content } : { skillId: 'skill_one', skillName: 'One', path: 'references/task.md', content }),
  sourceSha256: createHash('sha256').update(content).digest('hex'), offset: 0, originalChars: content.length, returnedChars: content.length })
function event(path: string, body: unknown) {
  return { request: new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) }), locals: {} } as RequestEvent
}
beforeEach(async () => {
  await redis.set('agent:cli-helper', { id: 'cli-helper', user_id: auth.userId } as any)
  vi.clearAllMocks()
  leaves.capture.mockImplementation(async () => Object.freeze({}))
  leaves.auth.mockResolvedValue(auth)
  leaves.source.mockResolvedValue(result())
})

describe('actual CLI skill source route', () => {
  it('preserves the actual runtime service omitted-action=list contract without a read receipt or lifecycle capture', async () => {
    const actual = await vi.importActual<typeof import('../skillRuntimeToolService')>('../skillRuntimeToolService')
    leaves.source.mockImplementation(actual.executeSkillRuntimeAction)
    const response = await runtimePost(event('/api/skills/runtime', { skillId: 'skill_one', agentId: 'cli-helper' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, action: 'list', skillId: 'skill_one' })
    expect(response.headers.get(CLI_SKILL_READ_HEADER)).toBeNull()
    expect(leaves.capture).not.toHaveBeenCalled()
  })
  it('keeps session reads without a retired helper receipt', async () => {
    const response = await runtimePost(event('/api/skills/runtime', { skillId: 'skill_one', agentId: 'cli-helper', action: 'read' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, content: 'Instructions' })
    expect(response.headers.get(CLI_SKILL_READ_HEADER)).toBeNull()
    expect(leaves.capture).not.toHaveBeenCalled()
  })
})
