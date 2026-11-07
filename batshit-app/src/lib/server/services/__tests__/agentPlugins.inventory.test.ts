// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { BUILTIN_PLUGIN_SKILLS, LEGACY_BUILTIN_PLUGIN_SKILLS } from '../systemPluginPackage'
import { ensureBuiltinAgentPlugin, isBuiltinPluginMember, listAgentPlugins, projectPluginCommand, validateAgentPluginRecord } from '../agentPlugins'
import type { SlashCommandRow } from '$lib/types/database'

/** Fake-lane structural/read-only/collision proof. Upgrade Lua has separate actual-Redis tests. */
useRedisTestServer()
const USER = 'inventory-owner'
const KEY = `agent_plugin:${USER}:batshit`
function group(current = false) {
  return { id: 'batshit', user_id: USER, name: 'Batshit', description: 'Retained description', builtIn: true, version: 'retained-v1-label',
    skills: (current ? BUILTIN_PLUGIN_SKILLS : LEGACY_BUILTIN_PLUGIN_SKILLS).map(skill => ({ commandId: skill.commandId, skillId: skill.skillId, name: skill.displayName, invocation: `/batshit:${skill.commandId}` })),
    enabled_for_all_agents: false, enabled_agent_ids: ['Selected.Agent'], revision: 'retained-revision', created_at: 'original', updated_at: 'original',
    unknown: { keep: ['one', 'two'] } }
}
const custom = (): SlashCommandRow => ({ id: 'app-actions', user_id: USER, name: 'My App Actions', type: 'skill', skill_id: 'app_actions',
  instructions: 'Original user text', is_system: false, is_active: true, can_be_invoked_in_chat: true,
  enabled_for_all_agents: false, enabled_agent_ids: ['Independent.Agent'], created_at: 'original', updated_at: 'original' })

describe('seven-to-eight built-in inventory admission', () => {
  it('accepts exact saved seven and current eight inventories without imposing a new version-string rule', () => {
    expect(validateAgentPluginRecord(group(), USER).skills).toHaveLength(7)
    expect(validateAgentPluginRecord(group(true), USER).skills).toHaveLength(8)
    const malformed = group(true)
    malformed.skills[0] = { ...malformed.skills[0], skillId: 'unrecognized' as any }
    expect(() => validateAgentPluginRecord(malformed, USER)).toThrow('unreadable')
  })

  it('read-only listing preserves an old manifest and exact access without seeding a phantom eighth member', async () => {
    await redis.json.set(KEY, '$', group())
    const before = await redis.json.getRaw(KEY, '$')
    const plugins = await listAgentPlugins(USER, { readOnly: true })
    expect(plugins).toHaveLength(1)
    expect(plugins[0].skills).toHaveLength(7)
    expect(plugins[0]).toMatchObject({ enabled_for_all_agents: false, enabled_agent_ids: ['Selected.Agent'], revision: 'retained-revision' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
    expect(await redis.json.get(`slash_command:${USER}:app-actions`)).toBeNull()
    expect(await redis.json.get(`skill:${USER}:app_actions`)).toBeNull()
  })

  it.each([false, true])('preserves independent user projection when the saved group has current=%s inventory', async (current) => {
    const plugin = validateAgentPluginRecord(group(current), USER)
    const command = custom()
    expect(isBuiltinPluginMember(command)).toBe(false)
    expect(await projectPluginCommand(USER, command, [plugin])).toEqual(command)
    expect(isBuiltinPluginMember({ ...command, plugin_id: 'batshit' })).toBe(true)
  })

  it.each(['command', 'skill'] as const)('refuses a pre-existing custom %s collision before upgrade and preserves every saved byte', async (kind) => {
    await redis.json.set(KEY, '$', group())
    const key = kind === 'command' ? `slash_command:${USER}:app-actions` : `skill:${USER}:app_actions`
    const value = kind === 'command' ? custom() : { id: 'app_actions', user_id: USER, name: 'Mine', source: 'custom', is_system: false, skill_markdown: '# User instructions', bundle_files: [] }
    await redis.json.set(key, '$', value)
    const manifest = await redis.json.getRaw(KEY, '$'), collision = await redis.json.getRaw(key, '$')
    await expect(ensureBuiltinAgentPlugin(USER)).rejects.toMatchObject({ code: 'BUILTIN_SKILL_ID_COLLISION', outcome: 'not_written' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(manifest)
    expect(await redis.json.getRaw(key, '$')).toBe(collision)
  })

  it('a fresh group also refuses a user command collision rather than changing its class or default access', async () => {
    await redis.json.set(`slash_command:${USER}:app-actions`, '$', { ...custom(), type: 'prompt', skill_id: undefined })
    await expect(ensureBuiltinAgentPlugin(USER)).rejects.toMatchObject({ code: 'BUILTIN_SKILL_ID_COLLISION' })
    expect(await redis.json.get(KEY)).toBeNull()
    expect(await redis.json.get(`skill:${USER}:app_actions`)).toBeNull()
  })
})
