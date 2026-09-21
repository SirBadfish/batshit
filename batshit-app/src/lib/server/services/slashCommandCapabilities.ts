import { redis } from '$lib/server/redis'
import type { SlashCommandRow } from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { appendSkillsCommandsUsageLines } from '$lib/utils/skillsCommandsDcm'

export interface AgentSlashCapability {
  id: string
  name: string
  displayName: string
  type: 'prompt' | 'skill'
  invocation: string
  description?: string
  isSystem: boolean
  skillId?: string
}

function normalizeInvocation(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function sanitizeAgentIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const normalized = input
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0)
  return Array.from(new Set(normalized))
}

/**
 * THE per-agent access rule. The DCM's `skills_commands` list is built from it, and since BL-75
 * every skill LOAD (`native_skill` on every lane, through `resolveSkillAccessForActor`) is checked
 * against it too, so "listed" and "loadable" cannot disagree. Do not add another copy.
 */
export function commandEnabledForAgent(command: SlashCommandRow, agentId: string) {
  if (command.is_active === false) return false
  if (command.can_be_invoked_in_chat === false) return false
  if (command.enabled_for_all_agents === true) return true
  if (!Object.prototype.hasOwnProperty.call(command, 'enabled_agent_ids')) {
    return true
  }
  const enabledAgentIds = sanitizeAgentIds(command.enabled_agent_ids)
  if (enabledAgentIds.length === 0) return false
  return enabledAgentIds.includes(agentId)
}

export async function getEnabledAgentSlashCapabilities(userId: string, agentId: string): Promise<AgentSlashCapability[]> {
  return listSlashCapabilities(userId, (command) => commandEnabledForAgent(command, agentId))
}

/**
 * Who is asking to load a skill (BL-75). `agentId` is the id whose access list governs: the
 * Primary's own id on its turn; on a delegated run (`delegated: true`) the Subagent's record id
 * (the `{id}` of `subagent:{id}`), a `base` Worker's base id, or a built-in Worker's `worker_…`
 * id. `none` is a caller with no agent identity (the instance service token, a portable-skill
 * token): it can never load a skill, because no access list applies to it.
 */
export type SkillRuntimeActor =
  | { kind: 'agent'; agentId: string; delegated?: boolean }
  | { kind: 'none'; lane: string }

export type SkillAccessRefusalCode = 'SKILL_NOT_ENABLED' | 'SKILL_NOT_LISTED' | 'AGENT_IDENTITY_REQUIRED'

export type SkillAccessResult =
  | { ok: true; skillId: string; command: SlashCommandRow }
  | { ok: false; code: SkillAccessRefusalCode; skillId: string; message: string }

const SKILL_ACCESS_REFUSAL_CODES = new Set<string>([
  'SKILL_NOT_ENABLED',
  'SKILL_NOT_LISTED',
  'AGENT_IDENTITY_REQUIRED'
])

export function isSkillAccessRefusalCode(value: unknown): value is SkillAccessRefusalCode {
  return typeof value === 'string' && SKILL_ACCESS_REFUSAL_CODES.has(value)
}

/**
 * The one gate every skill load passes (BL-75). A skill loads only when a skill command that
 * points at it is enabled for the acting agent, by the same rule that builds the DCM list.
 * The returned `skillId` is the normalized id the caller must load, so the skill that loads is
 * always the one that passed.
 */
export async function resolveSkillAccessForActor(
  userId: string,
  requestedSkillId: string,
  actor: SkillRuntimeActor
): Promise<SkillAccessResult> {
  const skillId = sanitizeId(String(requestedSkillId ?? '').trim())

  if (actor.kind !== 'agent' || !actor.agentId.trim()) {
    return {
      ok: false,
      code: 'AGENT_IDENTITY_REQUIRED',
      skillId,
      message:
        'Skills load only for an agent, and this caller has no agent identity. ' +
        'Load the skill from an agent turn instead.'
    }
  }

  const commands = skillId
    ? (await loadSlashCommands(userId)).filter(
        (command) => command.type === 'skill' && command.skill_id === skillId
      )
    : []
  const noun = actor.delegated === true ? 'subagent' : 'agent'

  if (commands.length === 0) {
    return {
      ok: false,
      code: 'SKILL_NOT_LISTED',
      skillId,
      message:
        `No skill with id "${skillId || String(requestedSkillId ?? '')}" is set up on this instance, so it cannot be loaded. ` +
        `Load only a skill that is listed in your skills_commands. If the user wants another skill, ` +
        `tell them to add it and turn it on for you in Settings -> Skills & Prompts.`
    }
  }

  const enabled = commands.find((command) => commandEnabledForAgent(command, actor.agentId))
  if (!enabled) {
    const label = commands[0].displayName || commands[0].name || skillId
    return {
      ok: false,
      code: 'SKILL_NOT_ENABLED',
      skillId,
      message:
        `Skill "${label}" (${skillId}) is not enabled for this ${noun}, so it cannot be loaded. ` +
        `Ask the user to turn it on for you in Settings -> Agents -> Access, or for every agent with ` +
        `Enable For All Agents in Settings -> Skills & Prompts. Then try again.`
    }
  }

  return { ok: true, skillId, command: enabled }
}

/**
 * SA-120 P1: every active, chat-invocable command on the instance regardless of agent
 * assignment. The Jev Juice capability-gap catalog compares this against the agent's
 * own enabled list to find a skill the request needs that this agent cannot invoke.
 */
export async function listAllSlashCapabilities(userId: string): Promise<AgentSlashCapability[]> {
  return listSlashCapabilities(
    userId,
    (command) => command.is_active !== false && command.can_be_invoked_in_chat !== false
  )
}

async function loadSlashCommands(userId: string): Promise<SlashCommandRow[]> {
  const keys = await redis.keys(`slash_command:${userId}:*`)
  const commands: SlashCommandRow[] = []
  for (const key of keys) {
    const command = (await redis.json.get(key)) as SlashCommandRow | null
    if (command) commands.push(command)
  }
  return commands
}

async function listSlashCapabilities(
  userId: string,
  include: (command: SlashCommandRow) => boolean
): Promise<AgentSlashCapability[]> {
  const commands = await loadSlashCommands(userId)
  if (commands.length === 0) return []

  const capabilities: AgentSlashCapability[] = []

  for (const command of commands) {
    if (!include(command)) continue

    const invocation = normalizeInvocation(command.invocation_pattern || `/${command.id}`)
    if (!invocation) continue

    capabilities.push({
      id: command.id,
      name: command.name,
      displayName: command.displayName || command.name,
      type: command.type,
      invocation,
      description:
        command.type === 'skill'
          ? command.description || command.skill_summary || undefined
          : undefined,
      isSystem: command.is_system === true,
      skillId: command.skill_id
    })
  }

  capabilities.sort((a, b) => {
    if ((a.isSystem ? 1 : 0) !== (b.isSystem ? 1 : 0)) {
      return (b.isSystem ? 1 : 0) - (a.isSystem ? 1 : 0)
    }
    return a.displayName.localeCompare(b.displayName)
  })

  return capabilities
}

export function buildSkillsCommandsDcmLines(capabilities: AgentSlashCapability[]): string[] {
  const lines: string[] = []
  lines.push('skills_commands:')

  if (capabilities.length === 0) {
    lines.push('- (none enabled for this agent)')
  } else {
    const maxEntries = 16
    const visible = capabilities.slice(0, maxEntries)
    for (const capability of visible) {
      const typeLabel = capability.type === 'skill' ? 'skill' : 'prompt'
      const suffix = capability.type === 'skill' && capability.skillId ? ` | skillId=${capability.skillId}` : ''
      const summary = capability.description ? ` — ${capability.description}` : ''
      lines.push(`- ${capability.invocation} | ${typeLabel}${suffix}${summary}`)
    }
    if (capabilities.length > maxEntries) {
      lines.push(`- ...and ${capabilities.length - maxEntries} more`)
    }
  }

  appendSkillsCommandsUsageLines(lines)

  return lines
}
