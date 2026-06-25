import { MODE4_INTERNAL_HELPER_TOOL_SET } from './mode4InternalTools'

export const NATIVE_TOOL_NAMES = [
  'native_batshit_tool_search',
  'native_batshit_tool_use',
  'native_skill',
  'native_web_search',
  'native_bash_execute'
] as const

export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number]

export const INTERNAL_CONTROL_TOOL_PREFIXES = ['mcp_fabric_', 'mcp_artifact_'] as const

export function isNativeToolName(toolName: string | null | undefined): toolName is NativeToolName {
  if (!toolName) return false
  return (NATIVE_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isInternalControlToolName(toolName: string | null | undefined): boolean {
  if (!toolName) return false
  return INTERNAL_CONTROL_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
}

export function shouldHideInternalMcpTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false
  const normalized = toolName.trim()
  return (
    isInternalControlToolName(normalized) ||
    MODE4_INTERNAL_HELPER_TOOL_SET.has(normalized)
  )
}
