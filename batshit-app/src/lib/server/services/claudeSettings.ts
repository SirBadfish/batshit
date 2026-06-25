import type {
  ClaudeRuntimeSettings,
  ClaudePermissionMode,
  ClaudeAgentSettings,
  ClaudeSystemPromptMode,
  ClaudeSettingSource,
  ClaudeConfigOverride
} from '$lib/types/claude'
import {
  MODE4_CLAUDE_CR_STYLE_SYSTEM_PROMPT,
  MODE4_STYLE_PRELAUNCH
} from '$lib/server/constants/mode4Policy'

function sanitizePermission(value: unknown): ClaudePermissionMode {
  if (value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions') {
    return value
  }
  if (value === 'default' || value === 'chat') return 'acceptEdits'
  if (value === 'agent') return 'acceptEdits'
  if (value === 'agent_full') return 'bypassPermissions'
  return 'acceptEdits'
}

function sanitizeMaxThinkingTokens(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return undefined
}

function toStringArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}

const MANAGED_CONFIG_RESERVED_EXACT_KEYS = new Set([
  'alwaysthinkingenabled',
  'env',
  'env.max_thinking_tokens',
  'permissions',
  'permissions.additionaldirectories',
  'permissions.defaultmode'
])

export interface ClaudeConfigOverrideSanitizationResult {
  overrides: ClaudeConfigOverride[]
  reservedKeys: string[]
  duplicateKeys: string[]
  invalidKeys: string[]
}

function normalizeOverrideKey(value: string) {
  return value.trim().toLowerCase()
}

function isManagedConfigReservedKey(key: string) {
  return MANAGED_CONFIG_RESERVED_EXACT_KEYS.has(key)
}

function splitConfigPath(key: string) {
  return key
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

function parseClaudeConfigOverrideValue(raw: string | undefined) {
  if (raw === undefined) return ''
  const trimmed = raw.trim()
  if (!trimmed.length) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null

  const numeric = Number(trimmed)
  if (!Number.isNaN(numeric) && trimmed === numeric.toString()) {
    return numeric
  }

  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Fall through to plain string handling.
    }
  }

  return trimmed
}

function setNestedJsonValue(
  target: Record<string, unknown>,
  pathSegments: string[],
  value: unknown
) {
  if (pathSegments.length === 0) return false

  let current: Record<string, unknown> = target
  for (let index = 0; index < pathSegments.length; index += 1) {
    const segment = pathSegments[index]
    const atLeaf = index === pathSegments.length - 1

    if (atLeaf) {
      if (current[segment] !== undefined) {
        return false
      }
      current[segment] = value
      return true
    }

    const existing = current[segment]
    if (existing === undefined) {
      const next: Record<string, unknown> = {}
      current[segment] = next
      current = next
      continue
    }

    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return false
    }

    current = existing as Record<string, unknown>
  }

  return false
}

export function sanitizeClaudeConfigOverrides(
  overrides: Array<ClaudeConfigOverride | null | undefined> | null | undefined
): ClaudeConfigOverrideSanitizationResult {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return {
      overrides: [],
      reservedKeys: [],
      duplicateKeys: [],
      invalidKeys: []
    }
  }

  const sanitizedReversed: ClaudeConfigOverride[] = []
  const reservedKeys: string[] = []
  const duplicateKeys: string[] = []
  const invalidKeys: string[] = []
  const seenKeys = new Set<string>()
  const acceptedObject: Record<string, unknown> = {}

  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const override = overrides[index]
    if (!override || typeof override !== 'object') continue

    const key = typeof override.key === 'string' ? override.key.trim() : ''
    if (!key) continue

    const normalizedKey = normalizeOverrideKey(key)
    if (isManagedConfigReservedKey(normalizedKey)) {
      reservedKeys.push(key)
      continue
    }

    if (seenKeys.has(normalizedKey)) {
      duplicateKeys.push(key)
      continue
    }

    const pathSegments = splitConfigPath(key)
    if (pathSegments.length === 0) {
      invalidKeys.push(key)
      continue
    }

    const nextSnapshot = structuredClone(acceptedObject)
    const parsedValue = parseClaudeConfigOverrideValue(
      typeof override.value === 'string'
        ? override.value
        : override.value !== undefined
          ? String(override.value)
          : ''
    )

    if (!setNestedJsonValue(nextSnapshot, pathSegments, parsedValue)) {
      invalidKeys.push(key)
      continue
    }

    seenKeys.add(normalizedKey)
    Object.assign(acceptedObject, nextSnapshot)
    sanitizedReversed.push({
      key,
      value:
        typeof override.value === 'string'
          ? override.value
          : override.value !== undefined
            ? String(override.value)
            : ''
    })
  }

  return {
    overrides: sanitizedReversed.reverse(),
    reservedKeys: Array.from(new Set(reservedKeys.reverse())),
    duplicateKeys: Array.from(new Set(duplicateKeys.reverse())),
    invalidKeys: Array.from(new Set(invalidKeys.reverse()))
  }
}

export function getClaudeConfigOverrideValidationError(
  settings: ClaudeAgentSettings | null | undefined
) {
  const result = sanitizeClaudeConfigOverrides(settings?.configOverrides)
  if (result.reservedKeys.length > 0) {
    return `Claude custom settings can't redefine Batshit-managed settings: ${result.reservedKeys.join(', ')}. Use the dedicated Batshit controls instead.`
  }
  if (result.duplicateKeys.length > 0) {
    return `Claude custom setting keys must be unique. Duplicate keys: ${result.duplicateKeys.join(', ')}.`
  }
  if (result.invalidKeys.length > 0) {
    return `Claude custom settings contain invalid or conflicting JSON paths: ${result.invalidKeys.join(', ')}.`
  }
  return null
}

function isAgentSettings(value: unknown): value is ClaudeAgentSettings {
  return Boolean(value && typeof value === 'object' && 'permissionMode' in (value as any))
}

export function buildClaudeRuntimeSettings(
  providerSettings?: Record<string, any> | ClaudeAgentSettings | null,
  overrides?: Partial<{ permissionMode: ClaudePermissionMode }>
): ClaudeRuntimeSettings {
  const structuredSource = isAgentSettings(providerSettings) ? providerSettings : null
  const providerRecord = !structuredSource && providerSettings && typeof providerSettings === 'object'
    ? (providerSettings as Record<string, any>)
    : null

  const permission = sanitizePermission(
    overrides?.permissionMode ?? structuredSource?.permissionMode ?? providerRecord?.claude_permission_mode
  )

  const configScope =
    'managed'

  const includeCoreSystemPrompt =
    structuredSource?.includeCoreSystemPrompt === true ||
    providerRecord?.claude_include_core_system_prompt === true

  const includeProjectInstructions =
    typeof structuredSource?.includeProjectInstructions === 'boolean'
      ? structuredSource.includeProjectInstructions
      : typeof providerRecord?.claude_include_project_instructions === 'boolean'
        ? providerRecord.claude_include_project_instructions
        : true

  const promptMode: ClaudeSystemPromptMode = includeCoreSystemPrompt ? 'default' : 'replace'
  const settingSources: ClaudeSettingSource[] = includeProjectInstructions ? ['project'] : []

  const workingDirectoryMode: ClaudeRuntimeSettings['workingDirectoryMode'] = 'project'

  const alwaysThinkingEnabled =
    structuredSource?.alwaysThinkingEnabled ??
    Boolean(
      providerRecord?.claude_always_thinking_enabled ??
        providerRecord?.claude_always_thinking ??
        false
    )

  const maxThinkingTokens = sanitizeMaxThinkingTokens(
    structuredSource?.maxThinkingTokens ?? providerRecord?.claude_max_thinking_tokens
  )

  const resolvedAlwaysThinking = alwaysThinkingEnabled === true
  const resolvedMaxThinkingTokens =
    resolvedAlwaysThinking
      ? typeof maxThinkingTokens === 'number'
        ? maxThinkingTokens
        : 1024
      : undefined

  const sanitizedStructuredOverrides = sanitizeClaudeConfigOverrides(structuredSource?.configOverrides)
  const sanitizedLegacyOverrides = sanitizeClaudeConfigOverrides(
    Array.isArray(providerRecord?.claude_config_overrides)
      ? providerRecord.claude_config_overrides
          .map((entry: { key?: string; value?: unknown } | null | undefined) => {
            if (!entry || typeof entry !== 'object') return null
            const key = typeof entry.key === 'string' ? entry.key.trim() : ''
            const value =
              typeof entry.value === 'string'
                ? entry.value
                : entry.value !== undefined
                  ? String(entry.value)
                  : ''
            if (!key.length) return null
            return { key, value }
          })
          .filter((entry: { key: string; value: string } | null): entry is { key: string; value: string } => Boolean(entry))
      : []
  )

  const settings: ClaudeRuntimeSettings = {
    mode4Style: MODE4_STYLE_PRELAUNCH,
    permissionMode: permission,
    profileId:
      typeof structuredSource?.profileId === 'string' && structuredSource.profileId.trim().length > 0
        ? structuredSource.profileId.trim()
        : typeof providerRecord?.claude_profile_id === 'string' &&
            providerRecord.claude_profile_id.trim().length > 0
          ? providerRecord.claude_profile_id.trim()
          : undefined,
    includeCoreSystemPrompt,
    includeProjectInstructions,
    model:
      typeof structuredSource?.model === 'string' && structuredSource.model.trim().length
        ? structuredSource.model.trim()
        : typeof providerRecord?.claude_model === 'string' && providerRecord.claude_model.trim().length
          ? providerRecord.claude_model.trim()
          : undefined,
    alwaysThinkingEnabled: resolvedAlwaysThinking,
    maxThinkingTokens: resolvedMaxThinkingTokens,
    configScope,
    systemPromptMode: promptMode,
    systemPrompt: includeCoreSystemPrompt ? undefined : MODE4_CLAUDE_CR_STYLE_SYSTEM_PROMPT,
    systemPromptFile: undefined,
    settingSources,
    chrome:
      structuredSource?.chrome ?? (providerRecord?.claude_chrome_enabled ? true : false),
    addDirs: structuredSource && Array.isArray(structuredSource.addDirs)
      ? [...structuredSource.addDirs]
      : toStringArray(providerRecord?.claude_additional_dirs),
    allowedTools: structuredSource && Array.isArray(structuredSource.allowedTools)
      ? [...structuredSource.allowedTools]
      : toStringArray(providerRecord?.claude_allowed_tools),
    disallowedTools: structuredSource && Array.isArray(structuredSource.disallowedTools)
      ? [...structuredSource.disallowedTools]
      : toStringArray(providerRecord?.claude_disallowed_tools),
    configOverrides: structuredSource
      ? sanitizedStructuredOverrides.overrides
      : sanitizedLegacyOverrides.overrides,
    workingDirectoryMode,
    customWorkingDirectory: undefined
  }

  return settings
}
