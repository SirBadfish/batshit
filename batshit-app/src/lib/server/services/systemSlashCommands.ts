import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { redis } from '$lib/server/redis'
import { upsertSkill } from '$lib/server/services/skillRegistry'
import {
  DEFAULT_ARTIFACT_ICON_REF,
  DEFAULT_CLI_TOOL_ICON_REF
} from '$lib/icons/iconCatalog'
import type { SlashCommandRow } from '$lib/types/database'

const ARTIFACT_SKILL_ALLOWED_TOOLS = [
  'native_batshit_tool_search',
  'native_batshit_tool_use',
  'native_skill'
]

const SPEECH_SETUP_ALLOWED_TOOLS = [
  'native_batshit_tool_search',
  'native_batshit_tool_use',
  'native_bash_execute',
  'native_skill'
]

const CLI_TOOLS_ALLOWED_TOOLS = [
  'native_batshit_tool_search',
  'native_batshit_tool_use',
  'native_bash_execute',
  'native_skill'
]

const SKILL_CREATOR_ALLOWED_TOOLS = [
  'native_batshit_tool_search',
  'native_batshit_tool_use',
  'native_skill'
]

const GOON_SCENE_CREATOR_ALLOWED_TOOLS = [
  'native_batshit_tool_search',
  'native_batshit_tool_use',
  'native_skill'
]

const BATSHIT_GUIDE_ALLOWED_TOOLS = [
  'native_batshit_tool_search',
  'native_batshit_tool_use',
  'native_skill'
]

const LEGACY_ARTIFACT_SKILL_IDS = [
  'artifacts-general',
  'artifacts-n8n-brain',
  'artifacts-huggingface-brain',
  'artifacts-comfyui-brain'
]

const LEGACY_SPEECH_SKILL_IDS = [
  'byo-speech-setup',
  'local-speech-setup'
]

const LEGACY_COMMAND_CREATOR_IDS = [
  'slash-command-creator'
]

const LEGACY_GOON_SCENE_CREATOR_IDS = [
  'batshit-goon-scene-creator'
]

const SKILL_CREATOR_COMMAND_ID = 'skill-creator'
const VOICE_ENGINE_INSTALLER_COMMAND_ID = 'voice-engine-installer'
const ARTIFACT_CREATOR_COMMAND_ID = 'artifact-creator'
const CLI_TOOL_CREATOR_COMMAND_ID = 'cli-tool-creator'
const GOON_SCENE_CREATOR_COMMAND_ID = 'goon-scene-creator'
const BATSHIT_GUIDE_COMMAND_ID = 'batshit-guide'

const SYSTEM_SKILL_IDS_BY_COMMAND_ID: Record<string, string> = {
  [SKILL_CREATOR_COMMAND_ID]: 'skill_creator',
  [VOICE_ENGINE_INSTALLER_COMMAND_ID]: 'voice_engine_installer',
  [ARTIFACT_CREATOR_COMMAND_ID]: 'artifact_creator',
  [CLI_TOOL_CREATOR_COMMAND_ID]: 'cli_tool_creator',
  [GOON_SCENE_CREATOR_COMMAND_ID]: 'goon_scene_creator',
  [BATSHIT_GUIDE_COMMAND_ID]: 'batshit_guide'
}

const LEGACY_VOICE_ENGINE_INSTALLER_IDS = ['speech-setup']
const LEGACY_ARTIFACT_CREATOR_IDS = ['artifacts']
const LEGACY_CLI_TOOL_CREATOR_IDS = ['cli-tools']

export const SYSTEM_SLASH_COMMAND_IDS = [
  SKILL_CREATOR_COMMAND_ID,
  VOICE_ENGINE_INSTALLER_COMMAND_ID,
  ARTIFACT_CREATOR_COMMAND_ID,
  CLI_TOOL_CREATOR_COMMAND_ID,
  GOON_SCENE_CREATOR_COMMAND_ID,
  BATSHIT_GUIDE_COMMAND_ID
] as const

export function expectedSystemSkillIdForCommand(commandId: string | null | undefined): string | null {
  const normalized = typeof commandId === 'string' ? commandId.trim() : ''
  return SYSTEM_SKILL_IDS_BY_COMMAND_ID[normalized] ?? null
}

function normalizeExistingAgentIds(existing?: SlashCommandRow | null): string[] {
  if (!existing || !Array.isArray(existing.enabled_agent_ids)) return []
  return Array.from(
    new Set(
      existing.enabled_agent_ids
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)
    )
  )
}

function deriveAttachableState(existing?: SlashCommandRow | null): {
  enabledForAllAgents: boolean
  enabledAgentIds: string[]
  canBeAttachedToAgents: boolean
} {
  const enabledAgentIds = normalizeExistingAgentIds(existing)
  const enabledForAllAgents = existing?.enabled_for_all_agents === true
  return {
    enabledForAllAgents,
    enabledAgentIds,
    canBeAttachedToAgents: enabledForAllAgents || enabledAgentIds.length > 0
  }
}

function pickExistingCommand(...candidates: Array<SlashCommandRow | null | undefined>): SlashCommandRow | null {
  return candidates.find((candidate): candidate is SlashCommandRow => Boolean(candidate)) ?? null
}

function resolveSystemSkillDir(skillId: string): string {
  const currentFile = fileURLToPath(import.meta.url)
  return join(dirname(currentFile), '..', 'system-skills', skillId)
}

function directoryHasFiles(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const fullPath = join(dirPath, entry.name)
    if (entry.isFile()) {
      return true
    }
    if (entry.isDirectory() && directoryHasFiles(fullPath)) {
      return true
    }
  }

  return false
}

function readSystemSkillContent(skillId: string): {
  markdown: string
  hasReferences: boolean
  hasAssets: boolean
} {
  const sourceDir = resolveSystemSkillDir(skillId)
  const skillMdPath = join(sourceDir, 'SKILL.md')

  if (!existsSync(skillMdPath)) {
    throw new Error(`System skill SKILL.md not found at ${skillMdPath}`)
  }

  const markdown = readFileSync(skillMdPath, 'utf-8')
  return {
    markdown,
    hasReferences: directoryHasFiles(join(sourceDir, 'references')),
    hasAssets: directoryHasFiles(join(sourceDir, 'assets'))
  }
}

function resolveUserSkillDir(skillId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  return join(home, '.batshit', 'skills', skillId)
}

function cleanupLegacyUserSkillDirs(skillIds: string[]): void {
  for (const skillId of skillIds) {
    const candidates = new Set<string>([skillId, skillId.replace(/-/g, '_')])

    for (const candidate of candidates) {
      const skillDir = resolveUserSkillDir(candidate)
      if (!existsSync(skillDir)) continue
      rmSync(skillDir, { recursive: true, force: true })
    }
  }
}

async function cleanupLegacyArtifactSkills(userId: string): Promise<void> {
  for (const legacyId of LEGACY_ARTIFACT_SKILL_IDS) {
    try {
      await redis.del(`skill:${userId}:${legacyId}`)
      await redis.del(`slash_command:${userId}:${legacyId}`)
    } catch {
      // Ignore cleanup errors for keys that don't exist.
    }
  }

  cleanupLegacyUserSkillDirs(LEGACY_ARTIFACT_SKILL_IDS)
}

async function cleanupLegacySpeechSkills(userId: string): Promise<void> {
  for (const legacyId of LEGACY_SPEECH_SKILL_IDS) {
    try {
      await redis.del(`skill:${userId}:${legacyId}`)
      await redis.del(`slash_command:${userId}:${legacyId}`)
    } catch {
      // Ignore cleanup errors for keys that don't exist.
    }
  }

  cleanupLegacyUserSkillDirs(LEGACY_SPEECH_SKILL_IDS)
}

async function cleanupLegacyCommandCreator(userId: string): Promise<void> {
  for (const legacyId of LEGACY_COMMAND_CREATOR_IDS) {
    try {
      await redis.del(`skill:${userId}:${legacyId}`)
      await redis.del(`slash_command:${userId}:${legacyId}`)
    } catch {
      // Ignore cleanup errors for keys that don't exist.
    }
  }

  cleanupLegacyUserSkillDirs(LEGACY_COMMAND_CREATOR_IDS)
}

async function cleanupLegacyGoonSceneCreator(userId: string): Promise<void> {
  for (const legacyId of LEGACY_GOON_SCENE_CREATOR_IDS) {
    try {
      await redis.del(`skill:${userId}:${legacyId}`)
      await redis.del(`slash_command:${userId}:${legacyId}`)
    } catch {
      // Ignore cleanup errors for keys that don't exist.
    }
  }

  cleanupLegacyUserSkillDirs(LEGACY_GOON_SCENE_CREATOR_IDS)
}

async function cleanupRenamedSystemSkillIds(userId: string, legacyIds: string[]): Promise<void> {
  for (const legacyId of legacyIds) {
    try {
      await redis.del(`skill:${userId}:${legacyId}`)
      await redis.del(`slash_command:${userId}:${legacyId}`)
    } catch {
      // Ignore cleanup errors for keys that don't exist.
    }
  }

  cleanupLegacyUserSkillDirs(legacyIds)
}

export async function buildSkillCreatorSkillCommand(
  userId: string,
  now: string,
  existing?: SlashCommandRow | null
): Promise<SlashCommandRow> {
  const sourceDir = resolveSystemSkillDir('skill-creator')
  const { markdown, hasReferences, hasAssets } = readSystemSkillContent('skill-creator')
  const accessState = deriveAttachableState(existing)

  const skill = await upsertSkill({
    userId,
    commandId: SKILL_CREATOR_COMMAND_ID,
    nowIso: now,
    skill: {
      id: SKILL_CREATOR_COMMAND_ID,
      name: SKILL_CREATOR_COMMAND_ID,
      displayName: 'Skill Creator',
      description: 'Create, update, and refine Batshit skills and prompts that work well with any AI model.',
      markdown,
      source: 'system',
      sourceRef: sourceDir,
      trustLevel: existing?.trust_level ?? 'trusted',
      isSystem: true,
      isActive: existing?.is_active ?? true,
      allowedTools: SKILL_CREATOR_ALLOWED_TOOLS,
      hasReferences,
      hasAssets
    }
  })

  cleanupLegacyUserSkillDirs(['skill-creator'])

  return {
    id: SKILL_CREATOR_COMMAND_ID,
    user_id: userId,
    name: SKILL_CREATOR_COMMAND_ID,
    displayName: 'Skill Creator',
    description: 'Create, update, and refine Batshit skills and prompts that work well with any AI model.',
    type: 'skill',
    instructions:
      'Help users create reusable skills and prompts for Batshit. Route to skill or prompt based on purpose (agent capability vs user text template), write clear LLM-friendly instructions, save through Fabric, and report back with enablement steps.',
    parameters: [],
    skill_id: skill.id,
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_allowed_tools: skill.allowed_tools ?? SKILL_CREATOR_ALLOWED_TOOLS,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts ?? false,
    has_references: skill.has_references ?? true,
    has_assets: skill.has_assets ?? false,
    invocation_pattern: '/skill-creator',
    can_be_attached_to_agents: accessState.canBeAttachedToAgents,
    can_be_invoked_in_chat: true,
    category: 'skills',
    tags: ['skills', 'prompts', 'creator', 'meta', 'authoring'],
    icon_ref: existing?.icon_ref ?? { kind: 'lucide', id: 'sparkles' },
    icon: undefined,
    usage_count: existing?.usage_count ?? 0,
    last_used_at: existing?.last_used_at,
    is_active: existing?.is_active ?? true,
    enabled_for_all_agents: accessState.enabledForAllAgents,
    enabled_agent_ids: accessState.enabledAgentIds,
    is_system: true,
    created_at: existing?.created_at ?? now,
    updated_at: now
  }
}

export async function buildSpeechSetupSkillCommand(
  userId: string,
  now: string,
  existing?: SlashCommandRow | null
): Promise<SlashCommandRow> {
  const sourceDir = resolveSystemSkillDir('speech-setup')
  const { markdown, hasReferences, hasAssets } = readSystemSkillContent('speech-setup')
  const accessState = deriveAttachableState(existing)

  const skill = await upsertSkill({
    userId,
    commandId: VOICE_ENGINE_INSTALLER_COMMAND_ID,
    nowIso: now,
    skill: {
      id: VOICE_ENGINE_INSTALLER_COMMAND_ID,
      name: VOICE_ENGINE_INSTALLER_COMMAND_ID,
      displayName: 'TTS/STT Engine Installer',
      description: 'Install, verify, and register Batshit TTS/STT speech engines through the Engine Manager.',
      markdown,
      source: 'system',
      sourceRef: sourceDir,
      trustLevel: existing?.trust_level ?? 'trusted',
      isSystem: true,
      isActive: existing?.is_active ?? true,
      allowedTools: SPEECH_SETUP_ALLOWED_TOOLS,
      hasReferences,
      hasAssets
    }
  })

  cleanupLegacyUserSkillDirs(['speech-setup'])

  return {
    id: VOICE_ENGINE_INSTALLER_COMMAND_ID,
    user_id: userId,
    name: VOICE_ENGINE_INSTALLER_COMMAND_ID,
    displayName: 'TTS/STT Engine Installer',
    description: 'Canonical TTS/STT speech-engine setup skill for Batshit: preflight, install/connect, verify, and register.',
    type: 'skill',
    instructions:
      'Use the canonical Batshit speech setup workflow: fingerprint the runtime, route to the right engine path, verify health, register through sys.voice.engine.*, and report exact next steps.',
    parameters: [],
    skill_id: skill.id,
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_allowed_tools: skill.allowed_tools ?? SPEECH_SETUP_ALLOWED_TOOLS,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts ?? false,
    has_references: skill.has_references ?? true,
    has_assets: skill.has_assets ?? false,
    invocation_pattern: '/voice-engine-installer',
    can_be_attached_to_agents: accessState.canBeAttachedToAgents,
    can_be_invoked_in_chat: true,
    category: 'voice',
    tags: ['voice', 'tts', 'stt', 'speech', 'engine-manager', 'setup'],
    icon_ref: existing?.icon_ref ?? { kind: 'lucide', id: 'audio-lines' },
    icon: undefined,
    usage_count: existing?.usage_count ?? 0,
    last_used_at: existing?.last_used_at,
    is_active: existing?.is_active ?? true,
    enabled_for_all_agents: accessState.enabledForAllAgents,
    enabled_agent_ids: accessState.enabledAgentIds,
    is_system: true,
    created_at: existing?.created_at ?? now,
    updated_at: now
  }
}

export async function buildCliToolsSkillCommand(
  userId: string,
  now: string,
  existing?: SlashCommandRow | null
): Promise<SlashCommandRow> {
  const sourceDir = resolveSystemSkillDir('cli-tools')
  const { markdown, hasReferences, hasAssets } = readSystemSkillContent('cli-tools')
  const accessState = deriveAttachableState(existing)

  const skill = await upsertSkill({
    userId,
    commandId: CLI_TOOL_CREATOR_COMMAND_ID,
    nowIso: now,
    skill: {
      id: CLI_TOOL_CREATOR_COMMAND_ID,
      name: CLI_TOOL_CREATOR_COMMAND_ID,
      displayName: 'CLI Tool Creator',
      description: 'Create, update, test, and review Batshit CLI tools with a light manifest-driven workflow.',
      markdown,
      source: 'system',
      sourceRef: sourceDir,
      trustLevel: existing?.trust_level ?? 'trusted',
      isSystem: true,
      isActive: existing?.is_active ?? true,
      allowedTools: CLI_TOOLS_ALLOWED_TOOLS,
      hasReferences,
      hasAssets
    }
  })

  cleanupLegacyUserSkillDirs(['cli-tools'])

  return {
    id: CLI_TOOL_CREATOR_COMMAND_ID,
    user_id: userId,
    name: CLI_TOOL_CREATOR_COMMAND_ID,
    displayName: 'CLI Tool Creator',
    description: 'Create, update, test, and review Batshit CLI tools through Fabric without hand-writing every manifest detail.',
    type: 'skill',
    instructions:
      'Use the light Batshit CLI-tool authoring workflow: inspect the CLI, infer a clean manifest, ask only the missing safety questions, save through sys.cli_tool.*, test, and report in plain language.',
    parameters: [],
    skill_id: skill.id,
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_allowed_tools: skill.allowed_tools ?? CLI_TOOLS_ALLOWED_TOOLS,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts ?? false,
    has_references: skill.has_references ?? false,
    has_assets: skill.has_assets ?? false,
    invocation_pattern: '/cli-tool-creator',
    can_be_attached_to_agents: accessState.canBeAttachedToAgents,
    can_be_invoked_in_chat: true,
    category: 'tools',
    tags: ['cli', 'tools', 'fabric', 'local', 'setup'],
    icon_ref: existing?.icon_ref ?? DEFAULT_CLI_TOOL_ICON_REF,
    icon: undefined,
    usage_count: existing?.usage_count ?? 0,
    last_used_at: existing?.last_used_at,
    is_active: existing?.is_active ?? true,
    enabled_for_all_agents: accessState.enabledForAllAgents,
    enabled_agent_ids: accessState.enabledAgentIds,
    is_system: true,
    created_at: existing?.created_at ?? now,
    updated_at: now
  }
}

export async function buildGoonSceneCreatorSkillCommand(
  userId: string,
  now: string,
  existing?: SlashCommandRow | null
): Promise<SlashCommandRow> {
  const sourceDir = resolveSystemSkillDir('goon-scene-creator')
  const { markdown, hasReferences, hasAssets } = readSystemSkillContent('goon-scene-creator')
  const accessState = deriveAttachableState(existing)

  const skill = await upsertSkill({
    userId,
    commandId: GOON_SCENE_CREATOR_COMMAND_ID,
    nowIso: now,
    skill: {
      id: GOON_SCENE_CREATOR_COMMAND_ID,
      name: GOON_SCENE_CREATOR_COMMAND_ID,
      displayName: 'Goon Scene Creator',
      description:
        'Plan and generate Batshit Goon scenes with Room Builder, scene placement, skyboxes, props, markers, and hardware-aware texture choices.',
      markdown,
      source: 'system',
      sourceRef: sourceDir,
      trustLevel: existing?.trust_level ?? 'trusted',
      isSystem: true,
      isActive: existing?.is_active ?? true,
      dependencies: [{ id: 'comfyui_mcp', label: 'ComfyUI MCP', required: false }],
      allowedTools: GOON_SCENE_CREATOR_ALLOWED_TOOLS,
      hasReferences,
      hasAssets
    }
  })

  cleanupLegacyUserSkillDirs(['goon-scene-creator'])

  return {
    id: GOON_SCENE_CREATOR_COMMAND_ID,
    user_id: userId,
    name: GOON_SCENE_CREATOR_COMMAND_ID,
    displayName: 'Goon Scene Creator',
    description:
      'Plan and generate Batshit Goon scenes with Room Builder, scene placement, skyboxes, props, markers, and hardware-aware texture choices.',
    type: 'skill',
    instructions:
      'Help users create Batshit Goon scenes with truthful current-scene constraints, hardware-aware 4K/8K skybox choices, Room Builder surfaces, Ground Level vs Elevated placement, props, and sit/lay markers. Use optional ComfyUI or image-generation tools only when discoverable.',
    parameters: [],
    skill_id: skill.id,
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_allowed_tools: skill.allowed_tools ?? GOON_SCENE_CREATOR_ALLOWED_TOOLS,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts ?? false,
    has_references: skill.has_references ?? true,
    has_assets: skill.has_assets ?? false,
    invocation_pattern: '/goon-scene-creator',
    can_be_attached_to_agents: accessState.canBeAttachedToAgents,
    can_be_invoked_in_chat: true,
    category: 'goons',
    tags: ['goons', 'scenes', 'room-builder', 'skybox', 'comfyui', 'textures'],
    icon_ref: existing?.icon_ref ?? { kind: 'batshit', id: 'scenes' },
    icon: undefined,
    usage_count: existing?.usage_count ?? 0,
    last_used_at: existing?.last_used_at,
    is_active: existing?.is_active ?? true,
    enabled_for_all_agents: accessState.enabledForAllAgents,
    enabled_agent_ids: accessState.enabledAgentIds,
    is_system: true,
    created_at: existing?.created_at ?? now,
    updated_at: now
  }
}

export async function buildBatshitGuideSkillCommand(
  userId: string,
  now: string,
  existing?: SlashCommandRow | null
): Promise<SlashCommandRow> {
  const sourceDir = resolveSystemSkillDir('batshit-guide')
  const { markdown, hasReferences, hasAssets } = readSystemSkillContent('batshit-guide')
  const accessState = deriveAttachableState(existing)

  const skill = await upsertSkill({
    userId,
    commandId: BATSHIT_GUIDE_COMMAND_ID,
    nowIso: now,
    skill: {
      id: BATSHIT_GUIDE_COMMAND_ID,
      name: BATSHIT_GUIDE_COMMAND_ID,
      displayName: 'Batshit Guide',
      description:
        'Answer questions about Batshit and guide users through its features using the official product docs as on-demand references.',
      markdown,
      source: 'system',
      sourceRef: sourceDir,
      trustLevel: existing?.trust_level ?? 'trusted',
      isSystem: true,
      isActive: existing?.is_active ?? true,
      allowedTools: BATSHIT_GUIDE_ALLOWED_TOOLS,
      hasReferences,
      hasAssets
    }
  })

  return {
    id: BATSHIT_GUIDE_COMMAND_ID,
    user_id: userId,
    name: BATSHIT_GUIDE_COMMAND_ID,
    displayName: 'Batshit Guide',
    description:
      'Answer questions about Batshit and guide users through its features using the official product docs as on-demand references.',
    type: 'skill',
    instructions:
      'In-product Batshit help: load the matching UserDocs reference before answering, relay documented steps faithfully, say plainly when the docs do not cover something, and route build/install work to the operational skills.',
    parameters: [],
    skill_id: skill.id,
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_allowed_tools: skill.allowed_tools ?? BATSHIT_GUIDE_ALLOWED_TOOLS,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts ?? false,
    has_references: skill.has_references ?? true,
    has_assets: skill.has_assets ?? false,
    invocation_pattern: '/batshit-guide',
    can_be_attached_to_agents: accessState.canBeAttachedToAgents,
    can_be_invoked_in_chat: true,
    category: 'help',
    tags: ['help', 'guide', 'docs', 'batshit', 'onboarding'],
    icon_ref: existing?.icon_ref ?? { kind: 'lucide', id: 'book-open' },
    icon: undefined,
    usage_count: existing?.usage_count ?? 0,
    last_used_at: existing?.last_used_at,
    is_active: existing?.is_active ?? true,
    enabled_for_all_agents: accessState.enabledForAllAgents,
    enabled_agent_ids: accessState.enabledAgentIds,
    is_system: true,
    created_at: existing?.created_at ?? now,
    updated_at: now
  }
}

export async function buildUnifiedArtifactSkillCommand(
  userId: string,
  now: string,
  existing?: SlashCommandRow | null
): Promise<SlashCommandRow> {
  const sourceDir = resolveSystemSkillDir('artifacts')
  const { markdown, hasReferences, hasAssets } = readSystemSkillContent('artifacts')
  const accessState = deriveAttachableState(existing)

  const skill = await upsertSkill({
    userId,
    commandId: ARTIFACT_CREATOR_COMMAND_ID,
    nowIso: now,
    skill: {
      id: ARTIFACT_CREATOR_COMMAND_ID,
      name: ARTIFACT_CREATOR_COMMAND_ID,
      displayName: 'Artifact Creator',
      description: 'Build, configure, and publish persistent mini-app artifacts in Batshit.',
      markdown,
      source: 'system',
      sourceRef: sourceDir,
      trustLevel: existing?.trust_level ?? 'trusted',
      isSystem: true,
      isActive: existing?.is_active ?? true,
      dependencies: [
        { id: 'n8n_mcp', label: 'n8n MCP', required: false },
        { id: 'huggingface', label: 'HuggingFace MCP', required: false }
      ],
      allowedTools: ARTIFACT_SKILL_ALLOWED_TOOLS,
      hasReferences,
      hasAssets
    }
  })

  cleanupLegacyUserSkillDirs(['artifacts'])

  return {
    id: ARTIFACT_CREATOR_COMMAND_ID,
    user_id: userId,
    name: ARTIFACT_CREATOR_COMMAND_ID,
    displayName: 'Artifact Creator',
    description: 'Build, configure, and publish persistent mini-app artifacts in Batshit.',
    type: 'skill',
    instructions:
      'Unified artifact builder: handles all artifact types including built-in AI, n8n workflows, HuggingFace, and ComfyUI integrations. Dependencies are optional.',
    parameters: [],
    skill_id: skill.id,
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_allowed_tools: skill.allowed_tools ?? ARTIFACT_SKILL_ALLOWED_TOOLS,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts ?? false,
    has_references: skill.has_references ?? true,
    has_assets: skill.has_assets ?? false,
    invocation_pattern: '/artifact-creator',
    can_be_attached_to_agents: accessState.canBeAttachedToAgents,
    can_be_invoked_in_chat: true,
    category: 'artifacts',
    tags: ['artifacts', 'builder', 'ui', 'fabric', 'n8n', 'huggingface', 'comfyui'],
    icon_ref: existing?.icon_ref ?? DEFAULT_ARTIFACT_ICON_REF,
    icon: undefined,
    usage_count: existing?.usage_count ?? 0,
    last_used_at: existing?.last_used_at,
    is_active: existing?.is_active ?? true,
    enabled_for_all_agents: accessState.enabledForAllAgents,
    enabled_agent_ids: accessState.enabledAgentIds,
    is_system: true,
    created_at: existing?.created_at ?? now,
    updated_at: now
  }
}

export async function bootstrapSystemSlashCommands(userId: string): Promise<{
  hadExisting: boolean
  slashCommands: string[]
}> {
  const now = new Date().toISOString()

  const skillCreatorId = SKILL_CREATOR_COMMAND_ID
  const skillCreatorKey = `slash_command:${userId}:${skillCreatorId}`
  const speechId = VOICE_ENGINE_INSTALLER_COMMAND_ID
  const speechKey = `slash_command:${userId}:${speechId}`
  const artifactId = ARTIFACT_CREATOR_COMMAND_ID
  const artifactKey = `slash_command:${userId}:${artifactId}`
  const cliToolsId = CLI_TOOL_CREATOR_COMMAND_ID
  const cliToolsKey = `slash_command:${userId}:${cliToolsId}`
  const goonSceneCreatorId = GOON_SCENE_CREATOR_COMMAND_ID
  const goonSceneCreatorKey = `slash_command:${userId}:${goonSceneCreatorId}`
  const batshitGuideId = BATSHIT_GUIDE_COMMAND_ID
  const batshitGuideKey = `slash_command:${userId}:${batshitGuideId}`
  const legacySpeechKey = `slash_command:${userId}:speech-setup`
  const legacyArtifactKey = `slash_command:${userId}:artifacts`
  const legacyCliToolsKey = `slash_command:${userId}:cli-tools`
  const legacyGoonSceneCreatorKey = `slash_command:${userId}:batshit-goon-scene-creator`

  const [
    existingSkillCreator,
    existingSpeech,
    existingArtifact,
    existingCliTools,
    existingGoonSceneCreator,
    existingBatshitGuide,
    legacySpeech,
    legacyArtifact,
    legacyCliTools,
    legacyGoonSceneCreator
  ] = await Promise.all([
    redis.json.get(skillCreatorKey),
    redis.json.get(speechKey),
    redis.json.get(artifactKey),
    redis.json.get(cliToolsKey),
    redis.json.get(goonSceneCreatorKey),
    redis.json.get(batshitGuideKey),
    redis.json.get(legacySpeechKey),
    redis.json.get(legacyArtifactKey),
    redis.json.get(legacyCliToolsKey),
    redis.json.get(legacyGoonSceneCreatorKey)
  ])

  const skillCreatorSeed = (existingSkillCreator as SlashCommandRow | null) ?? null
  const speechSeed = pickExistingCommand(
    (existingSpeech as SlashCommandRow | null) ?? null,
    (legacySpeech as SlashCommandRow | null) ?? null
  )
  const artifactSeed = pickExistingCommand(
    (existingArtifact as SlashCommandRow | null) ?? null,
    (legacyArtifact as SlashCommandRow | null) ?? null
  )
  const cliToolsSeed = pickExistingCommand(
    (existingCliTools as SlashCommandRow | null) ?? null,
    (legacyCliTools as SlashCommandRow | null) ?? null
  )
  const goonSceneCreatorSeed = pickExistingCommand(
    (existingGoonSceneCreator as SlashCommandRow | null) ?? null,
    (legacyGoonSceneCreator as SlashCommandRow | null) ?? null
  )
  const batshitGuideSeed = (existingBatshitGuide as SlashCommandRow | null) ?? null

  const skillCreatorCommand = await buildSkillCreatorSkillCommand(
    userId,
    now,
    skillCreatorSeed
  )
  const speechCommand = await buildSpeechSetupSkillCommand(
    userId,
    now,
    speechSeed
  )
  const artifactCommand = await buildUnifiedArtifactSkillCommand(
    userId,
    now,
    artifactSeed
  )
  const cliToolsCommand = await buildCliToolsSkillCommand(
    userId,
    now,
    cliToolsSeed
  )
  const goonSceneCreatorCommand = await buildGoonSceneCreatorSkillCommand(
    userId,
    now,
    goonSceneCreatorSeed
  )
  const batshitGuideCommand = await buildBatshitGuideSkillCommand(
    userId,
    now,
    batshitGuideSeed
  )

  await Promise.all([
    redis.json.set(skillCreatorKey, '$', skillCreatorCommand),
    redis.json.set(speechKey, '$', speechCommand),
    redis.json.set(artifactKey, '$', artifactCommand),
    redis.json.set(cliToolsKey, '$', cliToolsCommand),
    redis.json.set(goonSceneCreatorKey, '$', goonSceneCreatorCommand),
    redis.json.set(batshitGuideKey, '$', batshitGuideCommand)
  ])

  await cleanupLegacyArtifactSkills(userId)
  await cleanupLegacySpeechSkills(userId)
  await cleanupLegacyCommandCreator(userId)
  await cleanupLegacyGoonSceneCreator(userId)
  await cleanupRenamedSystemSkillIds(userId, LEGACY_VOICE_ENGINE_INSTALLER_IDS)
  await cleanupRenamedSystemSkillIds(userId, LEGACY_ARTIFACT_CREATOR_IDS)
  await cleanupRenamedSystemSkillIds(userId, LEGACY_CLI_TOOL_CREATOR_IDS)

  return {
    hadExisting: [
      existingSkillCreator,
      existingSpeech,
      existingArtifact,
      existingCliTools,
      existingGoonSceneCreator,
      existingBatshitGuide,
      legacySpeech,
      legacyArtifact,
      legacyCliTools,
      legacyGoonSceneCreator
    ].some((value) => Boolean(value)),
    slashCommands: [...SYSTEM_SLASH_COMMAND_IDS]
  }
}

export async function ensureSystemSlashCommands(userId: string): Promise<void> {
  const keys = SYSTEM_SLASH_COMMAND_IDS.map((commandId) => `slash_command:${userId}:${commandId}`)
  const legacyKeys = [
    `slash_command:${userId}:speech-setup`,
    `slash_command:${userId}:artifacts`,
    `slash_command:${userId}:cli-tools`,
    `slash_command:${userId}:batshit-goon-scene-creator`
  ]
  const [existing, legacyExisting] = await Promise.all([
    Promise.all(keys.map((key) => redis.json.get(key))),
    Promise.all(legacyKeys.map((key) => redis.json.get(key)))
  ])

  const commandsReady =
    existing.every((value, index) => {
      if (!value || typeof value !== 'object') return false
      const command = value as SlashCommandRow
      const expectedSkillId = expectedSystemSkillIdForCommand(SYSTEM_SLASH_COMMAND_IDS[index])
      return command.type === 'skill' && Boolean(expectedSkillId) && command.skill_id === expectedSkillId
    }) && legacyExisting.every((value) => !value)

  if (!commandsReady) {
    await bootstrapSystemSlashCommands(userId)
    return
  }

  const skillKeys = SYSTEM_SLASH_COMMAND_IDS.map((commandId) => {
    const skillId = expectedSystemSkillIdForCommand(commandId)
    return skillId ? `skill:${userId}:${skillId}` : null
  })

  const backingSkills = await Promise.all(
    skillKeys.map((key) => (key ? redis.json.get(key) : Promise.resolve(null)))
  )

  if (backingSkills.every((value) => Boolean(value))) {
    return
  }

  await bootstrapSystemSlashCommands(userId)
}
