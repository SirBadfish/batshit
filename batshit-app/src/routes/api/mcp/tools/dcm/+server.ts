/**
 * Dynamic MCP DCM Preview API
 * Returns the MCP portion of the Dynamic Current Message (DCM) plus token estimates.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { buildDynamicMcpIndex } from '$lib/server/services/dynamicMcpIndex'
import type { AgentDcmDisplaySettings } from '$lib/types/database'

interface DcmPreviewRequest {
  agentId?: string
  selectedGateways?: string[]
  toolSelections?: string[]
  selectedCliToolIds?: string[]
  projectPath?: string | null
  nativeDynamicMcpEnabled?: boolean | null
  nativeCliToolsEnabled?: boolean | null
  dcmDisplaySettings?: AgentDcmDisplaySettings
  isCodexMode?: boolean
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json()) as DcmPreviewRequest

    const result = await buildDynamicMcpIndex({
      userId: locals.user.id,
      agentId: body.agentId ?? null,
      selectedGateways: Array.isArray(body.selectedGateways) ? body.selectedGateways : undefined,
      toolSelections: Array.isArray(body.toolSelections) ? body.toolSelections : undefined,
      selectedCliToolIds:
        Array.isArray(body.selectedCliToolIds) ? body.selectedCliToolIds : undefined,
      projectPath:
        typeof body.projectPath === 'string' && body.projectPath.trim().length > 0
          ? body.projectPath.trim()
          : null,
      nativeDynamicMcpEnabled:
        typeof body.nativeDynamicMcpEnabled === 'boolean'
          ? body.nativeDynamicMcpEnabled
          : undefined,
      cliToolsEnabled:
        typeof body.nativeCliToolsEnabled === 'boolean'
          ? body.nativeCliToolsEnabled
          : undefined,
      dcmDisplaySettings: body.dcmDisplaySettings,
      isCodexMode: body.isCodexMode === true
    })

    return json(result)
  } catch (error) {
    console.error('[Dynamic MCP DCM] Error building DCM preview:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to build DCM preview' },
      { status: 500 }
    )
  }
}
