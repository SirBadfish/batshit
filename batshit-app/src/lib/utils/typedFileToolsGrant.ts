/** Shared typed-file field/host facts. Legacy global/value readers remain for compiler
 * compatibility; native tool registration consumes explicit materialized record booleans. */

/**
 * The grant's factory value (SA-136 D1/D9): OFF while the arm has not run. Josh's rule: the
 * default follows Josh's benchmark decision; P2c does not change it.
 */
export const TYPED_FILE_TOOLS_FACTORY_DEFAULT = false

/** The agent's and the Subagent's field, inside `provider_specific_settings.nativeTools`. */
export const TYPED_FILE_TOOLS_AGENT_FIELD = 'typedFileToolsEnabled' as const
/** The user's global field, inside `global_tool_grid_settings`. */
export const TYPED_FILE_TOOLS_GLOBAL_FIELD = 'typed_file_tools' as const
export const TYPED_FILE_TOOLS_LABEL = 'Typed File Tools'
/**
 * The one sentence every Settings surface and the UserDocs use for the Always Block List (the
 * saved `bashNeverAllowList`) and the typed tools (P1 settle, 2026-10-21; D3).
 */
export const TYPED_FILE_TOOLS_BLOCK_LIST_SENTENCE =
  'The Always Block List also covers the typed file tools: a rule whose first word names apply_patch, write_file or edit_file blocks every write_file and edit_file call, and one naming read_file blocks read_file. Wildcards count, so apply_patch* names the two writers and * names all three. The rest of the rule is not read as a file path.'

/** An explicit saved value: true or false (also as text); anything else, null included, inherits. */
export function readTypedFileToolsValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

/** An agent or Subagent record's own saved value (`nativeTools.typedFileToolsEnabled`). */
export function agentTypedFileToolsValue(providerSettings: unknown): boolean | null {
  const settings = providerSettings && typeof providerSettings === 'object' ? (providerSettings as Record<string, any>) : null
  const nested =
    settings?.nativeTools && typeof settings.nativeTools === 'object'
      ? settings.nativeTools
      : settings?.batshitNativeTools && typeof settings.batshitNativeTools === 'object'
        ? settings.batshitNativeTools
        : null
  return readTypedFileToolsValue(nested?.[TYPED_FILE_TOOLS_AGENT_FIELD])
}

/** The user's global value (`global_tool_grid_settings.typed_file_tools`). */
export function globalTypedFileToolsValue(userSettings: unknown): boolean | null {
  const settings = userSettings && typeof userSettings === 'object' ? (userSettings as Record<string, any>) : null
  const grid = settings?.global_tool_grid_settings
  return readTypedFileToolsValue(grid && typeof grid === 'object' ? grid[TYPED_FILE_TOOLS_GLOBAL_FIELD] : undefined)
}

/** Legacy migration-era resolver; never a runtime inheritance source after conversion. */
export function resolveTypedFileToolsGrant(agentValue: boolean | null, globalValue: boolean | null): boolean {
  return agentValue ?? globalValue ?? TYPED_FILE_TOOLS_FACTORY_DEFAULT
}

/**
 * Write-side check for `POST /api/user/settings`: `global_tool_grid_settings` is saved whole, so
 * this is the only gate a mistyped grant meets. A present value must be true, false or null.
 */
export function validateTypedFileToolsGlobalField(globalToolGridSettings: unknown): string | null {
  if (!globalToolGridSettings || typeof globalToolGridSettings !== 'object' || Array.isArray(globalToolGridSettings)) return null
  if (!Object.prototype.hasOwnProperty.call(globalToolGridSettings, TYPED_FILE_TOOLS_GLOBAL_FIELD)) return null
  const value = (globalToolGridSettings as Record<string, unknown>)[TYPED_FILE_TOOLS_GLOBAL_FIELD]
  return value === null || typeof value === 'boolean' ? null : `"${TYPED_FILE_TOOLS_LABEL}" must be true or false.`
}

/** Server-owned host facts carried by the existing sandbox-status response for Settings. */
export interface TypedFileToolsHost {
  platform: string
  containerized: boolean
  linuxKernel: string | null
  /** Server-owned configuration fact, not a claim that a runtime is running or admitted. */
  dockerSandboxOperatorConfigured?: boolean
}

/**
 * P2c qualification, shared by tool registration, compiler guidance and Settings. This admits
 * host-workspace custody only; the native helper still verifies admission on every call and
 * refuses missing/old binaries, unsupported kernels and filesystem access without a fallback.
 */
export function typedFileToolsUnavailableReason(backend: unknown, host: TypedFileToolsHost | null): string | null {
  if (!host) return 'Checking typed file tools availability.'
  if (host.platform !== 'darwin' && host.platform !== 'linux') {
    return 'Typed file tools need a supported Mac or Linux host.'
  }
  // SA-137 Round 2 (R2-5): on a Mac, Docker Sandbox mounts the host workspace at the same path as
  // Apple Container does, so the same host custody serves both (each refuses a protected root first).
  if (host.containerized && host.platform !== 'linux') return 'Typed file tools need a supported Linux app container.'
  if (host.containerized && backend === 'docker_sandbox' && host.dockerSandboxOperatorConfigured !== true) {
    return 'Typed file tools with Docker Sandbox need the configured host operator and a host bind workspace.'
  }
  const sandboxQualified = host.containerized
    ? backend === 'docker_sandbox'
    : (backend === 'apple_container' || backend === 'docker_sandbox') && host.platform === 'darwin'
  if (backend !== 'local' && !sandboxQualified) {
    return 'Typed file tools are not qualified with this Sandbox Level yet.'
  }
  if (host.platform === 'linux') {
    const kernel = /^(\d+)\.(\d+)(?:[.-]|$)/.exec(host.linuxKernel ?? '')
    if (!kernel || Number(kernel[1]) < 5 || (Number(kernel[1]) === 5 && Number(kernel[2]) < 6)) {
      return 'Typed file tools need Linux 5.6 or later and the native file helper.'
    }
  }
  return null
}
