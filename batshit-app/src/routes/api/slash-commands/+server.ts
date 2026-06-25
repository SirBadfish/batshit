import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import { ensureSystemSlashCommands } from '$lib/server/services/systemSlashCommands'
import {
  getSkill,
  normalizeSkillId,
  upsertSkill
} from '$lib/server/services/skillRegistry'
import {
  DEFAULT_PROMPT_ICON_REF,
  DEFAULT_SKILL_ICON_REF
} from '$lib/icons/iconCatalog'
import { parseIconRef, type IconRef } from '$lib/icons/iconTypes'
import { normalizeOptionalIconRef } from '$lib/icons/iconLegacy'
import type { SlashCommandRow } from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'

function normalizeInvocation(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function sanitizeParameters(input: unknown): SlashCommandRow['parameters'] {
  if (!Array.isArray(input)) return []

  const validTypes = new Set(['string', 'number', 'boolean', 'array', 'object'])
  const result: NonNullable<SlashCommandRow['parameters']> = []

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const name = sanitizeId(String(raw.name ?? '').trim())
    if (!name) continue

    const type = String(raw.type ?? 'string')
    if (!validTypes.has(type)) continue

    result.push({
      name,
      type: type as 'string' | 'number' | 'boolean' | 'array' | 'object',
      description: typeof raw.description === 'string' ? raw.description.trim() : undefined,
      required: raw.required === true,
      default: raw.default,
      options: Array.isArray(raw.options) ? raw.options : undefined
    })
  }

  return result
}

function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const tags = input
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter((tag) => tag.length > 0)
  return Array.from(new Set(tags))
}

function sanitizeAgentIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const normalized = input
    .map((value) => sanitizeId(String(value ?? '').trim()))
    .filter((value) => value.length > 0)
  return Array.from(new Set(normalized))
}

function normalizeCommandType(input: unknown): SlashCommandRow['type'] | null {
  if (typeof input !== 'string') return 'prompt'
  const lowered = input.trim().toLowerCase()
  if (lowered === 'prompt' || lowered === 'skill') return lowered
  return null
}

function parseBoolean(input: unknown, fallback: boolean) {
  if (typeof input === 'boolean') return input
  return fallback
}

function resolveCommandIconRef(input: unknown, legacyInput: unknown, fallback: IconRef): IconRef {
  if (input !== undefined) {
    const parsed = parseIconRef(input)
    if (!parsed) {
      throw Object.assign(new Error('icon_ref must be a valid icon picker reference'), { status: 400 })
    }
    return parsed
  }

  return normalizeOptionalIconRef(legacyInput) ?? fallback
}

function buildSkillSynchronizedCommand(command: SlashCommandRow, skill: Awaited<ReturnType<typeof getSkill>>): SlashCommandRow {
  if (!skill || command.type !== 'skill') return command

  return {
    ...command,
    description: skill.description || '',
    instructions: '',
    category: 'skills',
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_license: skill.license,
    skill_compatibility: skill.compatibility,
    skill_metadata: skill.metadata ?? {},
    skill_allowed_tools: skill.allowed_tools ?? [],
    skill_standards_status: skill.standards_status,
    skill_standards_issues: skill.standards_issues ?? [],
    skill_bundle_manifest: skill.bundle_manifest,
    skill_bundle_files: undefined,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts === true,
    has_references: skill.has_references === true,
    has_assets: skill.has_assets === true
  }
}

function comparableSkillCommandMetadata(command: SlashCommandRow) {
  return {
    description: command.description || '',
    instructions: command.instructions || '',
    category: command.category || '',
    skill_source: command.skill_source,
    skill_source_ref: command.skill_source_ref,
    skill_summary: command.skill_summary,
    skill_dependencies: command.skill_dependencies ?? [],
    skill_license: command.skill_license,
    skill_compatibility: command.skill_compatibility,
    skill_metadata: command.skill_metadata ?? {},
    skill_allowed_tools: command.skill_allowed_tools ?? [],
    skill_standards_status: command.skill_standards_status,
    skill_standards_issues: command.skill_standards_issues ?? [],
    skill_bundle_manifest: command.skill_bundle_manifest,
    skill_bundle_files: command.skill_bundle_files ?? [],
    trust_level: command.trust_level,
    has_scripts: command.has_scripts === true,
    has_references: command.has_references === true,
    has_assets: command.has_assets === true
  }
}

// GET /api/slash-commands - List all slash commands for the current user
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await ensureSystemSlashCommands(locals.user.id)

    const pattern = `slash_command:${locals.user.id}:*`
    const keys = await redis.keys(pattern)

    const slashCommands: SlashCommandRow[] = []
    for (const key of keys) {
      let command = (await redis.json.get(key)) as SlashCommandRow | null
      if (!command) continue

      if (command.type === 'skill' && command.skill_id) {
        const skill = await getSkill(locals.user.id, command.skill_id).catch((error) => {
          console.warn('[slash-commands GET] Failed to refresh skill metadata for command:', command?.id, error)
          return null
        })

        if (skill) {
          const synchronized = buildSkillSynchronizedCommand(command, skill)
          if (
            JSON.stringify(comparableSkillCommandMetadata(command)) !==
            JSON.stringify(comparableSkillCommandMetadata(synchronized))
          ) {
            synchronized.updated_at = new Date().toISOString()
            await redis.json.set(key, '$', synchronized)
            command = synchronized
          }
        }
      }

      slashCommands.push(command)
    }

    slashCommands.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return json({ slashCommands })
  } catch (error) {
    console.error('Error getting slash commands:', error)
    return json({ error: 'Failed to get slash commands' }, { status: 500 })
  }
}

// POST /api/slash-commands - Create a new slash command
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json()) as Record<string, unknown>

    const rawName = typeof body.name === 'string' ? body.name.trim() : ''
    if (!rawName) {
      return json({ error: 'Command name is required' }, { status: 400 })
    }

    const commandId = sanitizeId(
      typeof body.id === 'string' && body.id.trim().length > 0 ? body.id : rawName
    )
    if (!commandId) {
      return json({ error: 'Unable to derive a valid command id' }, { status: 400 })
    }

    const exists = await redis.exists(`slash_command:${locals.user.id}:${commandId}`)
    if (exists) {
      return json(
        {
          error: `Slash command slug '${commandId}' is already taken. Choose another slug or delete/rename the original slash command.`
        },
        { status: 400 }
      )
    }

    const type = normalizeCommandType(body.type)
    if (!type) {
      return json({ error: 'Unsupported command type. Use Prompt command or Skill command.' }, { status: 400 })
    }

    const invocationPattern = normalizeInvocation(
      typeof body.invocation_pattern === 'string' ? body.invocation_pattern : `/${commandId}`
    )
    if (!/^\/[\w:-]+$/.test(invocationPattern)) {
      return json({ error: 'Invocation must start with / and use only letters, numbers, :, -, or _.' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const parameters = sanitizeParameters(body.parameters)
    const enabledAgentIds = sanitizeAgentIds(body.enabled_agent_ids)
    const enabledForAllAgents = body.enabled_for_all_agents === true

    let skillId: string | undefined
    let skillSummary: string | undefined
    let skillSource: SlashCommandRow['skill_source'] | undefined
    let skillSourceRef: string | undefined
    let skillDependencies: SlashCommandRow['skill_dependencies'] = []
    let skillLicense: string | undefined
    let skillCompatibility: string | undefined
    let skillMetadata: Record<string, string> | undefined
    let skillAllowedTools: string[] | undefined
    let skillStandardsStatus: SlashCommandRow['skill_standards_status'] | undefined
    let skillStandardsIssues: string[] | undefined
    let skillBundleManifest: SlashCommandRow['skill_bundle_manifest'] | undefined
    let skillBundleFiles: SlashCommandRow['skill_bundle_files'] | undefined
    let trustLevel: SlashCommandRow['trust_level'] | undefined
    let hasScripts: boolean | undefined
    let hasReferences: boolean | undefined
    let hasAssets: boolean | undefined

    if (type === 'skill') {
      const skillPayload = body.skill

      if (skillPayload && typeof skillPayload === 'object') {
        const payload = skillPayload as Record<string, unknown>
        const skillName = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : rawName
        const skill = await upsertSkill({
          userId: locals.user.id,
          commandId,
          nowIso: now,
          skill: {
            id: typeof payload.id === 'string' ? payload.id : undefined,
            name: skillName,
            displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
            description: typeof payload.description === 'string' ? payload.description : undefined,
            markdown: typeof payload.markdown === 'string' ? payload.markdown : undefined,
            source:
              typeof payload.source === 'string'
                ? (payload.source as SlashCommandRow['skill_source'])
                : 'custom',
            sourceRef: typeof payload.sourceRef === 'string' ? payload.sourceRef : undefined,
            dependencies: Array.isArray(payload.dependencies) ? payload.dependencies : [],
            license: typeof payload.license === 'string' ? payload.license : undefined,
            compatibility: typeof payload.compatibility === 'string' ? payload.compatibility : undefined,
            metadata:
              payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
                ? (payload.metadata as Record<string, string>)
                : undefined,
            allowedTools: Array.isArray(payload.allowedTools) ? payload.allowedTools : undefined,
            standardsStatus:
              payload.standardsStatus === 'full' || payload.standardsStatus === 'degraded'
                ? payload.standardsStatus
                : undefined,
            standardsIssues: Array.isArray(payload.standardsIssues) ? payload.standardsIssues : undefined,
            trustLevel:
              payload.trustLevel === 'trusted' || payload.trustLevel === 'untrusted'
                ? (payload.trustLevel as SlashCommandRow['trust_level'])
                : 'untrusted',
            hasScripts: payload.hasScripts === true,
            hasReferences: payload.hasReferences === true,
            hasAssets: payload.hasAssets === true,
            bundleManifest:
              payload.bundleManifest && typeof payload.bundleManifest === 'object'
                ? (payload.bundleManifest as SlashCommandRow['skill_bundle_manifest'])
                : undefined,
            bundleFiles: Array.isArray(payload.bundleFiles)
              ? (payload.bundleFiles as SlashCommandRow['skill_bundle_files'])
              : undefined,
            isSystem: body.is_system === true
          }
        })

        skillId = skill.id
        skillSummary = skill.description
        skillSource = skill.source
        skillSourceRef = skill.source_ref
        skillDependencies = skill.dependencies
        skillLicense = skill.license
        skillCompatibility = skill.compatibility
        skillMetadata = skill.metadata
        skillAllowedTools = skill.allowed_tools
        skillStandardsStatus = skill.standards_status
        skillStandardsIssues = skill.standards_issues
        skillBundleManifest = skill.bundle_manifest
        skillBundleFiles = undefined
        trustLevel = skill.trust_level
        hasScripts = skill.has_scripts
        hasReferences = skill.has_references
        hasAssets = skill.has_assets
      } else if (typeof body.skill_id === 'string' && body.skill_id.trim()) {
        const normalizedSkillId = normalizeSkillId(body.skill_id, rawName)
        const existingSkill = await getSkill(locals.user.id, normalizedSkillId)
        if (!existingSkill) {
          return json(
            {
              error: `Skill '${normalizedSkillId}' does not exist. Provide a skill definition or import a skill first.`
            },
            { status: 400 }
          )
        }

        skillId = existingSkill.id
        skillSummary = existingSkill.description
        skillSource = existingSkill.source
        skillSourceRef = existingSkill.source_ref
        skillDependencies = existingSkill.dependencies
        skillLicense = existingSkill.license
        skillCompatibility = existingSkill.compatibility
        skillMetadata = existingSkill.metadata
        skillAllowedTools = existingSkill.allowed_tools
        skillStandardsStatus = existingSkill.standards_status
        skillStandardsIssues = existingSkill.standards_issues
        skillBundleManifest = existingSkill.bundle_manifest
        skillBundleFiles = undefined
        trustLevel = existingSkill.trust_level
        hasScripts = existingSkill.has_scripts
        hasReferences = existingSkill.has_references
        hasAssets = existingSkill.has_assets
      } else {
        return json(
          {
            error: 'Skill commands require a skill definition (SKILL.md content) or an existing skill id.'
          },
          { status: 400 }
        )
      }
    }

    const slashCommand: SlashCommandRow = {
      id: commandId,
      user_id: locals.user.id,
      name: rawName,
      displayName: typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : rawName,
      description:
        type === 'skill'
          ? typeof body.description === 'string' && body.description.trim().length > 0
            ? body.description.trim()
            : skillSummary || ''
          : '',
      type,
      prompt_template:
        type === 'prompt' && typeof body.prompt_template === 'string'
          ? body.prompt_template
          : type === 'prompt'
            ? ''
            : undefined,
      instructions: '',
      parameters,
      skill_id: type === 'skill' ? skillId : undefined,
      skill_source: type === 'skill' ? skillSource : undefined,
      skill_source_ref: type === 'skill' ? skillSourceRef : undefined,
      skill_summary: type === 'skill' ? skillSummary : undefined,
      skill_dependencies: type === 'skill' ? skillDependencies : [],
      skill_license: type === 'skill' ? skillLicense : undefined,
      skill_compatibility: type === 'skill' ? skillCompatibility : undefined,
      skill_metadata: type === 'skill' ? skillMetadata : undefined,
      skill_allowed_tools: type === 'skill' ? skillAllowedTools : undefined,
      skill_standards_status: type === 'skill' ? skillStandardsStatus : undefined,
      skill_standards_issues: type === 'skill' ? skillStandardsIssues : undefined,
      skill_bundle_manifest: type === 'skill' ? skillBundleManifest : undefined,
      skill_bundle_files: type === 'skill' ? skillBundleFiles : undefined,
      trust_level: type === 'skill' ? trustLevel : undefined,
      has_scripts: type === 'skill' ? hasScripts : undefined,
      has_references: type === 'skill' ? hasReferences : undefined,
      has_assets: type === 'skill' ? hasAssets : undefined,
      invocation_pattern: invocationPattern,
      can_be_attached_to_agents: enabledForAllAgents || enabledAgentIds.length > 0,
      can_be_invoked_in_chat: parseBoolean(body.can_be_invoked_in_chat, true),
      enabled_for_all_agents: enabledForAllAgents,
      enabled_agent_ids: enabledAgentIds,
      category: type === 'skill' ? 'skills' : 'general',
      tags: sanitizeTags(body.tags),
      icon_ref: resolveCommandIconRef(
        body.icon_ref,
        body.icon,
        type === 'skill' ? DEFAULT_SKILL_ICON_REF : DEFAULT_PROMPT_ICON_REF
      ),
      icon: undefined,
      usage_count: 0,
      last_used_at: undefined,
      is_active: parseBoolean(body.is_active, true),
      is_system: parseBoolean(body.is_system, false),
      created_at: now,
      updated_at: now
    }

    await redis.json.set(`slash_command:${locals.user.id}:${commandId}`, '$', slashCommand)

    return json({ slashCommand })
  } catch (error) {
    console.error('Error creating slash command:', error)
    if (error && typeof error === 'object' && 'status' in error && (error as any).status === 400) {
      return json({ error: error instanceof Error ? error.message : 'Invalid slash command' }, { status: 400 })
    }
    return json({ error: 'Failed to create slash command' }, { status: 500 })
  }
}
