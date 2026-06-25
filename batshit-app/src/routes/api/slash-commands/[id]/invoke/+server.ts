import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import { evaluateSkillDependencies, getSkill } from '$lib/server/services/skillRegistry'
import {
  bootstrapSystemSlashCommands,
  expectedSystemSkillIdForCommand
} from '$lib/server/services/systemSlashCommands'
import type { SlashCommandRow } from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { isArtifactSkillId } from '$lib/utils/skillDetection'

interface InvocationBody {
  rawArgs?: string
  args?: Record<string, unknown>
  agentId?: string | null
  sessionId?: string | null
}

function normalizeEnabledAgentIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const normalized = input
    .map((value) => sanitizeId(String(value ?? '').trim()))
    .filter((value) => value.length > 0)
  return Array.from(new Set(normalized))
}

function resolveAgentId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const normalized = sanitizeId(input.trim())
  return normalized.length > 0 ? normalized : null
}

function validateAgentAccess(command: SlashCommandRow, agentId: string | null) {
  if (command.enabled_for_all_agents === true) {
    if (!agentId) {
      return {
        error: 'Agent context is required to invoke this command.',
        status: 400
      }
    }
    return null
  }

  if (!Object.prototype.hasOwnProperty.call(command, 'enabled_agent_ids')) {
    return null
  }

  const enabledAgentIds = normalizeEnabledAgentIds(command.enabled_agent_ids)
  if (enabledAgentIds.length === 0) {
    return {
      error: 'This command is not enabled for any agents.',
      status: 403
    }
  }

  if (!agentId) {
    return {
      error: 'Agent context is required to invoke this command.',
      status: 400
    }
  }

  if (!enabledAgentIds.includes(agentId)) {
    return {
      error: 'This command is not enabled for the active agent.',
      status: 403
    }
  }

  return null
}

function parseArgumentTokens(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let escape = false

  for (const char of raw) {
    if (escape) {
      current += char
      escape = false
      continue
    }

    if (char === '\\') {
      escape = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current.length > 0) {
    tokens.push(current)
  }

  return tokens
}

function parseArgs(command: SlashCommandRow, body: InvocationBody) {
  const rawArgs = typeof body.rawArgs === 'string' ? body.rawArgs.trim() : ''
  const explicitArgs = body.args && typeof body.args === 'object' ? body.args : {}

  const parsedArgs: Record<string, unknown> = {}
  const providedKeys = new Set<string>()

  for (const [key, value] of Object.entries(explicitArgs)) {
    parsedArgs[key] = value
    providedKeys.add(key)
  }

  if (rawArgs.startsWith('{') && rawArgs.endsWith('}')) {
    try {
      const parsedJson = JSON.parse(rawArgs) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsedJson)) {
        parsedArgs[key] = value
        providedKeys.add(key)
      }
      return { parsedArgs, providedKeys, rawArgs }
    } catch {
      // Fall through to token parsing for non-JSON text.
    }
  }

  const tokens = parseArgumentTokens(rawArgs)
  const positional: string[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue

    const eqIndex = token.indexOf('=')
    if (eqIndex > 0) {
      const key = token.slice(0, eqIndex).trim()
      const value = token.slice(eqIndex + 1)
      if (key) {
        parsedArgs[key] = value
        providedKeys.add(key)
        continue
      }
    }

    if (token.startsWith('--')) {
      const key = token.slice(2).trim()
      if (!key) continue
      const maybeValue = tokens[i + 1]
      if (maybeValue && !maybeValue.startsWith('--') && !maybeValue.includes('=')) {
        parsedArgs[key] = maybeValue
        providedKeys.add(key)
        i += 1
      } else {
        parsedArgs[key] = true
        providedKeys.add(key)
      }
      continue
    }

    positional.push(token)
  }

  const params = command.parameters ?? []
  for (const parameter of params) {
    if (providedKeys.has(parameter.name)) continue
    if (positional.length === 0) break
    parsedArgs[parameter.name] = positional.shift()
    providedKeys.add(parameter.name)
  }

  if (positional.length > 0) {
    parsedArgs._rest = positional.join(' ')
  }

  return { parsedArgs, providedKeys, rawArgs }
}

function applyTemplate(template: string, args: Record<string, unknown>, parameters: SlashCommandRow['parameters']) {
  let output = template
  const unresolvedRequired: string[] = []

  for (const parameter of parameters ?? []) {
    const value = args[parameter.name]
    const resolved = value ?? parameter.default

    if (resolved === undefined || resolved === null || resolved === '') {
      if (parameter.required) {
        unresolvedRequired.push(parameter.name)
      }
      continue
    }

    const pattern = new RegExp(`\\{\\{\\s*${parameter.name}\\s*\\}\\}`, 'g')
    output = output.replace(pattern, String(resolved))
  }

  return { output, unresolvedRequired }
}

function buildPromptExpansion(command: SlashCommandRow, args: Record<string, unknown>) {
  const template = (command.prompt_template ?? '').trim()
  if (!template) {
    return {
      ok: false,
      status: 400,
      error: `Prompt command '${command.name}' has no prompt template.`
    }
  }

  const { output, unresolvedRequired } = applyTemplate(template, args, command.parameters)
  if (unresolvedRequired.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Missing required arguments: ${unresolvedRequired.join(', ')}`
    }
  }

  return {
    ok: true,
    expansion: output
  }
}

async function updateUsage(commandKey: string, command: SlashCommandRow) {
  const now = new Date().toISOString()
  const usageCount = (command.usage_count ?? 0) + 1
  await redis.json.set(commandKey, '$.usage_count', usageCount)
  await redis.json.set(commandKey, '$.last_used_at', now)
  await redis.json.set(commandKey, '$.updated_at', now)
  return { usageCount, lastUsedAt: now }
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json().catch(() => ({}))) as InvocationBody
    const commandKey = `slash_command:${locals.user.id}:${params.id}`
    let command = (await redis.json.get(commandKey)) as SlashCommandRow | null

    if (!command) {
      return json({ error: 'Slash command not found' }, { status: 404 })
    }

    if (command.is_active === false) {
      return json({ error: 'This command is currently inactive.' }, { status: 400 })
    }

    const agentId = resolveAgentId(body.agentId)
    const agentAccessError = validateAgentAccess(command, agentId)
    if (agentAccessError) {
      return json({ error: agentAccessError.error }, { status: agentAccessError.status })
    }

    const { parsedArgs, rawArgs } = parseArgs(command, body)

    if (command.type === 'prompt') {
      const promptResult = buildPromptExpansion(command, parsedArgs)
      if (!promptResult.ok) {
        return json({ error: promptResult.error }, { status: promptResult.status })
      }

      const usage = await updateUsage(commandKey, command)

      return json({
        expansion: promptResult.expansion,
        expansionKind: 'prompt_inline',
        command: {
          id: command.id,
          name: command.name,
          displayName: command.displayName,
          type: command.type
        },
        args: parsedArgs,
        rawArgs,
        usage
      })
    }

    if (command.type !== 'skill') {
      return json(
        { error: `Unsupported command type '${command.type}'. Only prompt and skill commands are allowed.` },
        { status: 400 }
      )
    }

    let skillId = command.skill_id
    if (!skillId) {
      return json({ error: 'Skill command is missing skill metadata.' }, { status: 400 })
    }

    let skill = await getSkill(locals.user.id, skillId)
    if (!skill && expectedSystemSkillIdForCommand(command.id)) {
      await bootstrapSystemSlashCommands(locals.user.id)
      const repairedCommand = (await redis.json.get(commandKey)) as SlashCommandRow | null
      if (repairedCommand) {
        command = repairedCommand
        skillId = command.skill_id
        if (skillId) {
          skill = await getSkill(locals.user.id, skillId)
        }
      }
    }

    if (!skill) {
      return json(
        {
          error: `Skill '${skillId}' is missing. Re-save this command or re-import the skill.`
        },
        { status: 404 }
      )
    }

    const skillIdLower = skill.id.toLowerCase()
    const commandIdLower = (command.id ?? '').toLowerCase()
    const dependenciesToCheck =
      isArtifactSkillId(skillIdLower) || isArtifactSkillId(commandIdLower)
        ? skill.dependencies ?? command.skill_dependencies ?? []
        : command.skill_dependencies ?? skill.dependencies ?? []

    const dependencyCheck = await evaluateSkillDependencies(locals.user.id, dependenciesToCheck)

    const warnings: string[] = []

    if (command.trust_level !== 'trusted') {
      warnings.push('This skill is marked untrusted. Review prompt/script content before enabling broad automation.')
    }

    if (command.has_scripts) {
      warnings.push('This skill includes script assets. Verify source and expected behavior before running commands.')
    }
    if (command.has_assets) {
      warnings.push('This skill includes assets. Verify attached files before execution.')
    }
    if (skill.standards_status === 'degraded') {
      warnings.push('Skill import is standards-degraded. Review spec warnings before use.')
    }
    for (const issue of skill.standards_issues ?? []) {
      warnings.push(`Spec warning: ${issue}`)
    }

    const missingRequired = dependencyCheck.statuses.filter((status) => status.required && !status.available)
    if (missingRequired.length > 0) {
      warnings.push(`Missing required integrations: ${missingRequired.map((entry) => entry.label).join(', ')}.`)
      if (isArtifactSkillId(skillIdLower) || skillIdLower.includes('artifact')) {
        warnings.push(
          'Fallback guidance: the unified /artifact-creator skill handles all artifact power sources and integration fallbacks.'
        )
      }
    }

    // Build a minimal skill-invocation marker. The detailed instructions about invoking
    // skills via native_skill live in the DCM's skills_commands_usage block
    // (see slashCommandCapabilities.ts) — NOT here. This keeps the user's chat message
    // clean while the agent's system context tells it exactly what to do with the marker.
    const skillName = skill.displayName || skill.name || skillId
    let expansion = `[Skill: ${skillName} | skillId=${skillId}]`

    // Append user's raw args so the agent sees the original request
    if (rawArgs) {
      expansion += `\n\n${rawArgs}`
    }

    // Include dependency warnings in the expansion so the agent is aware
    if (warnings.length > 0) {
      expansion += `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join('\n')}`
    }

    const usage = await updateUsage(commandKey, command)

    return json({
      expansion,
      expansionKind: 'prompt_inline',
      command: {
        id: command.id,
        name: command.name,
        displayName: command.displayName,
        type: command.type,
        skillId: skill.id,
        skillName
      },
      args: parsedArgs,
      rawArgs,
      dependencies: dependencyCheck.statuses,
      warnings: warnings.length > 0 ? warnings : undefined,
      usage
    })
  } catch (error) {
    console.error('Error invoking slash command:', error)
    return json({ error: 'Failed to invoke slash command' }, { status: 500 })
  }
}
