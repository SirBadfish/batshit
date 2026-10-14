import type { AgentDcmDisplaySettings, MCPToolSelections } from '$lib/types/database'
import { diffAgentBlock, sameJsonValue, type AgentDcmDisplaySettingsSave } from '$lib/utils/agentBlockFieldSettings'

/**
 * BL-848, BL-855, the Agent Settings half: what the Primary Agent's Tool Grid save (the MCP
 * gateways, the tool selections, the display settings) and its zip save send.
 *
 * Agent Settings keeps each section as it was loaded or last saved. Other places change the same
 * record while that copy is on screen (the chat bar's Tools menu and Codex and Claude controls,
 * a second Settings window), and a save that sent the whole section took those changes back with
 * no word. So each save sends only what differs from the copy the section loaded or last saved,
 * the rule the chat bar's Tools menu follows (`MCPsDropdown.svelte`) and Agent Settings' basic
 * form since BL-514:
 * - the gateway list and the tool selections are each one value: whole, only when they differ;
 * - the display settings go through `diffAgentBlock`: only the map entries that differ, a removed
 *   one as `null`, and the server writes them entry by entry;
 * - every zip field is its own value; `custom_tool_settings` is one list, whole, only when a
 *   custom tool row differs.
 *
 * The Tool Grid half (`diffMcpSection`) is also the Subagent's (BL-914: `PUT /api/subagents/[id]`
 * writes `dcmDisplaySettings` entry by entry too); the Subagent Tool Grid card hides the zip
 * controls, so `diffZipPayload` is the Primary Agent's alone.
 */

/** One custom tool's zip overrides as a save names them. */
export type CustomToolPayload = {
  tool_name: string
  buffer_size?: number
  zip_threshold?: number
  auto_zip?: boolean
  zip_disabled?: boolean
}

/** Every zip field a Primary Agent save can name (`buildZipPayload` builds it). */
export interface ZipPayloadBody {
  zip_ai_view_mode?: 'inline' | 'appended' | null
  zip_tool_notes_enabled?: boolean | null
  buffer_size: number | null
  buffer_size_image: number | null
  buffer_size_error: number | null
  buffer_size_subagent: number | null
  buffer_size_read_file: number | null
  buffer_size_write_file: number | null
  buffer_size_edit_file: number | null
  buffer_size_execute_command: number | null
  buffer_size_list_files: number | null
  buffer_size_all_other_tools: number | null
  zip_threshold_error: number | null
  zip_threshold_image: number | null
  zip_threshold_subagent: number | null
  zip_threshold_read_file: number | null
  zip_threshold_write_file: number | null
  zip_threshold_edit_file: number | null
  zip_threshold_execute_command: number | null
  zip_threshold_list_files: number | null
  zip_threshold_all_other_tools: number | null
  auto_zip_error?: boolean | null
  auto_zip_image?: boolean | null
  auto_zip_subagent?: boolean | null
  auto_zip_read_file?: boolean | null
  auto_zip_write_file?: boolean | null
  auto_zip_edit_file?: boolean | null
  auto_zip_execute_command?: boolean | null
  auto_zip_list_files?: boolean | null
  auto_zip_all_other_tools?: boolean | null
  zip_disabled_error?: boolean | null
  zip_disabled_image?: boolean | null
  zip_disabled_subagent?: boolean | null
  zip_disabled_read_file?: boolean | null
  zip_disabled_write_file?: boolean | null
  zip_disabled_edit_file?: boolean | null
  zip_disabled_execute_command?: boolean | null
  zip_disabled_list_files?: boolean | null
  zip_disabled_all_other_tools?: boolean | null
  custom_tool_settings?: CustomToolPayload[] | null
}

/** The MCP section's values as the panel reads them from its forms (the Primary Agent's and the Subagent's Tool Grid). */
export interface McpPayloadBody {
  defaultMCPGateways: string[]
  defaultMCPToolSelections: MCPToolSelections
  dcmDisplaySettings: AgentDcmDisplaySettings
}

/**
 * The MCP section's values the save compares. `dcm` is `null` while only the older
 * `dcm_display_settings` name holds the agent's display settings: it has no `dcmDisplaySettings`
 * yet, so its first save writes the whole block and the older name's entries are not dropped.
 */
export interface McpSectionValues {
  gateways: string[]
  selections: MCPToolSelections
  dcm: AgentDcmDisplaySettings | null
}

/** What a save of the MCP section sends: only the parts that changed. */
export interface McpSectionSave {
  defaultMCPGateways?: string[]
  defaultMCPToolSelections?: MCPToolSelections
  dcmDisplaySettings?: AgentDcmDisplaySettingsSave | null
}

/** The gateway list and tool selections whole when they differ, the display settings entry by entry. */
export function diffMcpSection(baseline: McpSectionValues, next: McpSectionValues): McpSectionSave {
  const save: McpSectionSave = {}
  if (!sameJsonValue(baseline.gateways, next.gateways)) save.defaultMCPGateways = [...next.gateways]
  if (!sameJsonValue(baseline.selections, next.selections)) save.defaultMCPToolSelections = [...next.selections]
  const dcmChange = diffAgentBlock('dcmDisplaySettings', baseline.dcm, next.dcm)
  if (dcmChange !== undefined) save.dcmDisplaySettings = dcmChange
  return save
}

/** Custom tool rows in one order (by tool name), so a reordered list is not a change. */
function customToolsInOrder(tools: CustomToolPayload[] | null | undefined): CustomToolPayload[] {
  return [...(tools ?? [])].sort((left, right) => left.tool_name.localeCompare(right.tool_name))
}

/** A zip payload with its custom tools in one order: what the save compares and sends. */
export function zipPayloadForSave(payload: ZipPayloadBody): ZipPayloadBody {
  return { ...payload, custom_tool_settings: customToolsInOrder(payload.custom_tool_settings) }
}

/**
 * The zip fields of `next` (from `buildZipPayload`) that differ from `baseline`, the payload of
 * the copy the section loaded or last saved. Each field is compared on its own, `null` is a real
 * value (inherit) and a missing one counts as `null`. `custom_tool_settings` is one list: whole,
 * only when a row differs (a reorder is no change). An empty object means nothing to save.
 */
export function diffZipPayload(baseline: ZipPayloadBody, next: ZipPayloadBody): Partial<ZipPayloadBody> {
  const before = zipPayloadForSave(baseline) as unknown as Record<string, unknown>
  const after = zipPayloadForSave(next) as unknown as Record<string, unknown>
  const changes: Record<string, unknown> = {}
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameJsonValue(before[field] ?? null, after[field] ?? null)) changes[field] = after[field] ?? null
  }
  return changes as Partial<ZipPayloadBody>
}
