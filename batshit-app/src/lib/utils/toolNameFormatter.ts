import { slugToolName } from './toolNameNormalization'

const TOOL_DISPLAY_ALIASES: Record<string, string> = {
  batshit_server_read_file: 'Read File',
  read_file: 'Read File',
  batshit_server_write_file: 'Write File',
  batshit_server_overwrite_file: 'Write File',
  write_file: 'Write File',
  overwrite_file: 'Write File',
  batshit_server_edit_file: 'Edit File',
  edit_file: 'Edit File',
  batshit_server_list_files: 'List Files',
  list_files: 'List Files',
  batshit_server_search_files: 'Search Files',
  search_files: 'Search Files',

  batshit_server_execute_command: 'Bash',
  execute_command: 'Bash',
  batshit_server_run_bash_command: 'Bash',
  batshit_server_bash_execute: 'Bash',
  run_bash_command: 'Bash',
  native_bash_execute: 'Bash',
  bash_execute: 'Bash',
  bash: 'Bash',

  batshit_server_dynamic_mcp_find: 'Dynamic Tool Search',
  dynamic_mcp_find: 'Dynamic Tool Search',
  native_dynamic_mcp_find: 'Dynamic Tool Search',
  dynamic_find: 'Dynamic Tool Search',
  batshit_server_dynamic_mcp_use: 'MCP Tool',
  dynamic_mcp_use: 'MCP Tool',
  native_dynamic_mcp_use: 'MCP Tool',
  dynamic_use: 'MCP Tool',
  batshit_tool_search: 'Dynamic Tool Search',
  native_batshit_tool_search: 'Dynamic Tool Search',
  batshit_tool_use: 'Dynamic Tool Use',
  native_batshit_tool_use: 'Dynamic Tool Use',
  batshit_server_fetch_zip: 'Fetch Zip',
  fetch_zip: 'Fetch Zip',
  native_fetch_zip: 'Fetch Zip',
  batshit_server_cli_tool_find: 'Dynamic Tool Search',
  cli_tool_find: 'Dynamic Tool Search',
  native_cli_tool_find: 'Dynamic Tool Search',
  tool_find: 'Dynamic Tool Search',
  batshit_server_cli_tool_use: 'CLI Tool',
  cli_tool_use: 'CLI Tool',
  native_cli_tool_use: 'CLI Tool',
  cli_tool: 'CLI Tool',

  web_search: 'Web Search',
  native_web_search: 'Web Search',
  codex_web_search: 'Web Search',
  claude_web_search: 'Web Search',
  invoke_skill: 'Skill',
  native_skill: 'Skill Reference',
  native_skill_reference: 'Skill Reference',
  skill_reference: 'Skill Reference',
  skill_read: 'Skill Read',
  native_skill_script: 'Skill Script',
  skill_script: 'Skill Script',
  native_agent_browser_find: 'Dynamic Tool Search',
  agent_browser_find: 'Dynamic Tool Search',
  native_agent_browser_use: 'Agent Browser Action',
  agent_browser_use: 'Agent Browser Action',
  artifact_find: 'Dynamic Tool Search',
  native_artifact_find: 'Dynamic Tool Search',
  mcp_artifact_find: 'Dynamic Tool Search',
  artifact_use: 'Artifact Tool',
  native_artifact_use: 'Artifact Tool',
  mcp_artifact_use: 'Artifact Tool',
  native_fabric_find: 'Dynamic Tool Search',
  mcp_fabric_find: 'Dynamic Tool Search',
  fabric_find: 'Dynamic Tool Search',
  native_fabric_use: 'Fabric Control',
  mcp_fabric_use: 'Fabric Control',
  fabric_use: 'Fabric Control',
  runtime_addon_list: 'Runtime Add-on List',
  runtime_addon_status: 'Runtime Add-on Status',
  runtime_addon_prepare: 'Runtime Add-on Prepare',
  runtime_addon_start: 'Runtime Add-on Start',
  runtime_addon_stop: 'Runtime Add-on Stop',
  call_subagent: 'Subagent',
  subagent: 'Subagent',
  spawn_workers: 'Workers',
  native_spawn_workers: 'Workers',
  codex_plan_update: 'Plan Update'
}

const TOOL_DISPLAY_ALIAS_ENTRIES = Object.entries(TOOL_DISPLAY_ALIASES).sort(
  ([left], [right]) => right.length - left.length
)

const BATSHIT_TOOL_REF_FAMILIES = new Set(['mcp', 'cli', 'artifact', 'fabric', 'agent_browser'])

/**
 * Fabric control ids whose display name the derivation below gets WRONG.
 *
 * SA-118 Guard 2 emptied this table of everything it no longer had to carry. It used to hold
 * a row for every control of every registered family, because without one the formatter
 * returned null, null meant "not a Fabric control", and the call rendered as an untitled tool
 * card (and, since SA-116, a blank approval card). The `sys.*` fallback in
 * `formatBatshitToolTargetDisplayName` removes that failure mode, so seventeen rows that only
 * restated what `<prefix label> + <suffix words>` already derives were deleted — each one's
 * former string is pinned in `toolNameFormatter.test.ts`, captured before the deletion.
 *
 * What is left earns its place: a name the derivation cannot reach. Add a row only when the
 * derived name is wrong, never to make a new family visible — it already is.
 */
const FABRIC_CONTROL_DISPLAY_ALIASES: Record<string, string> = {
  // "Read", not "Get"; "Edit", not "Apply Patch"; the shorter word the cards use.
  'sys.artifact.get': 'Artifact Read',
  'sys.artifact.run_logs.list': 'Artifact Logs',
  'sys.artifact.run_logs.get': 'Artifact Logs',
  'sys.artifact.apply_patch': 'Artifact Edit',
  'sys.artifact.validate_structure': 'Artifact Validate',
  'sys.artifact.add_version': 'Artifact Version',
  'sys.artifact.delete_version': 'Artifact Version Delete',
  'sys.artifact.set_webhook': 'Artifact Webhook',
  'sys.artifact.set_zone': 'Artifact Zone',
  'sys.artifact.check_requirements': 'Artifact Requirements',
  // The product name is "Fetch Zip", not the derived "Zip Fetch".
  'sys.zip.fetch': 'Fetch Zip',
  // These two share their names with the broker helpers the user already knows.
  'sys.mcp.dynamic.find': 'Dynamic Tool Search',
  'sys.mcp.dynamic.use': 'MCP Tool',
  // SA-113's Agent DM family: the two whose derived names say the wrong thing.
  'sys.dm.list': 'Agent DM Inbox',
  'sys.dm.agents': 'Agent DM Presence',
  // SA-115's Schedules family: `formatControlWords` renders `update` as "Edit", which is
  // right for an artifact and wrong for a schedule.
  'sys.schedule.update': 'Schedule Update'
}

const FABRIC_CONTROL_PREFIX_LABELS: Record<string, string> = {
  'sys.artifact.': 'Artifact',
  'sys.model_catalog.': 'Model Catalog',
  'sys.cli_tool.': 'CLI Tool',
  'sys.skill.': 'Skill',
  'sys.runtime_addon.': 'Runtime Add-on',
  'sys.voice.engine.': 'Voice Engine',
  'sys.mcp.dynamic.': 'Dynamic Tool',
  // SA-116: the memory and Goon-scene families had no label at all, so every one of their
  // controls rendered as an untitled generic card — the same gap SA-113 and SA-115 hit. The
  // approval card is built from this name, so a missing entry is now a blank card too.
  'sys.memory.': 'Memory',
  'sys.goon_scene.': 'Goon Scene',
  'sys.comfyui.': 'ComfyUI',
  'sys.zip.': 'Zip',
  'sys.agent_browser.': 'Agent Browser',
  'sys.dm.': 'Agent DM',
  'sys.schedule.': 'Schedule'
}

function normalizeDisplayAliasKey(rawName: string): string {
  return slugToolName(rawName)
}

function resolveToolDisplayAlias(rawName: string): string | null {
  const normalizedName = normalizeDisplayAliasKey(rawName)
  if (!normalizedName) return null

  const directAlias = TOOL_DISPLAY_ALIASES[normalizedName]
  if (directAlias) return directAlias

  for (const [aliasKey, displayName] of TOOL_DISPLAY_ALIAS_ENTRIES) {
    if (normalizedName.endsWith(`_${aliasKey}`)) {
      return displayName
    }
  }

  return null
}

function extractTypedToolTarget(rawName: string): string {
  const trimmed = rawName.trim()
  const separatorIndex = trimmed.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return trimmed

  const family = trimmed.slice(0, separatorIndex).trim().toLowerCase()
  if (!BATSHIT_TOOL_REF_FAMILIES.has(family)) return trimmed
  return trimmed.slice(separatorIndex + 1).trim()
}

function formatControlWords(value: string): string {
  return value
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((segment) => {
      const lower = segment.toLowerCase()
      if (lower === 'ai') return 'AI'
      if (lower === 'api') return 'API'
      if (lower === 'cli') return 'CLI'
      if (lower === 'mcp') return 'MCP'
      if (lower === 'dm') return 'DM'
      if (lower === 'stt') return 'STT'
      if (lower === 'tts') return 'TTS'
      if (lower === 'url') return 'URL'
      if (lower === 'id') return 'ID'
      if (lower === 'logs') return 'Logs'
      if (lower === 'run') return 'Run'
      if (lower === 'runs') return 'Runs'
      if (lower === 'update') return 'Edit'
      if (lower === 'apply') return 'Apply'
      if (lower === 'patch') return 'Patch'
      return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase()
    })
    .join(' ')
}

export function formatBatshitToolTargetDisplayName(rawName: string | undefined): string | null {
  if (!rawName) return null

  const target = extractTypedToolTarget(rawName)
  if (!target) return null

  const normalizedTarget = target.trim().toLowerCase()
  if (!normalizedTarget) return null

  const directAlias = FABRIC_CONTROL_DISPLAY_ALIASES[normalizedTarget]
  if (directAlias) return directAlias

  if (normalizedTarget.startsWith('use.artifact.')) {
    return 'Artifact Run'
  }

  if (normalizedTarget.startsWith('artifact.') && normalizedTarget.includes('.field.')) {
    if (normalizedTarget.includes('.field.model.')) return 'Artifact Model'
    return 'Artifact Field'
  }

  for (const [prefix, label] of Object.entries(FABRIC_CONTROL_PREFIX_LABELS)) {
    if (!normalizedTarget.startsWith(prefix)) continue
    const suffix = normalizedTarget.slice(prefix.length)
    const readableSuffix = formatControlWords(suffix)
    return readableSuffix ? `${label} ${readableSuffix}` : label
  }

  // SA-118 Guard 2 (DL-118-11) — every `sys.<family>.<suffix>` id gets a name, registered or
  // not. Three consecutive stories added a family and hit the same wall: this function
  // returned null, null means "not a Fabric control", and the call rendered as an untitled
  // tool card — and since SA-116's approval card is built from this name, a BLANK card too,
  // all while the control worked perfectly on the wire. The tables above still exist for the
  // names the derivation gets WRONG ("Artifact Read", not "Artifact Get"); they are no
  // longer what stands between a new family and a nameless card.
  const systemControlMatch = /^sys\.([a-z0-9_]+)\.(.+)$/.exec(normalizedTarget)
  if (systemControlMatch) {
    const family = formatControlWords(systemControlMatch[1])
    const suffix = formatControlWords(systemControlMatch[2])
    const derived = [family, suffix].filter(Boolean).join(' ')
    if (derived) return derived
  }

  // Still null for anything that is not a `sys.*` control id — a `cli_tool:` id, an MCP tool,
  // a plain helper name. Callers read null as "use your own title", so widening it further
  // would rename cards that are correctly named today.
  return null
}

/**
 * Format tool names for UI display while preserving Batshit/n8n branding rules.
 *
 * Known first-party and native tool aliases render as current product labels.
 * Unknown tool names still fall back to readable title case.
 */
export function formatToolDisplayName(rawName: string | undefined): string {
  if (!rawName) return ''

  const batshitToolTargetAlias = formatBatshitToolTargetDisplayName(rawName)
  if (batshitToolTargetAlias) return batshitToolTargetAlias

  const alias = resolveToolDisplayAlias(rawName)
  if (alias) return alias

  const rawSegments = rawName.split(/[_\-\s]+/).filter(Boolean)
  const mergedSegments: string[] = []
  for (let i = 0; i < rawSegments.length; i += 1) {
    const current = rawSegments[i]
    const next = rawSegments[i + 1]
    const currentLower = current.toLowerCase()
    const nextLower = next?.toLowerCase()

    if (
      (currentLower === 'batshit' && nextLower === 'server') ||
      currentLower === 'batshitserver'
    ) {
      mergedSegments.push('batshit-server')
      if (currentLower === 'batshit' && nextLower === 'server') {
        i += 1
      }
      continue
    }

    mergedSegments.push(current)
  }

  const canonicalSegment = (segment: string): string => {
    const lower = segment.toLowerCase()
    if (lower === 'batshit') return 'batshit'
    if (lower === 'batshit-server') return 'batshit-server'
    if (lower === 'n8n') return 'n8n'
    if (lower === 'mcp') return 'MCP'
    if (lower === 'cli') return 'CLI'
    if (lower === 'api') return 'API'
    if (lower === 'url') return 'URL'
    if (lower === 'tts') return 'TTS'
    if (lower === 'stt') return 'STT'
    // Default: Title Case
    return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase()
  }

  return mergedSegments
    .map(canonicalSegment)
    .join(' ')
}

/**
 * Remove a gateway prefix from a tool name for display only.
 * We keep the original key for routing; this is just to avoid
 * UI clutter like `my_gateway_read_file`.
 */
export function stripGatewayPrefix(toolName: string, gatewayName?: string): string {
  if (!gatewayName) return toolName

  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9]+/g, '_')

  const gatewayPrefix = sanitize(gatewayName)
  const sanitizedTool = sanitize(toolName)

  if (sanitizedTool.toLowerCase().startsWith(`${gatewayPrefix.toLowerCase()}_`)) {
    const stripped = sanitizedTool.slice(gatewayPrefix.length + 1)
    return stripped || toolName
  }

  return toolName
}

/**
 * If a tool name was prefixed (e.g., gateway names) and ends with a known suffix,
 * return just the suffix portion.
 */
export function stripToSuffix(toolName: string, suffix: string): string {
  const idx = toolName.toLowerCase().lastIndexOf(suffix.toLowerCase())
  if (idx >= 0) {
    return toolName.slice(idx)
  }
  return toolName
}
