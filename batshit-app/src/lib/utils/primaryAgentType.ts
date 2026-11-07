import { namesRetiredCodexCliModel } from './cliRuntimeIdentity'

/**
 * The live Primary Agent type. SA-139 R4 (D14): `cli` (the Claude Code CLI lane, and the Codex
 * CLI lane R1 removed) and `n8n` (SA-106) are kept only as stored retirement markers, so a stored
 * record is recognised and refused, never run, and never silently read as `api`.
 */
export type PrimaryAgentType = 'api'
export type RetiredPrimaryAgentType = 'cli' | 'n8n'
export type StoredPrimaryAgentType = PrimaryAgentType | RetiredPrimaryAgentType

type PrimaryModelConnectionLike =
  | {
      id?: string | null
      service?: string | null
    }
  | null
  | undefined

export type PrimaryAgentLike = {
  agentType?: string | null
  agent_type?: string | null
  batshitMode?: string | null
  batshit_mode?: string | null
  mode?: string | null
  primary_model_provider?: string | null
  primary_model_name?: string | null
  primary_model_connection?: PrimaryModelConnectionLike
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeModeToken(value: unknown): string {
  return normalizeString(value).replace(/[^a-z0-9]/g, '')
}

function hasCliProviderHint(agent?: PrimaryAgentLike | null): boolean {
  const provider = normalizeString(agent?.primary_model_provider)
  const model = normalizeString(agent?.primary_model_name)
  const connectionId = normalizeString(agent?.primary_model_connection?.id)
  const connectionService = normalizeString(agent?.primary_model_connection?.service)

  // SA-139 R1: a model id that merely contains "codex" (an OpenAI model on an API agent) is
  // not a CLI hint; only the provider or connection names the retired Codex CLI lane, and such
  // a record resolves to `cli` so the send path refuses it as retired Codex. SA-139 R3 (Faye
  // S12): by the exact retired ids only, so a custom provider such as `codex-proxy` stays `api`.
  // SA-139 R4: an untyped legacy record that names the Claude Code CLI lane still derives `cli`,
  // the retired type, so it is refused and never runs on the API lane under a `claude-cli` id.
  return (
    namesRetiredCodexCliModel(agent ?? {}) ||
    provider.includes('claude-cli') ||
    model.includes('claude-cli') ||
    connectionId.includes('claude-cli') ||
    connectionService.includes('claude-cli')
  )
}

export function normalizePrimaryAgentType(
  agent?: PrimaryAgentLike | null,
  explicitType?: unknown
): StoredPrimaryAgentType {
  const normalizedExplicit = normalizeString(explicitType)
  if (normalizedExplicit === 'n8n' || normalizedExplicit === 'api' || normalizedExplicit === 'cli') {
    return normalizedExplicit
  }

  const rawType = normalizeString(agent?.agentType ?? agent?.agent_type)
  if (rawType === 'n8n' || rawType === 'api' || rawType === 'cli') {
    return rawType
  }

  const legacyBatshitMode = normalizeString(agent?.batshitMode ?? agent?.batshit_mode)
  if (legacyBatshitMode === 'cli') return 'cli'
  if (legacyBatshitMode === 'direct') return 'api'

  const legacyMode = normalizeModeToken(agent?.mode)
  if (legacyMode === 'vercelnative') {
    return hasCliProviderHint(agent) ? 'cli' : 'api'
  }
  if (legacyMode === 'n8nnative' || legacyMode === 'batshitenhanced') {
    return 'n8n'
  }

  if (rawType === 'batshit') {
    return hasCliProviderHint(agent) ? 'cli' : 'api'
  }

  if (hasCliProviderHint(agent)) {
    return 'cli'
  }

  // SA-106 DL-106-02: an unrecognised record must resolve to a LIVE type, never to the
  // retired lane. Records that genuinely name n8n (explicitly, or through the legacy
  // `n8n-native` / `batshit-enhanced` modes above) still return `'n8n'` so the send guard
  // can reject them loudly; only this catch-all changed.
  return 'api'
}

export function isN8nPrimaryAgentType(value: unknown): value is 'n8n' {
  return normalizeString(value) === 'n8n'
}

export function isApiPrimaryAgentType(value: unknown): value is 'api' {
  return normalizeString(value) === 'api'
}

export function isCliPrimaryAgentType(value: unknown): value is 'cli' {
  return normalizeString(value) === 'cli'
}

export function isRetiredPrimaryAgentType(value: unknown): value is RetiredPrimaryAgentType {
  return isCliPrimaryAgentType(value) || isN8nPrimaryAgentType(value)
}

/** SA-139 R4 (D14): the one code every refusal of a retired Primary type carries (HTTP 409). */
export const PRIMARY_AGENT_TYPE_RETIRED_CODE = 'primary_agent_type_retired'

export type RetiredPrimaryAgentRefusal = {
  code: typeof PRIMARY_AGENT_TYPE_RETIRED_CODE
  error: string
  details: string
}

/** The readable sentence for a retired Primary type; a CLI record that names Codex gets the Codex one. */
export function retiredPrimaryAgentTypeMessage(
  type: RetiredPrimaryAgentType,
  options: { codex?: boolean } = {}
): { error: string; details: string } {
  if (type === 'n8n') {
    return {
      error: 'The n8n Primary Agent type was removed from Batshit.',
      details:
        'This agent uses the retired n8n Primary Agent type, so it can only be deleted. Create a new agent instead. n8n is still fully supported as a tool platform: n8n tool workflows are unchanged.',
    }
  }
  if (options.codex) {
    return {
      error: 'Codex CLI agents were removed from Batshit.',
      details:
        'This agent ran on Codex CLI, which Batshit no longer supports, so it can only be deleted. For ChatGPT models, create a new agent with the ChatGPT plan connection or an OpenAI API key.',
    }
  }
  return {
    error: 'The Claude Code CLI lane was removed from Batshit.',
    details:
      'This agent ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new agent and pick a Claude plan model.',
  }
}

/**
 * SA-139 R4 (D14 narrow refusal): null for a live Primary, else the readable refusal. Both the
 * stored record and a requested type are checked, so a request cannot override its way past a
 * retired record, and a request cannot ask for a retired type on a live one.
 */
export function retiredPrimaryAgentRefusal(
  agent?: PrimaryAgentLike | null,
  requestedType?: unknown
): RetiredPrimaryAgentRefusal | null {
  const stored = normalizePrimaryAgentType(agent)
  const requested = requestedType === undefined ? stored : normalizePrimaryAgentType(agent, requestedType)
  const type = isRetiredPrimaryAgentType(stored) ? stored : isRetiredPrimaryAgentType(requested) ? requested : null
  if (!type) return null
  return {
    code: PRIMARY_AGENT_TYPE_RETIRED_CODE,
    ...retiredPrimaryAgentTypeMessage(type, { codex: type === 'cli' && namesRetiredCodexCliModel(agent ?? {}) }),
  }
}

export function primaryAgentAllowsNativeBash(value: unknown): boolean {
  return isApiPrimaryAgentType(value)
}

export function primaryAgentAllowsAgentBrowser(value: unknown): boolean {
  return isApiPrimaryAgentType(value)
}

export function getPrimaryAgentSystemPromptRedisKey(type: PrimaryAgentType): string {
  switch (type) {
    case 'api':
      return 'batshit:batshit_mode3_system_prompt'
  }
}

export function getPrimaryAgentSystemPromptLabel(type: PrimaryAgentType): string {
  switch (type) {
    case 'api':
      return 'PRIMARY AGENT SYSTEM PROMPT'
  }
}

export function shouldShowReasoningByDefaultForPrimaryAgent(value: unknown): boolean {
  return !isN8nPrimaryAgentType(value)
}

export function hasLegacyPrimaryAgentFields(agent: Record<string, any> | null | undefined): boolean {
  if (!agent || typeof agent !== 'object') return false

  return (
    'batshitMode' in agent ||
    'batshit_mode' in agent ||
    'n8nImplementation' in agent ||
    'mode' in agent ||
    normalizeString(agent.agentType) === 'batshit' ||
    normalizeString(agent.agentType) === 'vercel-native' ||
    normalizeString(agent.agent_type) === 'batshit'
  )
}

/** The legacy type fields a canonical agent record never keeps (`agentType` replaces them). */
export const LEGACY_PRIMARY_AGENT_FIELDS = [
  'agent_type',
  'batshitMode',
  'batshit_mode',
  'n8nImplementation',
  'mode'
] as const

/** The stored fields `normalizePrimaryAgentType` reads (BL-768: `updateAgent` reads only these). */
export const PRIMARY_AGENT_TYPE_SOURCE_FIELDS = [
  'agentType',
  'agent_type',
  'batshitMode',
  'batshit_mode',
  'mode',
  'primary_model_provider',
  'primary_model_name',
  'primary_model_connection'
] as const

export function canonicalizePrimaryAgentRecord<T extends Record<string, any>>(agent: T): T & {
  agentType: StoredPrimaryAgentType
} {
  const next = { ...agent } as Record<string, any>
  next.agentType = normalizePrimaryAgentType(next)

  for (const field of LEGACY_PRIMARY_AGENT_FIELDS) delete next[field]

  return next as T & { agentType: StoredPrimaryAgentType }
}
