import { hasSubagentToolSegment, slugToolName } from './toolNameNormalization'

/**
 * Tool Settings and Language Detection
 * Provides tool-specific buffer/threshold settings and language detection for syntax highlighting
 */

// Canonical tool IDs – provider-agnostic names we use for zip settings and renderer lookups
// NOTE: Keep names simple/slugged so they can ship to Redis settings safely.
export const canonicalToolAliases: Record<string, string> = {
  // File ops
  batshit_server_read_file: 'read_file',
  read_file: 'read_file',
  batshit_server_write_file: 'write_file',
  write_file: 'write_file',
  batshit_server_overwrite_file: 'write_file',
  overwrite_file: 'write_file',
  batshit_server_edit_file: 'edit_file',
  edit_file: 'edit_file',
  batshit_server_list_files: 'list_files',
  list_files: 'list_files',
  batshit_server_search_files: 'search_files',
  search_files: 'search_files',

  // Command
  batshit_server_execute_command: 'execute_command',
  execute_command: 'execute_command',
  batshit_server_run_bash_command: 'execute_command',
  batshit_server_bash_execute: 'execute_command',
  native_bash_execute: 'execute_command',

  // Dynamic MCP / Native bridge
  batshit_server_dynamic_mcp_find: 'dynamic_mcp_find',
  dynamic_mcp_find: 'dynamic_mcp_find',
  native_dynamic_mcp_find: 'dynamic_mcp_find',
  batshit_server_dynamic_mcp_use: 'dynamic_mcp_use',
  dynamic_mcp_use: 'dynamic_mcp_use',
  native_dynamic_mcp_use: 'dynamic_mcp_use',
  batshit_tool_search: 'tool_find',
  native_batshit_tool_search: 'tool_find',
  batshit_tool_use: 'unknown',
  native_batshit_tool_use: 'unknown',
  batshit_server_fetch_zip: 'fetch_zip',
  fetch_zip: 'fetch_zip',
  native_fetch_zip: 'fetch_zip',
  batshit_server_cli_tool_find: 'tool_find',
  cli_tool_find: 'tool_find',
  native_cli_tool_find: 'tool_find',
  batshit_server_cli_tool_use: 'cli_tool',
  cli_tool_use: 'cli_tool',
  native_cli_tool_use: 'cli_tool',
  artifact_find: 'artifact_find',
  native_artifact_find: 'artifact_find',
  mcp_artifact_find: 'artifact_find',
  artifact_use: 'artifact_use',
  native_artifact_use: 'artifact_use',
  mcp_artifact_use: 'artifact_use',
  native_fabric_find: 'fabric_find',
  mcp_fabric_find: 'fabric_find',
  native_fabric_use: 'fabric_use',
  mcp_fabric_use: 'fabric_use',

  // Native utility tools
  web_search: 'web_search',
  native_web_search: 'web_search',
  codex_web_search: 'web_search',
  claude_web_search: 'web_search',
  invoke_skill: 'invoke_skill',
  native_skill: 'skill_reference',
  native_skill_reference: 'skill_reference', // legacy alias
  native_skill_script: 'skill_script',
  native_agent_browser_find: 'agent_browser_find',
  native_agent_browser_use: 'agent_browser_use',
  bash: 'bash',
  skill_read: 'skill_read',
  dynamic_find: 'dynamic_find',
  dynamic_use: 'dynamic_use',

  // Subagent
  call_subagent: 'subagent',

  // Generic fallbacks
}

export function canonicalToolName(toolName: string | undefined): string {
  if (!toolName) return 'unknown'
  const key = toolName.trim().toLowerCase()
  const withoutSummary = key
    .replace(/^tool execution:\s*/i, '')
    .replace(/\s*-\s*\d+\s+lines?$/i, '')
    .trim()
  const slug = slugToolName(key)
  const summarySlug = slugToolName(withoutSummary)
  // Codex / MCP subagent tools are named like `mcp.*.subagent_<slug>`
  if (hasSubagentToolSegment(key)) return 'subagent'
  return (
    canonicalToolAliases[key] ||
    canonicalToolAliases[withoutSummary] ||
    canonicalToolAliases[slug] ||
    canonicalToolAliases[summarySlug] ||
    toolName
  )
}

/**
 * Tool categories for granular settings
 * Maps canonical tool names to their category for default settings
 */
export const toolCategories = {
  fileReading: ['read_file', 'skill_read'],
  fileWriting: ['write_file'],
  fileEditing: ['edit_file'],
  commandExecution: ['execute_command', 'bash'],
  searchFind: ['search_files'],
  listing: ['list_files'],
  webSearch: ['web_search'],
  dynamic: ['dynamic_find', 'dynamic_use'],
  cli: ['tool_find', 'cli_tool'],
  artifact: ['artifact_find', 'artifact_use'],
  fabric: ['fabric_find', 'fabric_use', 'fetch_zip'],
  agentBrowser: ['agent_browser_find', 'agent_browser_use'],
  codex: ['codex_plan_update', 'codex_web_search'],
  subagent: ['subagent']
}

/**
 * Default settings for each tool category
 */
type ZipPolicyDefault = {
  buffer_size: number
  zip_threshold: number
  auto_zip?: boolean
}

export const categoryDefaults: Record<string, ZipPolicyDefault> = {
  fileReading: { buffer_size: 8, zip_threshold: 0 },
  fileWriting: { buffer_size: 2, zip_threshold: 0 },
  fileEditing: { buffer_size: 2, zip_threshold: 0 },
  commandExecution: { buffer_size: 1, zip_threshold: 0 },
  searchFind: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  listing: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  webSearch: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  dynamic: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  cli: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  artifact: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  fabric: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  agentBrowser: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  subagent: { buffer_size: 2, zip_threshold: 0 },
  codex: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  allOther: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  coolTool: { buffer_size: 1, zip_threshold: 0, auto_zip: true }
}

const TOOL_DEFAULTS: Record<string, ZipPolicyDefault> = {
  read_file: { buffer_size: 8, zip_threshold: 0, auto_zip: false },
  skill_read: { buffer_size: 10, zip_threshold: 0, auto_zip: false },
  write_file: { buffer_size: 2, zip_threshold: 0, auto_zip: false },
  edit_file: { buffer_size: 2, zip_threshold: 0, auto_zip: false },
  execute_command: { buffer_size: 1, zip_threshold: 0, auto_zip: false },
  bash: { buffer_size: 1, zip_threshold: 0, auto_zip: false },
  search_files: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  list_files: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  web_search: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  fetch_zip: { buffer_size: 1, zip_threshold: 0, auto_zip: false },
  dynamic_find: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  tool_find: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  artifact_find: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  artifact_use: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  fabric_find: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  fabric_use: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  agent_browser_find: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  agent_browser_use: { buffer_size: 1, zip_threshold: 0, auto_zip: true },
  subagent: { buffer_size: 2, zip_threshold: 0, auto_zip: false }
}

const TYPE_DEFAULTS: Record<string, ZipPolicyDefault> = {
  terminal: { buffer_size: 1, zip_threshold: 0, auto_zip: false },
  diff: { buffer_size: 2, zip_threshold: 0, auto_zip: false },
  error: { buffer_size: 2, zip_threshold: 0, auto_zip: false },
  image: { buffer_size: 0, zip_threshold: 0, auto_zip: true },
  cool_tool: { ...categoryDefaults.coolTool, auto_zip: false },
  all_other: { ...categoryDefaults.allOther }
}

const UNIVERSAL_DEFAULT_BUFFER = Number.POSITIVE_INFINITY
const UNIVERSAL_DEFAULT_THRESHOLD = 0
const FIELD_BACKED_TOOL_SETTINGS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'execute_command',
  'bash',
  'list_files'
])

export function shouldPreferFieldSettingsForTool(toolName: string | undefined): boolean {
  return FIELD_BACKED_TOOL_SETTINGS.has(canonicalToolName(toolName))
}

export type ToolSettingsOptions = {
  ignoreCustomToolSettings?: boolean
}

function coerceNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function getSettingValue(
  agentSettings: any,
  globalSettings: any,
  key: string
): number | undefined {
  const agentValue = coerceNumber(agentSettings?.[key])
  if (agentValue !== undefined) return agentValue
  const globalValue = coerceNumber(globalSettings?.[key])
  if (globalValue !== undefined) return globalValue
  return undefined
}

function getSettingBoolean(
  agentSettings: any,
  globalSettings: any,
  key: string
): boolean | undefined {
  const agentValue = agentSettings?.[key]
  if (typeof agentValue === 'boolean') return agentValue
  const globalValue = globalSettings?.[key]
  if (typeof globalValue === 'boolean') return globalValue
  return undefined
}

function findCustomToolSetting(
  settings: Array<{ tool_name: string; buffer_size?: number; zip_threshold?: number; auto_zip?: boolean; zip_disabled?: boolean }> | undefined,
  toolName: string,
  alternateNames: string[]
) {
  if (!settings || settings.length === 0) return undefined
  return settings.find(
    (setting) => setting.tool_name === toolName || alternateNames.includes(setting.tool_name)
  )
}

function getCategoryDefault(toolName: string) {
  const toolDefault = TOOL_DEFAULTS[toolName]
  if (toolDefault) return toolDefault

  for (const [category, tools] of Object.entries(toolCategories)) {
    if (tools.includes(toolName)) {
      return categoryDefaults[category as keyof typeof categoryDefaults]
    }
  }
  return categoryDefaults.allOther
}

function getToolCategoryName(toolName: string): keyof typeof categoryDefaults | null {
  for (const [category, tools] of Object.entries(toolCategories)) {
    if (tools.includes(toolName)) {
      return category as keyof typeof categoryDefaults
    }
  }
  return null
}

function getToolLookupNames(toolName: string): string[] {
  const canonicalName = canonicalToolName(toolName)
  const names = [canonicalName]

  switch (canonicalName) {
    case 'bash':
      names.push('execute_command')
      break
    case 'skill_read':
      names.push('read_file', 'skill_reference')
      break
    case 'dynamic_find':
      names.push('dynamic_mcp_find')
      break
    case 'dynamic_use':
      names.push('dynamic_mcp_use')
      break
    case 'tool_find':
      names.push('cli_tool_find')
      break
    case 'cli_tool':
      names.push('cli_tool_use')
      break
    case 'artifact_find':
      names.push('native_artifact_find', 'mcp_artifact_find')
      break
    case 'artifact_use':
      names.push('native_artifact_use', 'mcp_artifact_use')
      break
    case 'fetch_zip':
      names.push('native_fetch_zip', 'batshit_server_fetch_zip')
      break
    case 'fabric_find':
      names.push('native_fabric_find', 'mcp_fabric_find')
      break
    case 'fabric_use':
      names.push('native_fabric_use', 'mcp_fabric_use')
      break
    case 'agent_browser_find':
      names.push('native_agent_browser_find')
      break
    case 'agent_browser_use':
      names.push('native_agent_browser_use')
      break
    case 'subagent':
      names.push('call_subagent')
      break
    default:
      break
  }

  if (toolName && !names.includes(toolName)) {
    names.push(toolName)
  }

  return [...new Set(names)]
}

function getFirstSettingValue(
  agentSettings: any,
  globalSettings: any,
  prefix: string,
  lookupNames: string[]
): number | undefined {
  for (const lookupName of lookupNames) {
    const value = getSettingValue(agentSettings, globalSettings, `${prefix}_${lookupName}`)
    if (value !== undefined) return value
  }
  return undefined
}

function getFirstSettingBoolean(
  agentSettings: any,
  globalSettings: any,
  prefix: string,
  lookupNames: string[]
): boolean | undefined {
  for (const lookupName of lookupNames) {
    const value = getSettingBoolean(agentSettings, globalSettings, `${prefix}_${lookupName}`)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Get tool-specific buffer size and threshold settings
 * Resolution order:
 * 1. Custom tool settings (exact match)
 * 2. Granular tool settings (e.g., buffer_size_read_file)
 * 3. Category defaults
 * 4. All other tools fallback
 * 
 * @param toolName The name of the tool
 * @param agentSettings The agent's settings object
 * @returns Object with buffer_size and zip_threshold
 */
export function getToolSettings(
  toolName: string,
  agentSettings: any,
  globalSettings?: any,
  options: ToolSettingsOptions = {}
): { buffer_size: number; zip_threshold: number; auto_zip: boolean; zip_disabled: boolean } {
  const canonicalName = canonicalToolName(toolName)
  const lookupNames = getToolLookupNames(toolName)
  const primaryLookupName = lookupNames[0] || canonicalName
  const categoryName = getToolCategoryName(canonicalName)
  const isAllOtherTool = categoryName === null
  const defaultSettings = getCategoryDefault(canonicalName)
  const universalBuffer = getSettingValue(agentSettings, globalSettings, 'buffer_size')
  const universalThreshold = getSettingValue(agentSettings, globalSettings, 'zip_threshold')

  // 1. Check custom tool settings first (highest priority)
  const alternateNames = lookupNames.filter((name) => name !== primaryLookupName)

  const agentCustom = options.ignoreCustomToolSettings
    ? undefined
    : findCustomToolSetting(agentSettings?.custom_tool_settings, primaryLookupName, alternateNames)
  const globalCustom = options.ignoreCustomToolSettings
    ? undefined
    : findCustomToolSetting(globalSettings?.custom_tool_settings, primaryLookupName, alternateNames)
  const customBuffer = coerceNumber(agentCustom?.buffer_size) ?? coerceNumber(globalCustom?.buffer_size)
  const customThreshold =
    coerceNumber(agentCustom?.zip_threshold) ?? coerceNumber(globalCustom?.zip_threshold)
  const customAuto =
    typeof agentCustom?.auto_zip === 'boolean'
      ? agentCustom.auto_zip
      : typeof globalCustom?.auto_zip === 'boolean'
        ? globalCustom.auto_zip
        : undefined
  const customDisabled =
    typeof agentCustom?.zip_disabled === 'boolean'
      ? agentCustom.zip_disabled
      : typeof globalCustom?.zip_disabled === 'boolean'
        ? globalCustom.zip_disabled
        : undefined
  const toolSpecificAuto = getFirstSettingBoolean(agentSettings, globalSettings, 'auto_zip', lookupNames)
  const allOtherAuto = isAllOtherTool
    ? getSettingBoolean(agentSettings, globalSettings, 'auto_zip_all_other_tools')
    : undefined
  const autoZip = customAuto ?? toolSpecificAuto ?? allOtherAuto ?? defaultSettings.auto_zip ?? false
  const toolSpecificDisabled = getFirstSettingBoolean(agentSettings, globalSettings, 'zip_disabled', lookupNames)
  const allOtherDisabled = isAllOtherTool
    ? getSettingBoolean(agentSettings, globalSettings, 'zip_disabled_all_other_tools')
    : undefined
  const zipDisabled = customDisabled ?? toolSpecificDisabled ?? allOtherDisabled ?? false

  if (customBuffer !== undefined || customThreshold !== undefined) {
    return {
      buffer_size: customBuffer ?? defaultSettings.buffer_size,
      zip_threshold: customThreshold ?? defaultSettings.zip_threshold,
      auto_zip: zipDisabled ? false : autoZip,
      zip_disabled: zipDisabled
    }
  }
  
  // 2. Check granular tool-specific settings
  let toolSpecificBuffer = getFirstSettingValue(agentSettings, globalSettings, 'buffer_size', lookupNames)
  let toolSpecificThreshold = getFirstSettingValue(agentSettings, globalSettings, 'zip_threshold', lookupNames)

  if (toolSpecificBuffer === undefined && universalBuffer !== undefined) {
    toolSpecificBuffer = universalBuffer
  }
  if (toolSpecificThreshold === undefined && universalThreshold !== undefined) {
    toolSpecificThreshold = universalThreshold
  }

  if (primaryLookupName === 'subagent') {
    toolSpecificBuffer = toolSpecificBuffer ?? getSettingValue(agentSettings, globalSettings, 'buffer_size_subagent')
    toolSpecificThreshold = toolSpecificThreshold ?? getSettingValue(agentSettings, globalSettings, 'zip_threshold_subagent')
  }
  
  if (toolSpecificBuffer !== undefined || toolSpecificThreshold !== undefined) {
    return {
      buffer_size: toolSpecificBuffer ?? defaultSettings.buffer_size,
      zip_threshold: toolSpecificThreshold ?? defaultSettings.zip_threshold,
      auto_zip: zipDisabled ? false : autoZip,
      zip_disabled: zipDisabled
    }
  }
  
  // 3. Check category defaults
  if (categoryName) {
    // Check if user has overridden category settings
    const categoryBuffer = getSettingValue(agentSettings, globalSettings, `buffer_size_${categoryName}`)
    const categoryThreshold = getSettingValue(agentSettings, globalSettings, `zip_threshold_${categoryName}`)

    return {
      buffer_size: categoryBuffer ?? defaultSettings.buffer_size,
      zip_threshold: categoryThreshold ?? defaultSettings.zip_threshold,
      auto_zip: zipDisabled ? false : autoZip,
      zip_disabled: zipDisabled
    }
  }
  
  // 4. Check "all other tools" fallback
  const allOtherBuffer =
    getSettingValue(agentSettings, globalSettings, 'buffer_size_all_other_tools') ?? universalBuffer
  const allOtherThreshold =
    getSettingValue(agentSettings, globalSettings, 'zip_threshold_all_other_tools') ?? universalThreshold
  if (allOtherBuffer !== undefined || allOtherThreshold !== undefined) {
    return {
      buffer_size: allOtherBuffer ?? categoryDefaults.allOther.buffer_size,
      zip_threshold: allOtherThreshold ?? categoryDefaults.allOther.zip_threshold,
      auto_zip: zipDisabled ? false : autoZip,
      zip_disabled: zipDisabled
    }
  }

  // 5. Final fallback to defaults
  return {
    buffer_size: universalBuffer ?? categoryDefaults.allOther.buffer_size,
    zip_threshold: universalThreshold ?? categoryDefaults.allOther.zip_threshold,
    auto_zip: zipDisabled ? false : autoZip,
    zip_disabled: zipDisabled
  }
}

export function getTypeZipSettings(
  type: string,
  agentSettings?: any,
  globalSettings?: any,
  toolName?: string,
  options: ToolSettingsOptions = {}
): { bufferSize: number; zipThreshold: number; autoZip: boolean; zipDisabled: boolean } {
  const universalBuffer = getSettingValue(agentSettings, globalSettings, 'buffer_size')
  const universalThreshold = getSettingValue(agentSettings, globalSettings, 'zip_threshold')

  if (type === 'cool_tool') {
    const toolSettings = getToolSettings(toolName || '', agentSettings || {}, globalSettings, options)
    return {
      bufferSize: toolSettings.buffer_size,
      zipThreshold: toolSettings.zip_threshold,
      autoZip: toolSettings.auto_zip,
      zipDisabled: toolSettings.zip_disabled
    }
  }

  const defaults = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.all_other
  const bufferKey = `buffer_size_${type}`
  const thresholdKey = `zip_threshold_${type}`
  const autoZipKey = `auto_zip_${type}`

  const bufferFromSettings =
    getSettingValue(agentSettings, globalSettings, bufferKey) ?? universalBuffer
  const thresholdFromSettings =
    getSettingValue(agentSettings, globalSettings, thresholdKey) ?? universalThreshold
  const autoZipFromSettings = getSettingBoolean(agentSettings, globalSettings, autoZipKey)
  const zipDisabled = getSettingBoolean(agentSettings, globalSettings, `zip_disabled_${type}`) ?? false
  const autoZip = zipDisabled ? false : (autoZipFromSettings ?? defaults.auto_zip ?? false)

  if (bufferFromSettings !== undefined || thresholdFromSettings !== undefined) {
    return {
      bufferSize: bufferFromSettings ?? defaults.buffer_size,
      zipThreshold: thresholdFromSettings ?? defaults.zip_threshold,
      autoZip,
      zipDisabled
    }
  }

  // Fall back to universal buffer/threshold
  return {
    bufferSize: defaults.buffer_size ?? universalBuffer ?? UNIVERSAL_DEFAULT_BUFFER,
    zipThreshold: defaults.zip_threshold ?? universalThreshold ?? UNIVERSAL_DEFAULT_THRESHOLD,
    autoZip,
    zipDisabled
  }
}

/**
 * Detect language from file path for syntax highlighting
 */
export function detectLanguage(filePath?: string): string {
  if (!filePath) return 'plaintext'
  
  const ext = filePath.split('.').pop()?.toLowerCase()
  
  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    
    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'svelte': 'svelte',
    'vue': 'vue',
    
    // Data formats
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'xml': 'xml',
    
    // Programming languages
    'py': 'python',
    'rb': 'ruby',
    'php': 'php',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'swift': 'swift',
    'kt': 'kotlin',
    
    // Shell/Scripts
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'fish': 'bash',
    'ps1': 'powershell',
    'bat': 'batch',
    
    // Documentation
    'md': 'markdown',
    'mdx': 'markdown',
    'rst': 'restructuredtext',
    
    // Config files
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'env': 'bash',
    'gitignore': 'plaintext',
  }
  
  return languageMap[ext || ''] || 'plaintext'
}
