import type { SlashCommandRow } from '$lib/types/database'

export function normalizeEnabledAgentIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const normalized = input
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0)
  return Array.from(new Set(normalized))
}

export function isSlashCommandEnabledForAgent(
  command: Pick<SlashCommandRow, 'enabled_for_all_agents' | 'enabled_agent_ids'>,
  agentId: string | null | undefined
): boolean {
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalizedAgentId) return true

  if (command.enabled_for_all_agents === true) {
    return true
  }

  // Legacy commands without per-agent metadata remain available.
  if (!Object.prototype.hasOwnProperty.call(command, 'enabled_agent_ids')) {
    return true
  }

  const enabledAgentIds = normalizeEnabledAgentIds(command.enabled_agent_ids)
  if (enabledAgentIds.length === 0) return false
  return enabledAgentIds.includes(normalizedAgentId)
}
