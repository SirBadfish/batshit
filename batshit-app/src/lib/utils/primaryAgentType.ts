/** Live Primary Agent types. `n8n` is retained only as a stored retirement marker. */
export type PrimaryAgentType = 'api' | 'cli'
export type StoredPrimaryAgentType = PrimaryAgentType | 'n8n'

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

  return (
    provider.includes('codex') ||
    provider.includes('claude-cli') ||
    model.includes('codex') ||
    model.includes('claude-cli') ||
    connectionId.includes('codex') ||
    connectionId.includes('claude-cli') ||
    connectionService.includes('codex') ||
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

export function isManagedPrimaryAgentType(
  value: unknown
): value is 'api' | 'cli' {
  return isApiPrimaryAgentType(value) || isCliPrimaryAgentType(value)
}

export function primaryAgentAllowsNativeBash(value: unknown): boolean {
  return isApiPrimaryAgentType(value)
}

export function primaryAgentAllowsAgentBrowser(value: unknown): boolean {
  return isApiPrimaryAgentType(value)
}

export function getPrimaryAgentDisplayLabel(
  value: unknown
): 'n8n (retired)' | 'API' | 'CLI' {
  if (isCliPrimaryAgentType(value)) return 'CLI'
  // SA-106: only a record that actually names the retired type gets the retired label.
  // Everything else — including malformed records — reads as API, matching what
  // `normalizePrimaryAgentType` resolves it to.
  if (isN8nPrimaryAgentType(value)) return 'n8n (retired)'
  return 'API'
}

export function getPrimaryAgentSystemPromptRedisKey(type: PrimaryAgentType): string {
  switch (type) {
    case 'api':
      return 'batshit:batshit_mode3_system_prompt'
    case 'cli':
      return 'batshit:batshit_mode4_system_prompt'
  }
}

export function getPrimaryAgentSystemPromptLabel(type: PrimaryAgentType): string {
  switch (type) {
    case 'api':
      return 'API PRIMARY SYSTEM PROMPT'
    case 'cli':
      return 'CLI PRIMARY SYSTEM PROMPT'
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

export function canonicalizePrimaryAgentRecord<T extends Record<string, any>>(agent: T): T & {
  agentType: StoredPrimaryAgentType
} {
  const next = { ...agent } as Record<string, any>
  next.agentType = normalizePrimaryAgentType(next)

  delete next.agent_type
  delete next.batshitMode
  delete next.batshit_mode
  delete next.n8nImplementation
  delete next.mode

  return next as T & { agentType: StoredPrimaryAgentType }
}
