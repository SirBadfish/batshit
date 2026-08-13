import type { IconRef } from '$lib/icons/iconTypes'
import {
  ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS,
  FABRIC_TOOL_GRID_INFO_PARAGRAPHS
} from '$lib/utils/toolGridBrokerFamilies'

export type ToolGridAutoZipValue = 'inherit' | 'enabled' | 'disabled' | 'off'
export type ToolGridZipFallbackLabel = 'default' | 'inherit'

export function formatToolGridInheritedZipBehaviorLabel(
  autoZip: boolean | undefined,
  zipDisabled: boolean | undefined
): string {
  if (zipDisabled === true) return 'Off'
  return autoZip === true ? 'Auto' : 'Normal'
}

export function formatToolGridZipBehaviorLabel(
  value: ToolGridAutoZipValue | string | undefined,
  inheritedAutoZip: boolean | undefined,
  inheritedZipDisabled: boolean | undefined,
  fallbackLabel: ToolGridZipFallbackLabel = 'inherit'
): string {
  if (value === 'inherit' || value === '__inherit__') {
    const prefix = fallbackLabel === 'default' ? 'Default' : 'Inherit'
    return `${prefix} (${formatToolGridInheritedZipBehaviorLabel(inheritedAutoZip, inheritedZipDisabled)})`
  }
  if (value === 'enabled') return 'Auto'
  if (value === 'off') return 'Off'
  return 'Normal'
}

export type SharedNonMcpToolGridRowId =
  | 'image'
  | 'read_file'
  | 'search_files'
  | 'skill_read'
  | 'write_file'
  | 'edit_file'
  | 'bash'
  | 'list_files'
  | 'web_search'
  | 'fetch_zip'
  | 'dynamic_find'
  | 'tool_find'
  | 'artifact_find'
  | 'artifact_use'
  | 'fabric_find'
  | 'fabric_use'
  | 'agent_browser_actions'
  | 'subagent'
  | 'all_other_tools'

export const DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS = [
  "Dynamic Tool Search is Batshit's search-then-use path for tool families that would be too noisy to list in every prompt.",
  'When it is enabled, an agent can search enabled MCP tools, saved CLI Tools, published Artifact runtime tools, Fabric controls, and Agent Browser actions, then call the exact result it chooses.',
  'Those families still keep their own normal enablement and permission settings; this row controls the broker that lets the agent find them on demand.',
  'Schema Hints can also let agents use known tools directly when enough detail is available, but Batshit still validates permissions before anything runs.'
]

export const SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS: SharedNonMcpToolGridRowId[] = [
  'read_file',
  'skill_read',
  'write_file',
  'edit_file',
  'search_files',
  'list_files',
  'bash',
  'web_search',
  'fetch_zip',
  'subagent',
  'tool_find',
  'artifact_find',
  'fabric_find',
  'agent_browser_actions'
]

export const SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS: SharedNonMcpToolGridRowId[] = [
  'all_other_tools'
]

export type SharedFieldBackedNonMcpToolGridRowConfig = {
  id: SharedNonMcpToolGridRowId
  label: string
  iconRef: IconRef
  infoParagraphs?: string[]
  mode: 'field'
  bufferField: string
  thresholdField: string
  autoField: string
  minBuffer: number
  defaultBuffer: number
  defaultThreshold: number
  defaultAutoZip: boolean
}

export type SharedCustomNonMcpToolGridRowConfig = {
  id: SharedNonMcpToolGridRowId
  label: string
  iconRef: IconRef
  infoParagraphs?: string[]
  mode: 'custom'
  toolName: string
  minBuffer: number
  defaultBuffer: number
  defaultThreshold: number
  defaultAutoZip: boolean
}

export type SharedNonMcpToolGridRowConfig =
  | SharedFieldBackedNonMcpToolGridRowConfig
  | SharedCustomNonMcpToolGridRowConfig

export const SHARED_NON_MCP_TOOL_GRID_ROW_ORDER: SharedNonMcpToolGridRowId[] = [
  ...SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS,
  ...SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS
]

export const TOOL_GRID_BATSHIT_SECTION_ICON_REF: IconRef = { kind: 'batshit', id: 'core-basic' }
export const TOOL_GRID_OTHER_SECTION_ICON_REF: IconRef = { kind: 'lucide', id: 'grid-3x3' }
export const SHARED_NON_MCP_TOOL_GRID_CONFIG: Record<
  SharedNonMcpToolGridRowId,
  SharedNonMcpToolGridRowConfig
> = {
  image: {
    id: 'image',
    label: 'Image',
    iconRef: { kind: 'lucide', id: 'image' },
    mode: 'field',
    bufferField: 'buffer_size_image',
    thresholdField: 'zip_threshold_image',
    autoField: 'auto_zip_image',
    minBuffer: 0,
    defaultBuffer: 0,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  read_file: {
    id: 'read_file',
    label: 'Read File',
    iconRef: { kind: 'lucide', id: 'file-text' },
    mode: 'field',
    bufferField: 'buffer_size_read_file',
    thresholdField: 'zip_threshold_read_file',
    autoField: 'auto_zip_read_file',
    minBuffer: 1,
    defaultBuffer: 8,
    defaultThreshold: 0,
    defaultAutoZip: false
  },
  search_files: {
    id: 'search_files',
    label: 'Search Files',
    iconRef: { kind: 'lucide', id: 'search' },
    mode: 'custom',
    toolName: 'search_files',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  skill_read: {
    id: 'skill_read',
    label: 'Skill Read',
    iconRef: { kind: 'batshit', id: 'skills' },
    mode: 'custom',
    toolName: 'skill_read',
    minBuffer: 1,
    defaultBuffer: 10,
    defaultThreshold: 0,
    defaultAutoZip: false
  },
  write_file: {
    id: 'write_file',
    label: 'Write File',
    iconRef: { kind: 'lucide', id: 'file-code' },
    mode: 'field',
    bufferField: 'buffer_size_write_file',
    thresholdField: 'zip_threshold_write_file',
    autoField: 'auto_zip_write_file',
    minBuffer: 1,
    defaultBuffer: 2,
    defaultThreshold: 0,
    defaultAutoZip: false
  },
  edit_file: {
    id: 'edit_file',
    label: 'Edit File',
    iconRef: { kind: 'lucide', id: 'wand-sparkles' },
    mode: 'field',
    bufferField: 'buffer_size_edit_file',
    thresholdField: 'zip_threshold_edit_file',
    autoField: 'auto_zip_edit_file',
    minBuffer: 1,
    defaultBuffer: 2,
    defaultThreshold: 0,
    defaultAutoZip: false
  },
  bash: {
    id: 'bash',
    label: 'Bash',
    iconRef: { kind: 'brand', slug: 'gnubash-color' },
    mode: 'field',
    bufferField: 'buffer_size_execute_command',
    thresholdField: 'zip_threshold_execute_command',
    autoField: 'auto_zip_execute_command',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: false
  },
  list_files: {
    id: 'list_files',
    label: 'List Files',
    iconRef: { kind: 'lucide', id: 'folder-open' },
    mode: 'field',
    bufferField: 'buffer_size_list_files',
    thresholdField: 'zip_threshold_list_files',
    autoField: 'auto_zip_list_files',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  web_search: {
    id: 'web_search',
    label: 'Web Search',
    iconRef: { kind: 'lucide', id: 'globe' },
    mode: 'custom',
    toolName: 'web_search',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  fetch_zip: {
    id: 'fetch_zip',
    label: 'Fetch Zip',
    iconRef: { kind: 'batshit', id: 'zip' },
    mode: 'custom',
    toolName: 'fetch_zip',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: false
  },
  dynamic_find: {
    id: 'dynamic_find',
    label: 'Dynamic Tool Search',
    iconRef: { kind: 'lucide', id: 'plug-zap' },
    mode: 'custom',
    toolName: 'dynamic_find',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  tool_find: {
    id: 'tool_find',
    label: 'Dynamic Tool Search',
    iconRef: { kind: 'lucide', id: 'search' },
    infoParagraphs: DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS,
    mode: 'custom',
    toolName: 'tool_find',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  artifact_find: {
    id: 'artifact_find',
    label: 'Artifact Tools',
    iconRef: { kind: 'batshit', id: 'artifacts' },
    infoParagraphs: ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS,
    mode: 'custom',
    toolName: 'artifact_find',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  artifact_use: {
    id: 'artifact_use',
    label: 'Artifact Use',
    iconRef: { kind: 'batshit', id: 'artifacts' },
    mode: 'custom',
    toolName: 'artifact_use',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  fabric_find: {
    id: 'fabric_find',
    label: 'Fabric Controls',
    iconRef: { kind: 'batshit', id: 'fabric' },
    infoParagraphs: FABRIC_TOOL_GRID_INFO_PARAGRAPHS,
    mode: 'custom',
    toolName: 'fabric_find',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  fabric_use: {
    id: 'fabric_use',
    label: 'Fabric Use',
    iconRef: { kind: 'batshit', id: 'fabric' },
    mode: 'custom',
    toolName: 'fabric_use',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  agent_browser_actions: {
    id: 'agent_browser_actions',
    label: 'Agent Browser Actions',
    iconRef: { kind: 'lucide', id: 'monitor-play' },
    mode: 'custom',
    toolName: 'agent_browser_use',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  all_other_tools: {
    id: 'all_other_tools',
    label: 'All Other Tools',
    iconRef: { kind: 'lucide', id: 'wrench' },
    mode: 'field',
    bufferField: 'buffer_size_all_other_tools',
    thresholdField: 'zip_threshold_all_other_tools',
    autoField: 'auto_zip_all_other_tools',
    minBuffer: 1,
    defaultBuffer: 1,
    defaultThreshold: 0,
    defaultAutoZip: true
  },
  subagent: {
    id: 'subagent',
    label: 'Subagent Call',
    iconRef: { kind: 'batshit', id: 'subagents' },
    mode: 'field',
    bufferField: 'buffer_size_subagent',
    thresholdField: 'zip_threshold_subagent',
    autoField: 'auto_zip_subagent',
    minBuffer: 1,
    defaultBuffer: 2,
    defaultThreshold: 0,
    defaultAutoZip: false
  }
}

export const SHARED_NON_MCP_TOOL_GRID_ROWS: Array<{
  id: SharedNonMcpToolGridRowId
  label: string
  iconRef: IconRef
}> = SHARED_NON_MCP_TOOL_GRID_ROW_ORDER.map((id) => ({
  id,
  label: SHARED_NON_MCP_TOOL_GRID_CONFIG[id].label,
  iconRef: SHARED_NON_MCP_TOOL_GRID_CONFIG[id].iconRef
}))

export function isSharedNonMcpToolGridRowId(
  value: string
): value is SharedNonMcpToolGridRowId {
  return value in SHARED_NON_MCP_TOOL_GRID_CONFIG
}

export function getSharedNonMcpToolGridShareKey(
  rowId: SharedNonMcpToolGridRowId
): string {
  const config = SHARED_NON_MCP_TOOL_GRID_CONFIG[rowId]
  return config.mode === 'custom' ? config.toolName : rowId
}
