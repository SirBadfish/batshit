import ollamaPackage from 'ollama-ai-provider-v2/package.json'
import type { LocalReasoningContract, LocalReasoningSnapshot, ReasoningControlIdentity, AgentReasoningOverrides } from '$lib/types/reasoningControls'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import { resolveRuntimeModelSelection, type RuntimeModelSelectionArgs } from '$lib/utils/modelPresetRuntime'
import { listLocalAiServers, resolveLocalAiRuntimeBaseUrl } from './localAiServers'
import { readLocalProgramApiKey } from './localProgramApiKeys'
import { localAiConnectionKey } from './localAiConnectionIdentity'

const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const validVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value)
const validModel = (value: string) => value.length > 0 && value.length <= 1024 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
export function isOllamaReasoningIdentity(identity: ReasoningControlIdentity): boolean {
  return identity.connection.type === 'direct' && identity.connection.id === 'direct:ollama' && identity.connection.service === 'ollama'
}
function unverified(modelId: string, reason: string, runtimeVersion?: string): LocalReasoningContract {
  return { version: 1, status: 'unverified', connectionId: 'direct:ollama', effectiveModelId: modelId,
    adapterVersion: ollamaPackage.version, checkedAt: new Date().toISOString(), ...(runtimeVersion ? { runtimeVersion } : {}), reason }
}

/** Consume only the boolean metadata contract. Raw show fields never leave this function. */
export function qualifyOllamaReasoningMetadata(modelId: string, version: unknown, show: unknown, adapterVersion = ollamaPackage.version): LocalReasoningContract {
  const unknown = (reason: string) => ({ ...unverified(modelId, reason, validVersion(version) ? version : undefined), adapterVersion })
  if (adapterVersion !== '4.0.1') return unknown('Thinking controls are not verified for this installed Ollama adapter.')
  if (!validModel(modelId) || !validVersion(version)) return unknown('The exact model and Ollama version could not be verified.')
  if (!object(show) || ['model', 'name'].some(key => show[key] !== undefined && show[key] !== modelId)) return unknown('The returned model metadata did not match the selected model.')
  const thinking = show.thinking
  if (!Array.isArray(show.capabilities) || !show.capabilities.every((value: unknown) => typeof value === 'string') || !show.capabilities.includes('thinking') ||
    !object(thinking) || !Array.isArray(thinking.values) || thinking.values.length !== 2 ||
    !thinking.values.every((value: unknown) => typeof value === 'boolean') || new Set(thinking.values).size !== 2 || typeof thinking.default !== 'boolean') {
    return unknown('Boolean Thinking options have not been verified for this model. Named levels are not mapped to On or Off.')
  }
  return { version: 1, status: 'verified', connectionId: 'direct:ollama', effectiveModelId: modelId,
    adapterVersion, runtimeVersion: version, checkedAt: new Date().toISOString(), thinking: { values: [false, true], default: thinking.default } }
}

/** One selected connection, one version read and one exact show. No context-cache invalidation. */
export async function readLocalModelReasoning(userId: string, identity: ReasoningControlIdentity, signal?: AbortSignal): Promise<LocalReasoningSnapshot> {
  const unknown = (reason: string): LocalReasoningSnapshot => ({ contract: unverified(identity.effectiveModelId, reason), connectionKey: '' })
  if (!isOllamaReasoningIdentity(identity) || !validModel(identity.effectiveModelId)) return unknown('Choose an exact Ollama model and connection.')
  if (ollamaPackage.version !== '4.0.1') return unknown('Thinking controls are not verified for this installed Ollama adapter.')
  try {
    const server = (await listLocalAiServers(userId)).find(entry => entry.id === 'ollama')
    if (!server?.enabled) return unknown('This saved Ollama connection is switched off or unavailable.')
    const baseUrl = (resolveLocalAiRuntimeBaseUrl(server.baseUrl) ?? server.baseUrl).replace(/\/+$/, '')
    const apiKey = await readLocalProgramApiKey('ollama', userId)
    const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(4_000)])
    const versionResponse = await fetch(`${baseUrl}/api/version`, { headers, signal: requestSignal, redirect: 'error' })
    if (!versionResponse.ok) return unknown('Ollama version could not be read. Your saved choice was kept.')
    const version = await versionResponse.json()
    if (!object(version) || !validVersion(version.version)) return unknown('Ollama version could not be verified. Your saved choice was kept.')
    const showResponse = await fetch(`${baseUrl}/api/show`, { method: 'POST', headers, signal: requestSignal, redirect: 'error',
      body: JSON.stringify({ model: identity.effectiveModelId, verbose: false }) })
    if (!showResponse.ok) return unknown('Thinking metadata could not be read. Your saved choice was kept.')
    const contract = qualifyOllamaReasoningMetadata(identity.effectiveModelId, object(version) ? version.version : undefined, await showResponse.json())
    return { contract, connectionKey: contract.status === 'verified' ? localAiConnectionKey(userId, 'ollama', { baseUrl, apiKey }) : '' }
  } catch {
    if (signal?.aborted) throw new DOMException('The model metadata read was stopped.', 'AbortError')
    return unknown('Thinking metadata could not be verified. Your saved choice was kept.')
  }
}

/** Only an explicit primary/current-model leaf needs fresh local evidence; inheritance is unchanged. */
export async function captureAgentLocalReasoning(userId: string, args: RuntimeModelSelectionArgs,
  overrides: AgentReasoningOverrides | null | undefined, signal?: AbortSignal): Promise<LocalReasoningSnapshot | undefined> {
  if (!overrides) return undefined
  const selected = resolveRuntimeModelSelection({ ...args, reasoningOverrides: undefined })
  const effectiveModelId = selected.effectiveModelId ?? selected.modelId
  if (!selected.connection || !effectiveModelId) return undefined
  const identity = { presetId: selected.presetId, connection: selected.connection, effectiveModelId }
  if (!isOllamaReasoningIdentity(identity) || overrides[reasoningOverrideKey(identity, 'thinking')] === undefined) return undefined
  return readLocalModelReasoning(userId, identity, signal)
}
