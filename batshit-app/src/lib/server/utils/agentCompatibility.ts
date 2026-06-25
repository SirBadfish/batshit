/**
 * Agent Compatibility Utilities - Story 6.8d
 * Filter subagents by compatibility with primary agent type
 *
 * SA-062:
 * - n8n primary agents -> n8n Subnode Subagents
 * - API primary agents -> n8n Workflow Subagents + API Subagents + CLI Subagents
 * - CLI primary agents -> n8n Workflow Subagents + API Subagents + CLI Subagents
 */

import type { SubagentRow } from '$lib/types/database'
import type { PrimaryAgentType } from '$lib/utils/primaryAgentType'
import {
  getCompatibleSubagentTypesForPrimaryAgent,
  isSubagentCompatibleWithPrimaryAgent,
  type SubagentType,
} from '$lib/utils/subagentType'

/**
 * Filter subagents by compatibility with primary agent type
 *
 * @param primaryAgentType - Type of primary agent ('n8n', 'api', or 'cli')
 * @param allSubagents - All subagents to filter
 * @returns Object with compatible and incompatible subagents
 */
export function getCompatibleSubagents(
  primaryAgentType: PrimaryAgentType,
  allSubagents: SubagentRow[]
): { compatible: SubagentRow[], incompatible: SubagentRow[] } {
  const compatibleSubagentTypes =
    getCompatibleSubagentTypesForPrimaryAgent(primaryAgentType)
  const compatible = allSubagents.filter(
    (subagent) => compatibleSubagentTypes.includes(
      (subagent.subagentType ?? 'n8n-subnode') as SubagentType
    )
  )

  const incompatible = allSubagents.filter(
    (subagent) => !compatible.includes(subagent)
  )

  return { compatible, incompatible }
}

/**
 * Validate that a subagent is compatible with an agent
 *
 * @param agentType - Type of primary agent ('n8n', 'api', or 'cli')
 * @param subagentType - Canonical subagent type
 * @returns true if compatible, false otherwise
 */
export function isSubagentCompatible(
  agentType: PrimaryAgentType,
  subagentType: SubagentType
): boolean {
  return isSubagentCompatibleWithPrimaryAgent(agentType, subagentType)
}
