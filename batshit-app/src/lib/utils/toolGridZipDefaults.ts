import { SHARED_NON_MCP_TOOL_GRID_CONFIG } from '$lib/components/tools/toolGridConfig'

const TOOL_GRID_NUMERIC_DEFAULTS: Record<string, number> = {}
const TOOL_GRID_AUTO_ZIP_DEFAULTS: Record<string, boolean> = {}

for (const config of Object.values(SHARED_NON_MCP_TOOL_GRID_CONFIG)) {
  if (config.mode !== 'field') continue
  TOOL_GRID_NUMERIC_DEFAULTS[config.bufferField] = config.defaultBuffer
  TOOL_GRID_NUMERIC_DEFAULTS[config.thresholdField] = config.defaultThreshold
  TOOL_GRID_AUTO_ZIP_DEFAULTS[config.autoField] = config.defaultAutoZip
}

export function getToolGridDefaultNumber(field: string): number | undefined {
  return TOOL_GRID_NUMERIC_DEFAULTS[field]
}

export function getToolGridDefaultAutoZip(field: string): boolean | undefined {
  return TOOL_GRID_AUTO_ZIP_DEFAULTS[field]
}
