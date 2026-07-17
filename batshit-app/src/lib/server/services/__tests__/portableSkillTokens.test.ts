import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  json: new Map<string, any>(),
  sets: new Map<string, Set<string>>(),
  lists: new Map<string, string[]>()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: async (operation: any) =>
      operation({
        json: {
          get: async (key: string) => store.json.get(key) ?? null,
          set: async (key: string, _path: string, value: any) => {
            store.json.set(key, value)
            return 'OK'
          }
        },
        sAdd: async (key: string, value: string) => {
          const set = store.sets.get(key) ?? new Set<string>()
          set.add(value)
          store.sets.set(key, set)
          return 1
        },
        sMembers: async (key: string) => Array.from(store.sets.get(key) ?? []),
        sRem: async (key: string, value: string) => {
          const set = store.sets.get(key)
          if (!set) return 0
          const deleted = set.delete(value) ? 1 : 0
          if (set.size === 0) {
            store.sets.delete(key)
          } else {
            store.sets.set(key, set)
          }
          return deleted
        },
        del: async (key: string) => {
          const deletedJson = store.json.delete(key) ? 1 : 0
          const deletedSet = store.sets.delete(key) ? 1 : 0
          const deletedList = store.lists.delete(key) ? 1 : 0
          return deletedJson + deletedSet + deletedList
        },
        lPush: async (key: string, value: string) => {
          const list = store.lists.get(key) ?? []
          list.unshift(value)
          store.lists.set(key, list)
          return list.length
        },
        lTrim: async (key: string, start: number, stop: number) => {
          const list = store.lists.get(key) ?? []
          store.lists.set(key, list.slice(start, stop + 1))
          return 'OK'
        }
      })
  }
}))

import {
  createPortableSkillToken,
  ensurePortableSkillEnvTemplates,
  getPortableSkillAllowedControlIds,
  getPortableSkillRequiredFamiliesForControl,
  isPortableSkillControlAllowed,
  listPortableSkillTokens,
  recordPortableSkillTokenControlExecution,
  revokePortableSkillToken,
  rotatePortableSkillToken,
  updatePortableSkillToken,
  validatePortableSkillToken
} from '../portableSkillTokens'

describe('portableSkillTokens', () => {
  beforeEach(() => {
    store.json.clear()
    store.sets.clear()
    store.lists.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('mints show-once secrets while storing only token hashes in summaries', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Claude Code voice setup',
      families: ['voice-engines']
    })

    expect(minted.token).toMatch(/^bspt_/)
    expect(minted.record.label).toBe('Claude Code voice setup')
    expect(minted.record.families).toEqual(['voice-engines'])
    expect('tokenHash' in minted.record).toBe(false)

    const listed = await listPortableSkillTokens('user-1')
    expect(listed).toHaveLength(1)
    expect('tokenHash' in listed[0]).toBe(false)
  })

  it('validates a token and derives the scoped control allow-list', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Voice token',
      families: ['voice-engines']
    })

    const validation = await validatePortableSkillToken(minted.token)
    expect(validation.valid).toBe(true)
    if (!validation.valid) return
    expect(validation.userId).toBe('user-1')
    expect(validation.allowedControlIds).toContain('sys.voice.engine.complete_local_setup')
    expect(validation.allowedControlIds).toContain('sys.runtime_addon.status')
    expect(validation.allowedControlIds).not.toContain('sys.artifact.create')
  })

  it('rotates and revokes token secrets without changing the token record id', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Portable artifact token',
      families: ['artifacts']
    })

    const rotated = await rotatePortableSkillToken({
      userId: 'user-1',
      tokenId: minted.record.id
    })
    expect(rotated.record.id).toBe(minted.record.id)
    await expect(validatePortableSkillToken(minted.token)).resolves.toMatchObject({
      valid: false,
      reason: 'invalid'
    })
    await expect(validatePortableSkillToken(rotated.token)).resolves.toMatchObject({
      valid: true,
      userId: 'user-1'
    })

    await revokePortableSkillToken({
      userId: 'user-1',
      tokenId: minted.record.id
    })
    await expect(validatePortableSkillToken(rotated.token)).resolves.toMatchObject({
      valid: false,
      reason: 'invalid'
    })
    await expect(listPortableSkillTokens('user-1')).resolves.toHaveLength(0)
    expect(store.sets.get('portable_skill_tokens:user-1')).toBeUndefined()
  })

  it('updates family scopes and records last-used execution metadata', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Narrow token',
      families: ['skills']
    })

    const updated = await updatePortableSkillToken({
      userId: 'user-1',
      tokenId: minted.record.id,
      families: ['skills', 'cli-tools']
    })
    expect(updated.families).toEqual(['skills', 'cli-tools'])

    await recordPortableSkillTokenControlExecution({
      userId: 'user-1',
      tokenId: minted.record.id,
      tokenLabel: 'Narrow token',
      controlId: 'sys.cli_tool.test',
      success: true
    })

    const listed = await listPortableSkillTokens('user-1')
    expect(listed[0].lastUsedAt).toEqual(expect.any(String))
    expect(store.lists.get('portable_skill_token_executions:user-1')).toHaveLength(1)
  })

  it('exposes deterministic family scope helpers', () => {
    expect(getPortableSkillAllowedControlIds(['artifacts'])).toContain('sys.model_catalog.search')
    expect(getPortableSkillAllowedControlIds(['goon-scenes'])).toEqual(['sys.goon_scene.creator_info'])
    expect(isPortableSkillControlAllowed('sys.cli_tool.test', ['cli-tools'])).toBe(true)
    expect(isPortableSkillControlAllowed('sys.cli_tool.test', ['skills'])).toBe(false)
    expect(isPortableSkillControlAllowed('sys.goon_scene.creator_info', ['goon-scenes'])).toBe(true)
    expect(getPortableSkillRequiredFamiliesForControl('sys.artifact.create')).toEqual(['artifacts'])
    expect(getPortableSkillRequiredFamiliesForControl('sys.goon_scene.creator_info')).toEqual([
      'goon-scenes'
    ])
    expect(getPortableSkillRequiredFamiliesForControl('sys.zip.fetch')).toEqual([])
  })

  it('reports host-side env template guidance without writing in containerized runtimes', async () => {
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')

    const templates = await ensurePortableSkillEnvTemplates()

    expect(templates).toHaveLength(1)
    expect(templates[0]).toMatchObject({
      id: 'portable-skills',
      kind: 'shared',
      skillId: null,
      family: null,
      path: '~/.batshit/portable-skills/portable-skills.env',
      writable: false,
      exists: false,
      created: false
    })
    expect(templates[0].placeholder).toContain('BATSHIT_PORTABLE_TOKEN=paste-your-portable-skill-token-here')
  })
})
