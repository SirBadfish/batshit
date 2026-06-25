import { redis } from '$lib/server/redis'
import type { SlashCommandRow } from '$lib/types/database'
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

function commandEnabledForAgent(command: SlashCommandRow, agentId: string) {
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
  const keys = await redis.keys(`slash_command:${userId}:*`)
  if (keys.length === 0) return []

  const capabilities: AgentSlashCapability[] = []

  for (const key of keys) {
    const command = (await redis.json.get(key)) as SlashCommandRow | null
    if (!command) continue
    if (!commandEnabledForAgent(command, agentId)) continue

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
