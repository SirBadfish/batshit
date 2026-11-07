/**
 * Browser RAM only. Never send or persist this identity: unlike a saved CLI
 * report key, it may include opaque provider settings already held in the agent form.
 */
export function buildContextPreviewIdentity(params: {
  agentId: string | null
  presetId?: string | null
  presetContextWindow?: number | null
  apiProvider?: string | null
  apiModelId?: string | null
  apiConnection?: unknown
  apiSettings?: unknown
  localConnectionRevision?: number
  agentZip: unknown
  globalZip: unknown
}) {
  return JSON.stringify({
    agentId: params.agentId,
    presetId: params.presetId,
    presetContextWindow: params.presetContextWindow,
    apiProvider: params.apiProvider,
    apiModelId: params.apiModelId,
    apiConnection: params.apiConnection,
    apiSettings: params.apiSettings,
    localConnectionRevision: params.localConnectionRevision,
    agentZip: params.agentZip,
    globalZip: params.globalZip
  })
}
