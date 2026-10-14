/**
 * Browser RAM only. Never send or persist this identity: unlike a saved CLI
 * report key, it may include opaque overrides already held in the agent form.
 */
export function buildContextPreviewIdentity(params: {
  agentId: string | null
  isCodex: boolean
  codexContext: string | null
  codexModel?: string | null
  presetId?: string | null
  presetContextWindow?: number | null
  apiProvider?: string | null
  apiModelId?: string | null
  apiConnection?: unknown
  apiSettings?: unknown
  localConnectionRevision?: number
  claudeContextEnvironment?: unknown
  claudeContext: string | null
  codexOverrides?: unknown
  agentZip: unknown
  globalZip: unknown
}) {
  return JSON.stringify({
    agentId: params.agentId,
    codexContext: params.codexContext,
    codexModel: params.codexModel,
    presetId: params.presetId,
    presetContextWindow: params.presetContextWindow,
    apiProvider: params.apiProvider,
    apiModelId: params.apiModelId,
    apiConnection: params.apiConnection,
    apiSettings: params.apiSettings,
    localConnectionRevision: params.localConnectionRevision,
    claudeContextEnvironment: params.claudeContextEnvironment,
    claudeContext: params.claudeContext,
    codexOpaqueOverrides: params.isCodex && params.codexContext === null ? params.codexOverrides : undefined,
    agentZip: params.agentZip,
    globalZip: params.globalZip
  })
}
