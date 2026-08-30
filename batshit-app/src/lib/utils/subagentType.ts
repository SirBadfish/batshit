import type { PrimaryAgentLike, PrimaryAgentType } from '$lib/utils/primaryAgentType'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

export type SubagentType = 'n8n-subnode' | 'n8n-workflow' | 'api' | 'cli'

export type SubagentLike = {
  subagentType?: string | null
  subagent_type?: string | null
  workflowName?: string | null
  workflow_name?: string | null
  webhookUrl?: string | null
  webhook_url?: string | null
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function hasWorkflowTarget(subagent?: SubagentLike | null): boolean {
  return Boolean(
    normalizeString(subagent?.workflowName ?? subagent?.workflow_name) ||
      normalizeString(subagent?.webhookUrl ?? subagent?.webhook_url)
  )
}

export function normalizeSubagentType(
  subagent?: SubagentLike | null,
  explicitType?: unknown
): SubagentType {
  const normalizedExplicit = normalizeString(explicitType)
  if (
    normalizedExplicit === 'n8n-subnode' ||
    normalizedExplicit === 'n8n-workflow' ||
    normalizedExplicit === 'api' ||
    normalizedExplicit === 'cli'
  ) {
    return normalizedExplicit
  }

  const rawType = normalizeString(subagent?.subagentType ?? subagent?.subagent_type)
  if (
    rawType === 'n8n-subnode' ||
    rawType === 'n8n-workflow' ||
    rawType === 'api' ||
    rawType === 'cli'
  ) {
    return rawType
  }

  // SA-106: the legacy bare `'n8n'` alias still maps to the RETIRED subnode type so a
  // stored record stays recognisable and can be surfaced for deletion (DL-106-04). It is
  // deliberately not remapped to a live type.
  if (normalizedExplicit === 'n8n' || rawType === 'n8n') {
    return 'n8n-subnode'
  }

  if (
    normalizedExplicit === 'batshit' ||
    normalizedExplicit === 'mcp_agent' ||
    rawType === 'batshit' ||
    rawType === 'mcp_agent'
  ) {
    return 'n8n-workflow'
  }

  // SA-106 DL-106-02: a record carrying a workflow target is a Category 2
  // `n8n-workflow` subagent and keeps that resolution untouched. Everything else used to
  // fall through to the retired subnode type; an unrecognised record now resolves to a
  // LIVE type instead.
  return hasWorkflowTarget(subagent) ? 'n8n-workflow' : 'api'
}

export function isApiSubagentType(value: unknown): value is 'api' {
  return normalizeString(value) === 'api'
}

export function isCliSubagentType(value: unknown): value is 'cli' {
  return normalizeString(value) === 'cli'
}

export function isWorkflowBackedSubagentType(
  value: unknown
): value is 'n8n-workflow' {
  return normalizeString(value) === 'n8n-workflow'
}

export function isN8nSubnodeSubagentType(
  value: unknown
): value is 'n8n-subnode' {
  return normalizeString(value) === 'n8n-subnode'
}

export function getCompatibleSubagentTypesForPrimaryAgent(
  value: PrimaryAgentLike | PrimaryAgentType | null | undefined
): SubagentType[] {
  const type =
    typeof value === 'string'
      ? normalizePrimaryAgentType(undefined, value)
      : normalizePrimaryAgentType(value)

  switch (type) {
    case 'api':
      return ['n8n-workflow', 'api', 'cli']
    case 'cli':
      return ['n8n-workflow', 'api', 'cli']
    // SA-106: explicit rather than a `default:` catch-all. A retired n8n primary can only
    // ever have paired with subnode subagents, and saying so honestly beats silently
    // handing that list to an unrecognised type.
    case 'n8n':
      return ['n8n-subnode']
  }
}

export function isSubagentCompatibleWithPrimaryAgent(
  primaryAgent: PrimaryAgentLike | PrimaryAgentType | null | undefined,
  subagent: SubagentLike | SubagentType | null | undefined
): boolean {
  const compatibleTypes = getCompatibleSubagentTypesForPrimaryAgent(primaryAgent)
  const subagentType =
    typeof subagent === 'string'
      ? normalizeSubagentType(undefined, subagent)
      : normalizeSubagentType(subagent)
  return compatibleTypes.includes(subagentType)
}

export function getSubagentTypeDisplayLabel(type: SubagentType): string {
  switch (type) {
    case 'n8n-subnode':
      return 'n8n Subnode Subagent'
    case 'n8n-workflow':
      return 'n8n Workflow Subagent'
    case 'api':
      return 'API Subagent'
    case 'cli':
      return 'CLI Subagent'
    default:
      return 'Subagent'
  }
}

export function getSubagentTypeShortLabel(type: SubagentType): string {
  switch (type) {
    case 'n8n-subnode':
      return 'n8n subnode'
    case 'n8n-workflow':
      return 'n8n workflow'
    case 'api':
      return 'API'
    case 'cli':
      return 'CLI'
    default:
      return 'subagent'
  }
}

export function getSubagentTypeBadgeTone(type: SubagentType): 'n8n' | 'api' | 'cli' {
  if (type === 'api' || type === 'cli') return type
  return 'n8n'
}

export function canonicalizeSubagentRecord<T extends Record<string, any>>(
  subagent: T
): T & { subagentType: SubagentType } {
  const next = { ...subagent } as Record<string, any>
  next.subagentType = normalizeSubagentType(next)
  delete next.subagent_type
  return next as T & { subagentType: SubagentType }
}
