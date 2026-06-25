export type RendererKeyInput = {
  intermediateStep?: any
  toolId?: string
  toolName?: string
  isPending?: boolean
}

// Build a stable key for tool renderers so they only reload when real inputs change
export function buildRendererKey({
  intermediateStep,
  toolId,
  toolName,
  isPending
}: RendererKeyInput): string {
  const step: any = intermediateStep || {}
  const callId = step.toolCallId || step.id || toolId || toolName
  const status = isPending ? 'pending' : step.error ? 'error' : 'ok'
  const rendererFamily = step.rendererFamily || step.metadata?.rendererFamily || ''
  const operationKind = step.operationKind || step.metadata?.operationKind || ''
  return `${status}|${callId || 'unknown'}|${rendererFamily}|${operationKind}`
}
