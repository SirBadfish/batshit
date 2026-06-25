import type {
  CodexRuntimeSettings,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexAgentSettings,
  CodexHistoryPersistence,
  CodexServiceTier,
  CodexConfigOverride
} from '$lib/types/codex'
import { MODE4_STYLE_PRELAUNCH } from '$lib/server/constants/mode4Policy'
import toml from '@iarna/toml'

const { parse: parseToml } = toml

const PERMISSION_PRESETS: Record<CodexPermissionMode, { sandbox: CodexRuntimeSettings['sandbox']; approval: CodexRuntimeSettings['approval'] }> = {
  chat: {
    sandbox: 'read-only',
    approval: 'never'
  },
  agent: {
    sandbox: 'workspace-write',
    approval: 'on-failure'
  },
  agent_full: {
    sandbox: 'danger-full-access',
    approval: 'never'
  }
}

const SANDBOX_VALUES: CodexRuntimeSettings['sandbox'][] = [
  'read-only',
  'workspace-write',
  'danger-full-access'
]

const APPROVAL_VALUES: CodexRuntimeSettings['approval'][] = [
  'never',
  'on-request',
  'on-failure',
  'untrusted'
]

const REASONING_VALUES: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']
const HISTORY_PERSISTENCE_VALUES: CodexHistoryPersistence[] = ['save-all', 'none']
const MANAGED_CONFIG_RESERVED_EXACT_KEYS = new Set([
  'approval_policy',
  'experimental_instructions_file',
  'features',
  'history',
  'history.persistence',
  'mcp_servers',
  'model',
  'model_instructions_file',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_supports_reasoning_summaries',
  'projects',
  'sandbox_mode',
  'sandbox_workspace_write',
  'sandbox_workspace_write.writable_roots',
  'service_tier',
  'skills.config',
  'web_search'
])
const MANAGED_CONFIG_RESERVED_PREFIXES = [
  'features.',
  'history.',
  'mcp_servers.',
  'projects.',
  'sandbox_workspace_write.'
]

export interface CodexConfigOverrideSanitizationResult {
  overrides: CodexConfigOverride[]
  reservedKeys: string[]
  duplicateKeys: string[]
  invalidKeys: string[]
}

function sanitizePermission(value: unknown): CodexPermissionMode {
  if (value === 'agent' || value === 'agent_full' || value === 'chat') {
    return value
  }
  return 'chat'
}

function sanitizeSandbox(value: unknown): CodexRuntimeSettings['sandbox'] | undefined {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (SANDBOX_VALUES.includes(lower as CodexRuntimeSettings['sandbox'])) {
      return lower as CodexRuntimeSettings['sandbox']
    }
  }
  return undefined
}

function sanitizeApproval(value: unknown): CodexRuntimeSettings['approval'] | undefined {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (APPROVAL_VALUES.includes(lower as CodexRuntimeSettings['approval'])) {
      return lower as CodexRuntimeSettings['approval']
    }
  }
  return undefined
}

function sanitizeReasoning(value: unknown): CodexReasoningEffort | undefined {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (REASONING_VALUES.includes(lower as CodexReasoningEffort)) {
      return lower as CodexReasoningEffort
    }
  }
  return undefined
}

function sanitizeHistoryPersistence(value: unknown): CodexHistoryPersistence | undefined {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (HISTORY_PERSISTENCE_VALUES.includes(lower as CodexHistoryPersistence)) {
      return lower as CodexHistoryPersistence
    }
  }
  return undefined
}

function sanitizeServiceTier(value: unknown): CodexServiceTier | undefined {
  if (typeof value !== 'string') return undefined
  const lower = value.toLowerCase()
  if (lower === 'fast') return 'fast'
  if (lower === 'standard' || lower === 'default') return 'standard'
  return undefined
}

function sanitizeWorkingDirectoryMode(value: unknown): CodexRuntimeSettings['workingDirectoryMode'] {
  return value === 'custom' ? 'custom' : 'project'
}

function sanitizeWorkingDirectory(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
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

function normalizeOverrideKey(value: string) {
  return value.trim().toLowerCase()
}

function isManagedConfigReservedKey(key: string) {
  if (MANAGED_CONFIG_RESERVED_EXACT_KEYS.has(key)) return true
  return MANAGED_CONFIG_RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function sanitizeCodexConfigOverrides(
  overrides: Array<CodexConfigOverride | null | undefined> | null | undefined
): CodexConfigOverrideSanitizationResult {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return {
      overrides: [],
      reservedKeys: [],
      duplicateKeys: [],
      invalidKeys: []
    }
  }

  const sanitizedReversed: CodexConfigOverride[] = []
  const reservedKeys: string[] = []
  const duplicateKeys: string[] = []
  const invalidKeys: string[] = []
  const seenKeys = new Set<string>()
  const acceptedLines: string[] = []

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

    seenKeys.add(normalizedKey)
    const serializedValue =
      typeof override.value === 'string'
        ? override.value
        : override.value !== undefined
          ? String(override.value)
          : ''
    const candidateLine = `${key} = ${JSON.stringify(serializedValue)}`
    try {
      parseToml([...acceptedLines, candidateLine].join('\n'))
      acceptedLines.push(candidateLine)
    } catch {
      invalidKeys.push(key)
      continue
    }

    sanitizedReversed.push({
      key,
      value: serializedValue
    })
  }

  return {
    overrides: sanitizedReversed.reverse(),
    reservedKeys: Array.from(new Set(reservedKeys.reverse())),
    duplicateKeys: Array.from(new Set(duplicateKeys.reverse())),
    invalidKeys: Array.from(new Set(invalidKeys.reverse()))
  }
}

export function getCodexConfigOverrideValidationError(settings: CodexAgentSettings | null | undefined) {
  const result = sanitizeCodexConfigOverrides(settings?.configOverrides)
  if (result.reservedKeys.length > 0) {
    return `Codex config overrides can't redefine Batshit-managed settings: ${result.reservedKeys.join(', ')}. Use the dedicated Batshit controls instead.`
  }
  if (result.duplicateKeys.length > 0) {
    return `Codex config override keys must be unique. Duplicate keys: ${result.duplicateKeys.join(', ')}.`
  }
  if (result.invalidKeys.length > 0) {
    return `Codex config overrides contain invalid or conflicting TOML keys: ${result.invalidKeys.join(', ')}.`
  }
  return null
}

export function resolveCodexWebSearchMode(enabled: boolean | null | undefined): 'disabled' | 'live' {
  return enabled === false ? 'disabled' : 'live'
}

export function buildCodexRuntimeSettings(
  providerSettings?: Record<string, any> | CodexAgentSettings | null,
  overrides?: Partial<{ permissionMode: CodexPermissionMode }>
): CodexRuntimeSettings {
  const structuredSource = isAgentSettings(providerSettings) ? providerSettings : null
  const providerRecord = !structuredSource && providerSettings && typeof providerSettings === 'object'
    ? (providerSettings as Record<string, any>)
    : null
  const permissionOverrideApplied = overrides?.permissionMode !== undefined
  const configScope = 'managed'
  const permission = sanitizePermission(
    overrides?.permissionMode ?? (structuredSource?.permissionMode ?? providerRecord?.codex_permission_mode)
  )

  const preset = PERMISSION_PRESETS[permission]
  const sandbox =
    overrides?.permissionMode
      ? preset.sandbox
      : (structuredSource?.sandbox ?? sanitizeSandbox(providerRecord?.codex_sandbox) ?? preset.sandbox)
  const approval =
    overrides?.permissionMode
      ? preset.approval
      : (structuredSource?.approval ?? sanitizeApproval(providerRecord?.codex_approval) ?? preset.approval)

  const sanitizedStructuredOverrides = sanitizeCodexConfigOverrides(structuredSource?.configOverrides)
  const sanitizedLegacyOverrides = sanitizeCodexConfigOverrides(
    Array.isArray(providerRecord?.codex_config_overrides)
      ? providerRecord.codex_config_overrides
          .map((entry: { key?: string; value?: unknown } | null | undefined) => {
            if (!entry || typeof entry !== 'object') return null
            const key = typeof entry.key === 'string' ? entry.key.trim() : ''
            const value =
              typeof entry.value === 'string' ? entry.value : entry.value !== undefined
                ? String(entry.value)
                : ''
            if (!key.length) return null
            return { key, value }
          })
          .filter((entry: { key: string; value: string } | null): entry is { key: string; value: string } => Boolean(entry))
      : []
  )

  const settings: CodexRuntimeSettings = {
    mode4Style: MODE4_STYLE_PRELAUNCH,
    permissionMode: permission,
    includeProjectInstructions:
      typeof structuredSource?.includeProjectInstructions === 'boolean'
        ? structuredSource.includeProjectInstructions
        : typeof providerRecord?.codex_include_project_instructions === 'boolean'
          ? providerRecord.codex_include_project_instructions
          : ((structuredSource as any)?.includeCoreSystemPrompt === true ||
              providerRecord?.codex_include_core_system_prompt === true),
    model:
      typeof structuredSource?.model === 'string' && structuredSource.model.trim().length
        ? structuredSource.model.trim()
        : typeof providerRecord?.codex_model === 'string' && providerRecord.codex_model.trim().length
          ? providerRecord.codex_model.trim()
          : undefined,
    sandbox,
    approval,
    configScope,
    permissionOverridden: permissionOverrideApplied,
    fullAuto: structuredSource
      ? structuredSource.permissionMode === 'agent_full'
      : Boolean(providerRecord?.codex_full_auto ?? (permission === 'agent_full')),
    streamingEffect: true,
    search: structuredSource ? structuredSource.search !== false : providerRecord?.codex_search === false ? false : true,
    addDirs: structuredSource ? [...structuredSource.addDirs] : toStringArray(providerRecord?.codex_additional_dirs),
    enableFeatures: structuredSource ? [...structuredSource.enableFeatures] : toStringArray(providerRecord?.codex_feature_enable),
    disableFeatures: structuredSource ? [...structuredSource.disableFeatures] : toStringArray(providerRecord?.codex_feature_disable),
    configOverrides: structuredSource
      ? sanitizedStructuredOverrides.overrides
      : sanitizedLegacyOverrides.overrides,
    workingDirectoryMode: structuredSource
      ? sanitizeWorkingDirectoryMode(structuredSource.workingDirectoryMode)
      : sanitizeWorkingDirectoryMode(providerRecord?.codex_workdir_mode),
    customWorkingDirectory: structuredSource
      ? sanitizeWorkingDirectory(structuredSource.customWorkingDirectory)
      : sanitizeWorkingDirectory(providerRecord?.codex_custom_workdir),
    reasoningEffort:
      structuredSource?.reasoningEffort && structuredSource.reasoningEffort !== 'default'
        ? structuredSource.reasoningEffort as CodexReasoningEffort
        : sanitizeReasoning(providerRecord?.codex_reasoning_effort),
    serviceTier:
      sanitizeServiceTier(structuredSource?.serviceTier) ??
      sanitizeServiceTier(providerRecord?.codex_service_tier) ??
      'standard',
    profileId:
      structuredSource?.profileId ?? (
        providerRecord && typeof providerRecord.codex_profile_id === 'string'
          ? providerRecord.codex_profile_id
          : undefined
      ),
    unifiedExec: true,
    historyPersistence:
      structuredSource?.historyPersistence ??
      sanitizeHistoryPersistence(providerRecord?.codex_history_persistence) ??
      'none'
  }

  // Leave `xhigh` intact here; Codex itself validates model support.

  return settings
}

function isAgentSettings(value: any): value is CodexAgentSettings {
  return !!value && typeof value === 'object' && 'permissionMode' in value && 'model' in value
}
