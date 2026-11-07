/**
 * Dynamic MCP DCM Preview API
 * Returns the MCP portion of the Dynamic Current Message (DCM) plus token estimates.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { buildDynamicMcpIndex, ToolHintBudgetError } from '$lib/server/services/dynamicMcpIndex'
import { BROKER_RUNTIMES, DELEGATED_RUN_BROKER_SCOPE, type BrokerRuntime } from '$lib/utils/brokerAvailability'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import type { AgentDcmDisplaySettings } from '$lib/types/database'
import { redis } from '$lib/server/redis'

interface DcmPreviewRequest {
  agentId?: string
  subjectKind?: 'primary' | 'subagent'
  selectedGateways?: string[]
  toolSelections?: string[]
  selectedCliToolIds?: string[]
  projectPath?: string | null
  nativeDynamicMcpEnabled?: boolean | null
  nativeCliToolsEnabled?: boolean | null
  dcmDisplaySettings?: AgentDcmDisplaySettings
  /**
   * The Tool Grid preview selects the broker rules for the live API runtime.
   */
  runtime?: string | null
}

function normalizeBrokerRuntime(value: unknown): BrokerRuntime | undefined {
  return typeof value === 'string' && (BROKER_RUNTIMES as readonly string[]).includes(value)
    ? (value as BrokerRuntime)
    : undefined
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json()) as DcmPreviewRequest
    let primarySettingsActor = false
    let controlActorType: 'session' | undefined
    const ownedSubjectKind = body.subjectKind === undefined && body.agentId ? 'primary' : body.subjectKind
    if (ownedSubjectKind === 'primary' || ownedSubjectKind === 'subagent') {
      if (typeof body.agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.agentId)) return json({ error: 'Invalid preview subject.' }, { status: 400 })
      const key = `${ownedSubjectKind === 'primary' ? 'agent' : 'subagent'}:${body.agentId}`
      const row = await redis.get(key, { throwOnError: true }) as Record<string, unknown> | null
      if (!row || row.id !== body.agentId || row.user_id !== locals.user.id) return json({ error: 'Preview subject not found.' }, { status: 404 })
      // A preview is a user-owned read projection. This marker grants no runtime
      // actor/effect authority and is never accepted directly from request metadata.
      const supportedPrimary = ownedSubjectKind === 'primary' && normalizePrimaryAgentType(row) !== 'n8n'
      primarySettingsActor = body.subjectKind === 'primary' && supportedPrimary
      if (supportedPrimary) controlActorType = 'session'
    }

    const result = await buildDynamicMcpIndex({
      primarySettingsActor,
      controlActorType,
      ...(body.subjectKind === 'subagent' ? DELEGATED_RUN_BROKER_SCOPE : {}),
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
      runtime: normalizeBrokerRuntime(body.runtime)
    })

    return json(result)
  } catch (error) {
    if (error instanceof ToolHintBudgetError) return json({
      error: error.message, code: error.code, budgetTokens: error.budgetTokens,
      minimumRequiredTokens: error.minimumRequiredTokens
    }, { status: error.status })
    console.error('[Dynamic MCP DCM] Error building DCM preview:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to build DCM preview' },
      { status: 500 }
    )
  }
}
