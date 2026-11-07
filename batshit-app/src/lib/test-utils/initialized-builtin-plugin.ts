/**
 * BL-2192: consumer suites start after catalog bootstrap. Keep the persisted
 * plugin, commands and skill metadata real; do not add a shared fake Lua engine.
 * Migration/bootstrap semantics remain owned by the real-Redis owner suites.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BUILTIN_PLUGIN_SKILLS, getBuiltinSystemSkillsRoot } from '$lib/server/services/systemPluginPackage'
import { validateAgentPluginRecord } from '$lib/server/services/agentPlugins'
import { splitFrontmatter } from '$lib/server/services/skillFrontmatter'

export function initializedBuiltinPluginEntries(userId: string): Array<[string, any]> {
  const now = '2026-10-24T00:00:00.000Z'
  const entries: Array<[string, any]> = [[`agent_plugin:${userId}:batshit`, {
    id: 'batshit', user_id: userId, name: 'Batshit', description: 'Seven Batshit skills.',
    builtIn: true, version: '1.0.0', revision: 'initialized-consumer-fixture',
    enabled_for_all_agents: false, enabled_agent_ids: [], created_at: now, updated_at: now,
    skills: BUILTIN_PLUGIN_SKILLS.map(skill => ({ commandId: skill.commandId, skillId: skill.skillId,
      name: skill.displayName, invocation: `/batshit:${skill.commandId}` }))
  }]]
  for (const skill of BUILTIN_PLUGIN_SKILLS) {
    const source = path.join(getBuiltinSystemSkillsRoot(), skill.directory)
    const markdown = readFileSync(path.join(source, 'SKILL.md'), 'utf8')
    const { frontmatter } = splitFrontmatter(markdown)
    const allowedTools = String((frontmatter.metadata as Record<string, string>).allowedTools).split(',')
    entries.push([`skill:${userId}:${skill.skillId}`, {
      id: skill.skillId, user_id: userId, name: skill.directory, displayName: skill.displayName,
      description: frontmatter.description, skill_markdown: '', bundle_files: [],
      source: 'system', source_ref: source, cache_path: path.join(source, 'SKILL.md'),
      allowed_tools: allowedTools, is_system: true, is_active: true, trust_level: 'trusted',
      has_references: true, created_at: now, updated_at: now
    }], [`slash_command:${userId}:${skill.commandId}`, {
      id: skill.commandId, user_id: userId, name: skill.directory, displayName: skill.displayName,
      description: frontmatter.description, type: 'skill', instructions: 'Use the canonical skill.',
      parameters: [], skill_id: skill.skillId, skill_source: 'system', skill_source_ref: source,
      skill_allowed_tools: allowedTools, is_system: true, is_active: true, plugin_id: 'batshit',
      invocation_pattern: `/batshit:${skill.commandId}`, can_be_invoked_in_chat: true,
      can_be_attached_to_agents: false, enabled_for_all_agents: false, enabled_agent_ids: [],
      usage_count: 0, created_at: now, updated_at: now
    }])
  }
  return entries
}

/** A fake-lane startup handoff assertion, not an access/migration replacement. */
export async function assertInitializedBuiltinPlugin(userId: string, read: (key: string) => unknown | Promise<unknown>): Promise<void> {
  validateAgentPluginRecord(await read(`agent_plugin:${userId}:batshit`), userId, 'batshit')
  for (const skill of BUILTIN_PLUGIN_SKILLS) {
    const command = await read(`slash_command:${userId}:${skill.commandId}`) as Record<string, unknown> | null
    const metadata = await read(`skill:${userId}:${skill.skillId}`) as Record<string, unknown> | null
    if (!command || command.id !== skill.commandId || command.user_id !== userId || command.type !== 'skill' ||
        command.skill_id !== skill.skillId || command.plugin_id !== 'batshit' ||
        !metadata || metadata.id !== skill.skillId || metadata.user_id !== userId || metadata.source !== 'system' ||
        metadata.source_ref !== path.join(getBuiltinSystemSkillsRoot(), skill.directory) ||
        metadata.cache_path !== path.join(getBuiltinSystemSkillsRoot(), skill.directory, 'SKILL.md') ||
        metadata.skill_markdown !== '' || !Array.isArray(metadata.bundle_files) || metadata.bundle_files.length !== 0) {
      throw new Error(`Incomplete post-startup Batshit fixture: ${skill.commandId}`)
    }
  }
}
