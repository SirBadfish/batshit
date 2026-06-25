import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import {
  deleteSkillIfOrphaned,
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

function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const tags = input
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter((tag) => tag.length > 0)
  return Array.from(new Set(tags))
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

function sanitizeAgentIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const normalized = input
    .map((value) => sanitizeId(String(value ?? '').trim()))
    .filter((value) => value.length > 0)
  return Array.from(new Set(normalized))
}

function normalizeCommandType(input: unknown): SlashCommandRow['type'] | null {
  if (typeof input !== 'string') return null
  const lowered = input.trim().toLowerCase()
  if (lowered === 'prompt' || lowered === 'skill') return lowered
  return null
}

function parseBoolean(input: unknown, fallback: boolean) {
  if (typeof input === 'boolean') return input
  return fallback
}

function resolveCommandIconRef(
  input: unknown,
  legacyInput: unknown,
  existing: SlashCommandRow,
  fallback: IconRef
): IconRef {
  if (input !== undefined) {
    const parsed = parseIconRef(input)
    if (!parsed) {
      throw Object.assign(new Error('icon_ref must be a valid icon picker reference'), { status: 400 })
    }
    return parsed
  }

  return normalizeOptionalIconRef(legacyInput) ?? existing.icon_ref ?? normalizeOptionalIconRef(existing.icon) ?? fallback
}

function normalizeTrustLevel(input: unknown): SlashCommandRow['trust_level'] | null {
  if (input === 'trusted' || input === 'untrusted') return input
  return null
}

const MUTABLE_SYSTEM_COMMAND_KEYS = new Set([
  'is_active',
  'enabled_for_all_agents',
  'enabled_agent_ids',
  'can_be_attached_to_agents',
  'icon_ref',
  'skill'
])

const MUTABLE_SYSTEM_SKILL_KEYS = new Set(['trustLevel'])

function getRestrictedSystemUpdateKeys(command: SlashCommandRow, updates: Record<string, unknown>): string[] {
  const restricted: string[] = []

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue

    if (key === 'id') {
      if (typeof value === 'string' && value === command.id) continue
      restricted.push(key)
      continue
    }

    if (key === 'type') {
      const requestedType = normalizeCommandType(value)
      if (requestedType && requestedType === command.type) continue
      restricted.push(key)
      continue
    }

    if (!MUTABLE_SYSTEM_COMMAND_KEYS.has(key)) {
      restricted.push(key)
      continue
    }

    if (key === 'skill') {
      if (command.type !== 'skill' || !value || typeof value !== 'object' || Array.isArray(value)) {
        restricted.push(key)
        continue
      }

      for (const nestedKey of Object.keys(value as Record<string, unknown>)) {
        if (!MUTABLE_SYSTEM_SKILL_KEYS.has(nestedKey)) {
          restricted.push(`skill.${nestedKey}`)
        }
      }
    }
  }

  return restricted
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

// GET /api/slash-commands/[id] - Get a specific slash command
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const key = `slash_command:${locals.user.id}:${params.id}`
    let command = (await redis.json.get(key)) as SlashCommandRow | null

    if (!command) {
      return json({ error: 'Slash command not found' }, { status: 404 })
    }

    if (command.type === 'skill' && command.skill_id) {
      const skill = await getSkill(locals.user.id, command.skill_id).catch((error) => {
        console.warn('[slash-commands/:id GET] Failed to refresh skill metadata for command:', command?.id, error)
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

    return json({ slashCommand: command })
  } catch (error) {
    console.error('Error getting slash command:', error)
    return json({ error: 'Failed to get slash command' }, { status: 500 })
  }
}

// PUT /api/slash-commands/[id] - Update a slash command
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const updates = (await request.json()) as Record<string, unknown>
    const commandKey = `slash_command:${locals.user.id}:${params.id}`

    const command = (await redis.json.get(commandKey)) as SlashCommandRow | null

    if (!command) {
      return json({ error: 'Slash command not found' }, { status: 404 })
    }
    const now = new Date().toISOString()

    const requestedType = normalizeCommandType(updates.type)
    if (updates.type !== undefined && !requestedType) {
      return json({ error: 'Unsupported command type. Use Prompt command or Skill command.' }, { status: 400 })
    }

    if (requestedType && requestedType !== command.type) {
      return json(
        {
          error: 'Command type cannot be changed after creation. Create a new command with the desired type.'
        },
        { status: 400 }
      )
    }

    const nextType = command.type

    let nextSkillId = command.skill_id
    let nextSkillSource = command.skill_source
    let nextSkillSourceRef = command.skill_source_ref
    let nextSkillSummary = command.skill_summary
    let nextSkillDependencies = command.skill_dependencies ?? []
    let nextSkillLicense = command.skill_license
    let nextSkillCompatibility = command.skill_compatibility
    let nextSkillMetadata = command.skill_metadata
    let nextSkillAllowedTools = command.skill_allowed_tools
    let nextSkillStandardsStatus = command.skill_standards_status
    let nextSkillStandardsIssues = command.skill_standards_issues
    let nextSkillBundleManifest = command.skill_bundle_manifest
    let nextSkillBundleFiles = command.skill_bundle_files
    let nextTrustLevel = command.trust_level
    let nextHasScripts = command.has_scripts
    let nextHasReferences = command.has_references
    let nextHasAssets = command.has_assets

    if (command.is_system) {
      const restrictedKeys = getRestrictedSystemUpdateKeys(command, updates)
      if (restrictedKeys.length > 0) {
        return json(
          {
            error:
              `Built-in Batshit skills only allow live updates for status and access settings. ` +
              `Update the repo source instead for: ${restrictedKeys.join(', ')}.`
          },
          { status: 403 }
        )
      }

      const requestedTrustLevel = normalizeTrustLevel(
        updates.skill && typeof updates.skill === 'object' && !Array.isArray(updates.skill)
          ? (updates.skill as Record<string, unknown>).trustLevel
          : undefined
      )

      if (requestedTrustLevel && nextType === 'skill' && command.skill_id) {
        const existingSkill = await getSkill(locals.user.id, command.skill_id)
        if (!existingSkill) {
          return json(
            {
              error: `Skill '${command.skill_id}' is missing. Re-bootstrap the built-in skills and try again.`
            },
            { status: 404 }
          )
        }

        const updatedSkill = await upsertSkill({
          userId: locals.user.id,
          commandId: command.id,
          nowIso: now,
          skill: {
            id: existingSkill.id,
            name: existingSkill.name,
            displayName: existingSkill.displayName,
            description: existingSkill.description,
            source: existingSkill.source,
            sourceRef: existingSkill.source_ref,
            dependencies: existingSkill.dependencies ?? [],
            license: existingSkill.license,
            compatibility: existingSkill.compatibility,
            metadata: existingSkill.metadata ?? {},
            allowedTools: existingSkill.allowed_tools ?? [],
            standardsStatus: existingSkill.standards_status,
            standardsIssues: existingSkill.standards_issues ?? [],
            trustLevel: requestedTrustLevel,
            hasScripts: existingSkill.has_scripts === true,
            hasReferences: existingSkill.has_references === true,
            hasAssets: existingSkill.has_assets === true,
            bundleManifest: existingSkill.bundle_manifest ?? undefined,
            isSystem: true,
            isActive: existingSkill.is_active !== false
          }
        })

        nextSkillId = updatedSkill.id
        nextSkillSource = updatedSkill.source
        nextSkillSourceRef = updatedSkill.source_ref
        nextSkillSummary = updatedSkill.description
        nextSkillDependencies = updatedSkill.dependencies ?? []
        nextSkillLicense = updatedSkill.license
        nextSkillCompatibility = updatedSkill.compatibility
        nextSkillMetadata = updatedSkill.metadata
        nextSkillAllowedTools = updatedSkill.allowed_tools
        nextSkillStandardsStatus = updatedSkill.standards_status
        nextSkillStandardsIssues = updatedSkill.standards_issues
        nextSkillBundleManifest = updatedSkill.bundle_manifest
        nextSkillBundleFiles = undefined
        nextTrustLevel = updatedSkill.trust_level
        nextHasScripts = updatedSkill.has_scripts
        nextHasReferences = updatedSkill.has_references
        nextHasAssets = updatedSkill.has_assets
      }
    }

    if (nextType === 'skill') {
      const skillPayload = updates.skill

      if (!command.is_system && skillPayload && typeof skillPayload === 'object') {
        const payload = skillPayload as Record<string, unknown>
        const skill = await upsertSkill({
          userId: locals.user.id,
          commandId: command.id,
          nowIso: now,
          skill: {
            id: typeof payload.id === 'string' ? payload.id : command.skill_id,
            name:
              typeof payload.name === 'string' && payload.name.trim()
                ? payload.name
                : typeof updates.name === 'string' && updates.name.trim()
                  ? updates.name
                  : command.name,
            displayName: typeof payload.displayName === 'string' ? payload.displayName : command.displayName,
            description: typeof payload.description === 'string' ? payload.description : command.skill_summary,
            markdown: typeof payload.markdown === 'string' ? payload.markdown : undefined,
            source:
              typeof payload.source === 'string'
                ? (payload.source as SlashCommandRow['skill_source'])
                : command.skill_source || 'custom',
            sourceRef: typeof payload.sourceRef === 'string' ? payload.sourceRef : command.skill_source_ref,
            dependencies:
              Array.isArray(payload.dependencies) ? payload.dependencies : (command.skill_dependencies ?? []),
            license:
              typeof payload.license === 'string' ? payload.license : command.skill_license,
            compatibility:
              typeof payload.compatibility === 'string'
                ? payload.compatibility
                : command.skill_compatibility,
            metadata:
              payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
                ? (payload.metadata as Record<string, string>)
                : command.skill_metadata,
            allowedTools:
              Array.isArray(payload.allowedTools)
                ? payload.allowedTools.map((value) => String(value))
                : command.skill_allowed_tools,
            standardsStatus:
              payload.standardsStatus === 'full' || payload.standardsStatus === 'degraded'
                ? payload.standardsStatus
                : command.skill_standards_status,
            standardsIssues:
              Array.isArray(payload.standardsIssues)
                ? payload.standardsIssues.map((issue) => String(issue))
                : command.skill_standards_issues,
            trustLevel:
              payload.trustLevel === 'trusted' || payload.trustLevel === 'untrusted'
                ? (payload.trustLevel as SlashCommandRow['trust_level'])
                : command.trust_level || 'untrusted',
            hasScripts:
              typeof payload.hasScripts === 'boolean'
                ? payload.hasScripts
                : command.has_scripts === true,
            hasReferences:
              typeof payload.hasReferences === 'boolean'
                ? payload.hasReferences
                : command.has_references === true,
            hasAssets:
              typeof payload.hasAssets === 'boolean'
                ? payload.hasAssets
                : command.has_assets === true,
            bundleManifest:
              payload.bundleManifest && typeof payload.bundleManifest === 'object'
                ? (payload.bundleManifest as SlashCommandRow['skill_bundle_manifest'])
                : command.skill_bundle_manifest,
            bundleFiles: Array.isArray(payload.bundleFiles)
              ? (payload.bundleFiles as SlashCommandRow['skill_bundle_files'])
              : command.skill_bundle_files,
            isSystem: false
          }
        })

        nextSkillId = skill.id
        nextSkillSource = skill.source
        nextSkillSourceRef = skill.source_ref
        nextSkillSummary = skill.description
        nextSkillDependencies = skill.dependencies ?? []
        nextSkillLicense = skill.license
        nextSkillCompatibility = skill.compatibility
        nextSkillMetadata = skill.metadata
        nextSkillAllowedTools = skill.allowed_tools
        nextSkillStandardsStatus = skill.standards_status
        nextSkillStandardsIssues = skill.standards_issues
        nextSkillBundleManifest = skill.bundle_manifest
        nextSkillBundleFiles = undefined
        nextTrustLevel = skill.trust_level
        nextHasScripts = skill.has_scripts
        nextHasReferences = skill.has_references
        nextHasAssets = skill.has_assets
      } else if (typeof updates.skill_id === 'string' && updates.skill_id.trim()) {
        const normalizedSkillId = normalizeSkillId(updates.skill_id, command.name)
        const existingSkill = await getSkill(locals.user.id, normalizedSkillId)
        if (!existingSkill) {
          return json({ error: `Skill '${normalizedSkillId}' does not exist.` }, { status: 400 })
        }

        nextSkillId = existingSkill.id
        nextSkillSource = existingSkill.source
        nextSkillSourceRef = existingSkill.source_ref
        nextSkillSummary = existingSkill.description
        nextSkillDependencies = existingSkill.dependencies ?? []
        nextSkillLicense = existingSkill.license
        nextSkillCompatibility = existingSkill.compatibility
        nextSkillMetadata = existingSkill.metadata
        nextSkillAllowedTools = existingSkill.allowed_tools
        nextSkillStandardsStatus = existingSkill.standards_status
        nextSkillStandardsIssues = existingSkill.standards_issues
        nextSkillBundleManifest = existingSkill.bundle_manifest
        nextSkillBundleFiles = undefined
        nextTrustLevel = existingSkill.trust_level
        nextHasScripts = existingSkill.has_scripts
        nextHasReferences = existingSkill.has_references
        nextHasAssets = existingSkill.has_assets
      } else if (!nextSkillId) {
        return json({ error: 'Skill commands require an attached skill definition.' }, { status: 400 })
      }
    }

    if (nextType === 'prompt') {
      nextSkillId = undefined
      nextSkillSource = undefined
      nextSkillSourceRef = undefined
      nextSkillSummary = undefined
      nextSkillDependencies = []
      nextSkillLicense = undefined
      nextSkillCompatibility = undefined
      nextSkillMetadata = undefined
      nextSkillAllowedTools = undefined
      nextSkillStandardsStatus = undefined
      nextSkillStandardsIssues = undefined
      nextSkillBundleManifest = undefined
      nextSkillBundleFiles = undefined
      nextTrustLevel = undefined
      nextHasScripts = undefined
      nextHasReferences = undefined
      nextHasAssets = undefined
    }

    if (nextType === 'skill') {
      nextSkillBundleFiles = undefined
    }

    const nextName =
      typeof updates.name === 'string' && updates.name.trim() ? updates.name.trim() : command.name
    const enabledAgentIds =
      updates.enabled_agent_ids !== undefined
        ? sanitizeAgentIds(updates.enabled_agent_ids)
        : Array.isArray(command.enabled_agent_ids)
          ? sanitizeAgentIds(command.enabled_agent_ids)
          : []
    const enabledForAllAgents =
      updates.enabled_for_all_agents !== undefined
        ? updates.enabled_for_all_agents === true
        : command.enabled_for_all_agents === true

    const invocationPattern =
      typeof updates.invocation_pattern === 'string'
        ? normalizeInvocation(updates.invocation_pattern)
        : command.invocation_pattern || normalizeInvocation(`/${command.id}`)

    if (!/^\/[\w:-]+$/.test(invocationPattern)) {
      return json({ error: 'Invocation must start with / and use only letters, numbers, :, -, or _.' }, { status: 400 })
    }

    const updatedCommand: SlashCommandRow = {
      ...command,
      type: nextType,
      name: nextName,
      displayName:
        typeof updates.displayName === 'string' && updates.displayName.trim()
          ? updates.displayName.trim()
          : command.displayName || nextName,
      description:
        nextType === 'skill'
          ? typeof updates.description === 'string'
            ? updates.description.trim()
            : command.description || nextSkillSummary || ''
          : '',
      prompt_template:
        nextType === 'prompt'
          ? typeof updates.prompt_template === 'string'
            ? updates.prompt_template
            : command.prompt_template || ''
          : undefined,
      instructions: '',
      parameters: updates.parameters !== undefined ? sanitizeParameters(updates.parameters) : command.parameters || [],
      skill_id: nextSkillId,
      skill_source: nextSkillSource,
      skill_source_ref: nextSkillSourceRef,
      skill_summary: nextSkillSummary,
      skill_dependencies: nextSkillDependencies,
      skill_license: nextSkillLicense,
      skill_compatibility: nextSkillCompatibility,
      skill_metadata: nextSkillMetadata,
      skill_allowed_tools: nextSkillAllowedTools,
      skill_standards_status: nextSkillStandardsStatus,
      skill_standards_issues: nextSkillStandardsIssues,
      skill_bundle_manifest: nextSkillBundleManifest,
      skill_bundle_files: nextSkillBundleFiles,
      trust_level: nextTrustLevel,
      has_scripts: nextHasScripts,
      has_references: nextHasReferences,
      has_assets: nextHasAssets,
      invocation_pattern: invocationPattern,
      can_be_attached_to_agents: enabledForAllAgents || enabledAgentIds.length > 0,
      can_be_invoked_in_chat:
        updates.can_be_invoked_in_chat !== undefined
          ? parseBoolean(updates.can_be_invoked_in_chat, true)
          : command.can_be_invoked_in_chat,
      enabled_for_all_agents: enabledForAllAgents,
      enabled_agent_ids: enabledAgentIds,
      category: nextType === 'skill' ? command.category || 'skills' : 'general',
      tags: updates.tags !== undefined ? sanitizeTags(updates.tags) : command.tags || [],
      icon_ref: resolveCommandIconRef(
        updates.icon_ref,
        updates.icon,
        command,
        nextType === 'skill' ? DEFAULT_SKILL_ICON_REF : DEFAULT_PROMPT_ICON_REF
      ),
      icon: undefined,
      usage_count:
        typeof updates.usage_count === 'number'
          ? Math.max(0, Math.floor(updates.usage_count))
          : command.usage_count,
      last_used_at:
        typeof updates.last_used_at === 'string' && updates.last_used_at.trim()
          ? updates.last_used_at
          : command.last_used_at,
      is_active:
        updates.is_active !== undefined ? parseBoolean(updates.is_active, true) : command.is_active,
      is_system: command.is_system === true,
      id: command.id,
      user_id: command.user_id,
      created_at: command.created_at,
      updated_at: now
    }

    await redis.json.set(commandKey, '$', updatedCommand)

    if (command.skill_id && command.skill_id !== updatedCommand.skill_id) {
      await deleteSkillIfOrphaned(locals.user.id, command.skill_id, command.id)
    }

    return json({ slashCommand: updatedCommand })
  } catch (error) {
    console.error('Error updating slash command:', error)
    if (error && typeof error === 'object' && 'status' in error && (error as any).status === 400) {
      return json({ error: error instanceof Error ? error.message : 'Invalid slash command update' }, { status: 400 })
    }
    return json({ error: 'Failed to update slash command' }, { status: 500 })
  }
}

// DELETE /api/slash-commands/[id] - Delete a slash command
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const commandKey = `slash_command:${locals.user.id}:${params.id}`
    const command = (await redis.json.get(commandKey)) as SlashCommandRow | null

    if (!command) {
      return json({ error: 'Slash command not found' }, { status: 404 })
    }

    if (command.is_system) {
      return json({ error: 'Cannot delete system commands' }, { status: 403 })
    }

    await redis.del(commandKey)

    if (command.skill_id) {
      await deleteSkillIfOrphaned(locals.user.id, command.skill_id, command.id)
    }

    return json({ success: true })
  } catch (error) {
    console.error('Error deleting slash command:', error)
    return json({ error: 'Failed to delete slash command' }, { status: 500 })
  }
}
