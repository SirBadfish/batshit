import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { splitFrontmatter } from './skillFrontmatter'
import { parseSkillToolGroups } from '$lib/utils/skillToolGroups'

export const BUNDLED_BATSHIT_PLUGIN_ID = 'batshit'
export const BUNDLED_BATSHIT_PLUGIN_VERSION = '1.1.0'
export const APP_ACTIONS_SKILL_ID = 'app_actions'
export const APP_ACTIONS_COMMAND_ID = 'app-actions'

/** Stable persisted identities; directory names are packaging details. */
export const LEGACY_BUILTIN_PLUGIN_SKILLS = Object.freeze([
  { commandId: 'batshit-guide', skillId: 'batshit_guide', directory: 'batshit-guide', legacyDirectory: 'batshit-guide', displayName: 'Batshit Guide' },
  { commandId: 'artifact-creator', skillId: 'artifact_creator', directory: 'artifact-creator', legacyDirectory: 'artifacts', displayName: 'Artifact Creator' },
  { commandId: 'cli-tool-creator', skillId: 'cli_tool_creator', directory: 'cli-tool-creator', legacyDirectory: 'cli-tools', displayName: 'CLI Tool Creator' },
  { commandId: 'goon-scene-creator', skillId: 'goon_scene_creator', directory: 'goon-scene-creator', legacyDirectory: 'goon-scene-creator', displayName: 'Goon Scene Creator' },
  { commandId: 'skill-creator', skillId: 'skill_creator', directory: 'skill-creator', legacyDirectory: 'skill-creator', displayName: 'Skill Creator' },
  { commandId: 'voice-engine-installer', skillId: 'voice_engine_installer', directory: 'voice-engine-installer', legacyDirectory: 'speech-setup', displayName: 'TTS/STT Engine Installer' },
  { commandId: 'goon-guide', skillId: 'goon_guide', directory: 'goon-guide', legacyDirectory: 'goon-guide', displayName: 'Goon Guide' }
] as const)
export const BUILTIN_PLUGIN_SKILLS = Object.freeze([
  ...LEGACY_BUILTIN_PLUGIN_SKILLS,
  { commandId: APP_ACTIONS_COMMAND_ID, skillId: APP_ACTIONS_SKILL_ID, directory: 'app-actions', legacyDirectory: 'app-actions', displayName: 'App Actions' }
] as const)

/** Existing custom records do not become system-owned because a new package adds their ID. */
export function isCanonicalAppActionsSkill(value: unknown, userId?: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (row.id !== APP_ACTIONS_SKILL_ID || userId !== undefined && row.user_id !== userId || row.is_system !== true || row.source !== 'system' || typeof row.source_ref !== 'string') return false
  const directory = path.posix.normalize(row.source_ref.replace(/\\/g, '/')).replace(/\/SKILL\.md$/i, '').replace(/\/+$/, '')
  return directory.endsWith('/system-plugins/batshit/skills/app-actions')
}
export function isCanonicalAppActionsCommand(value: unknown, userId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.id === APP_ACTIONS_COMMAND_ID && row.user_id === userId && row.type === 'skill' &&
    row.skill_id === APP_ACTIONS_SKILL_ID && row.plugin_id === BUNDLED_BATSHIT_PLUGIN_ID && row.is_system === true && row.skill_source === 'system'
}

/** Metadata only: canonical package files, no user source paths, body delivery or seeding. */
export function readBuiltinSkillToolGroups(skillId: string,
  readMarkdown: (file: string) => string = file => readFileSync(file, 'utf8')): readonly string[] {
  const skill = BUILTIN_PLUGIN_SKILLS.find(entry => entry.skillId === skillId)
  if (!skill) return []
  const { frontmatter } = splitFrontmatter(readMarkdown(path.join(getBuiltinSystemSkillsRoot(), skill.directory, 'SKILL.md')))
  const metadata = frontmatter.metadata
  if (frontmatter.name !== skill.directory || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`The packaged metadata for skill ${skillId} is unreadable.`)
  }
  const groups = parseSkillToolGroups((metadata as Record<string, unknown>).toolGroups)
  if (!['batshit_guide', 'goon_guide'].includes(skillId) && groups.length === 0) {
    throw new Error(`The operational skill ${skillId} has no packaged toolGroups declaration.`)
  }
  return groups
}

/** Works beside source services and compiled server/chunks output. */
export function getBundledBatshitPluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'system-plugins', BUNDLED_BATSHIT_PLUGIN_ID)
}

export function getBuiltinSystemSkillsRoot(): string {
  return path.join(getBundledBatshitPluginRoot(), 'skills')
}

/**
 * Returns the canonical path even if its files are missing. A known built-in
 * must fail visibly in that case, rather than loading an obsolete source_ref.
 */
export function resolveBuiltinSystemSkillDirectory(value: string): string | null {
  const identity = value.trim().replace(/^\//, '').replace(/^batshit:/, '')
  const entry = BUILTIN_PLUGIN_SKILLS.find((skill) =>
    [skill.commandId, skill.skillId, skill.directory, skill.legacyDirectory, skill.legacyDirectory.replace(/-/g, '_')]
      .some((alias) => alias === identity)
  )
  return entry ? path.join(getBuiltinSystemSkillsRoot(), entry.directory) : null
}
