import type {
  PrimaryAgentLike,
  PrimaryAgentType,
  StoredPrimaryAgentType
} from '$lib/utils/primaryAgentType'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { namesClaudeCliModel, namesRetiredCodexCliModel, subagentCliRuntimeCandidates } from '$lib/utils/cliRuntimeIdentity'

/** SA-139 R5 (D16): the one live Subagent type. It runs on any connection, the Claude plan included. */
export type SubagentType = 'api'

/**
 * The stored identities of removed Subagent types (D14). SA-139 R2 removed the n8n types
 * (SA-106's Subnode Subagent and the Workflow Subagent); SA-139 R5 removed the CLI Subagent
 * (Claude Code CLI, and Codex CLI before it in R1). They stay recognisable only so a leftover
 * record is refused by type: it never runs, is never assigned, edited or offered, and never
 * becomes a live type. No migration (Josh, decision 16). An n8n leftover is also hidden from
 * the lists; a CLI leftover stays listed so its Delete is reachable (the R4 Primary shape).
 */
export type RetiredSubagentType = 'cli' | 'n8n-workflow' | 'n8n-subnode'
export type StoredSubagentType = SubagentType | RetiredSubagentType

export type SubagentLike = {
  subagentType?: string | null
  subagent_type?: string | null
  /** A pre-typed record's lane (`claude_cli`). */
  type?: string | null
  workflowName?: string | null
  workflow_name?: string | null
  webhookUrl?: string | null
  webhook_url?: string | null
  primary_model_provider?: unknown
  primary_model_name?: unknown
  primary_model_connection?: unknown
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
): StoredSubagentType {
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

  // The legacy aliases of the removed n8n types keep resolving to a retired type, so a stored
  // record is refused by name instead of silently becoming a live Subagent (D14).
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

  // A typeless record that carries a workflow target was a Workflow Subagent; it stays retired.
  if (hasWorkflowTarget(subagent)) return 'n8n-workflow'
  // SA-139 R5: a typeless record that names a CLI lane (Claude Code CLI, or the Codex CLI R1
  // removed) was a CLI Subagent; it stays retired and never runs as an API Subagent (D14).
  if (hasCliLaneHint(subagent)) return 'cli'
  // Everything else resolves to the live type (SA-106 DL-106-02).
  return 'api'
}

function hasCliLaneHint(subagent?: SubagentLike | null): boolean {
  if (!subagent) return false
  return normalizeString(subagent.type) === 'claude_cli' || namesClaudeCliModel(subagent) || namesRetiredCodexCliModel(subagent)
}

export function isApiSubagentType(value: unknown): value is 'api' {
  return normalizeString(value) === 'api'
}

export function isCliSubagentType(value: unknown): value is 'cli' {
  return normalizeString(value) === 'cli'
}

/** A removed n8n Subagent type (R2): hidden from the lists as well as refused. */
export function isRetiredN8nSubagentType(value: unknown): value is 'n8n-workflow' | 'n8n-subnode' {
  const normalized = normalizeString(value)
  return normalized === 'n8n-workflow' || normalized === 'n8n-subnode'
}

/** A removed Subagent type (D14): never run, assigned, offered or edited; delete only. */
export function isRetiredSubagentType(value: unknown): value is RetiredSubagentType {
  return isRetiredN8nSubagentType(value) || isCliSubagentType(value)
}

/** SA-139 R2/R5 (D14): the one code every refusal of a retired Subagent type carries. */
export const SUBAGENT_TYPE_RETIRED_CODE = 'subagent_type_retired'

export type RetiredSubagentRefusal = {
  code: typeof SUBAGENT_TYPE_RETIRED_CODE
  error: string
  details: string
}

type RetiredSubagentRecord = SubagentLike & { displayName?: string | null; display_name?: string | null }

function subagentLabel(subagent?: RetiredSubagentRecord | null): string {
  const name = subagent?.displayName ?? subagent?.display_name
  return typeof name === 'string' && name.trim() ? name.trim() : 'This Subagent'
}

/** The readable sentences for a retired Subagent type; a CLI record that names Codex gets the Codex ones. */
/**
 * The readable sentences for a retired Subagent type; a CLI record that names Codex gets the Codex
 * ones. A stored leftover is told it can only be deleted; a REQUEST (`request: true`: a create, or
 * a save that asks for the type) is told the type is gone, since nothing of it exists yet.
 */
export function retiredSubagentTypeSentences(
  type: RetiredSubagentType,
  subagent?: RetiredSubagentRecord | null,
  options: { request?: boolean } = {}
): { error: string; details: string } {
  const label = subagentLabel(subagent)
  if (type !== 'cli') {
    return {
      error: 'The n8n Subagent types were removed from Batshit.',
      details: options.request
        ? 'Batshit no longer has the n8n Subagent types, so a Subagent cannot be created as one or changed to one. n8n workflows still work as tools.'
        : `${label} uses an n8n Subagent type that Batshit removed, so it does not run. n8n workflows still work as tools.`,
    }
  }
  if (subagentCliRuntimeCandidates(subagent ?? {}).codex) {
    return {
      error: 'Codex CLI Subagents were removed from Batshit.',
      details: options.request
        ? 'Batshit no longer has Codex CLI Subagents, so a Subagent cannot be created as one or changed to one. For ChatGPT models, use the ChatGPT plan connection or an OpenAI API key.'
        : `${label} ran on Codex CLI, which Batshit no longer supports, so it can only be deleted. For ChatGPT models, create a new Subagent with the ChatGPT plan connection or an OpenAI API key.`,
    }
  }
  return {
    error: 'Claude Code CLI Subagents were removed from Batshit.',
    details: options.request
      ? 'Batshit no longer has Claude Code CLI Subagents, so a Subagent cannot be created as one or changed to one. To use your Claude plan, pick a Claude plan model.'
      : `${label} ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.`,
  }
}

/** The one readable sentence for a record of a retired Subagent type (its stored type decides). */
export function retiredSubagentTypeMessage(subagent?: RetiredSubagentRecord | null): string {
  const type = normalizeSubagentType(subagent)
  return retiredSubagentTypeSentences(isRetiredSubagentType(type) ? type : 'n8n-workflow', subagent).details
}

/**
 * SA-139 R5 (D14 narrow refusal): null for a live Subagent, else the readable refusal. Both the
 * stored record and a requested type are checked, so a request cannot change its way past a
 * retired record, and a request cannot ask for a retired type on a live one.
 */
export function retiredSubagentRefusal(
  subagent?: RetiredSubagentRecord | null,
  requestedType?: unknown,
  options: { request?: boolean } = {}
): RetiredSubagentRefusal | null {
  const stored = normalizeSubagentType(subagent)
  const requested = requestedType === undefined ? stored : normalizeSubagentType(subagent, requestedType)
  if (isRetiredSubagentType(stored)) {
    return { code: SUBAGENT_TYPE_RETIRED_CODE, ...retiredSubagentTypeSentences(stored, subagent, options) }
  }
  if (isRetiredSubagentType(requested)) {
    return { code: SUBAGENT_TYPE_RETIRED_CODE, ...retiredSubagentTypeSentences(requested, subagent, { request: true }) }
  }
  return null
}

export function getCompatibleSubagentTypesForPrimaryAgent(
  value: PrimaryAgentLike | StoredPrimaryAgentType | null | undefined
): SubagentType[] {
  const type =
    typeof value === 'string'
      ? normalizePrimaryAgentType(undefined, value)
      : normalizePrimaryAgentType(value)

  // SA-139 R5: an API Primary takes the one live Subagent type; a retired Primary takes none.
  switch (type) {
    case 'api':
      return ['api']
    case 'cli':
    case 'n8n':
      return []
  }
}

export function isSubagentCompatibleWithPrimaryAgent(
  primaryAgent: PrimaryAgentLike | StoredPrimaryAgentType | null | undefined,
  subagent: SubagentLike | StoredSubagentType | null | undefined
): boolean {
  const subagentType =
    typeof subagent === 'string'
      ? normalizeSubagentType(undefined, subagent)
      : normalizeSubagentType(subagent)
  if (isRetiredSubagentType(subagentType)) return false
  return getCompatibleSubagentTypesForPrimaryAgent(primaryAgent).includes(subagentType)
}

export function canonicalizeSubagentRecord<T extends Record<string, any>>(
  subagent: T
): T & { subagentType: StoredSubagentType } {
  const next = { ...subagent } as Record<string, any>
  next.subagentType = normalizeSubagentType(next)
  delete next.subagent_type
  return next as T & { subagentType: StoredSubagentType }
}
