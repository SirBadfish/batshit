import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { ModelReasoningDescriptor, ReasoningControlId, LocalReasoningContract } from '$lib/types/reasoningControls'
import { chatgptPlanAccountId } from '$lib/utils/chatgptPlanConnection'
import { CLAUDE_PLAN_EFFORT_SOURCE, CLAUDE_PLAN_REASONING_ADAPTER, CLAUDE_PLAN_THINKING_CONTROLS, CLAUDE_PLAN_THINKING_SOURCE, claudePlanEffortsFor, claudePlanModelChoice, isExactClaudePlanConnection } from '$lib/utils/claudePlanConnection'
import ollamaPackage from 'ollama-ai-provider-v2/package.json'
import openaiPackage from '@ai-sdk/openai/package.json'
import anthropicPackage from '@ai-sdk/anthropic/package.json'
import alibabaPackage from '@ai-sdk/alibaba/package.json'
import googlePackage from '@ai-sdk/google/package.json'
import { reviewedPublicReasoningFact } from './reviewed-public-reasoning-facts'
export { GPT61_SOL_REASONING_EFFORTS } from './reviewed-public-reasoning-facts'

/** A setting key followed by any owned nested object members, all reviewed locally. */
export type ReasoningSettingPath = readonly string[]
export interface ReviewedReasoningControlBinding {
  id: ReasoningControlId
  label: string
  setting: string
  aliases: readonly ReasoningSettingPath[]
  providerPath: readonly string[]
}
/** Executable mappings never come from remote catalog evidence. */
export interface ReviewedReasoningBinding {
  descriptor: ModelReasoningDescriptor
  adapter: { package: string; qualifiedVersion: string; endpoint: string }
  controls: readonly ReviewedReasoningControlBinding[]
}

const openaiControls: ReviewedReasoningControlBinding[] = [{ id: 'effort', label: 'Reasoning effort', setting: 'reasoningEffort',
  aliases: [['reasoningEffort'], ['openai.reasoningEffort']], providerPath: ['openai', 'reasoningEffort'] }]
const anthropicControls: ReviewedReasoningControlBinding[] = [
  { id: 'effort', label: 'Reasoning effort', setting: 'anthropicEffort',
    aliases: [['anthropicEffort'], ['anthropic.effort'], ['effort']], providerPath: ['anthropic', 'effort'] },
  { id: 'mode', label: 'Thinking mode', setting: 'thinkingMode',
    aliases: [['thinkingMode'], ['anthropic.thinking.type'], ['anthropic.thinking', 'type'], ['thinking', 'type']],
    providerPath: ['anthropic', 'thinking', 'type'] }
]
const googleControls: ReviewedReasoningControlBinding[] = [{ id: 'effort', label: 'Thinking level', setting: 'googleThinkingLevel',
  aliases: [['googleThinkingLevel'], ['google.thinkingConfig.thinkingLevel'], ['google.thinkingConfig', 'thinkingLevel'], ['thinkingConfig', 'thinkingLevel']],
  providerPath: ['google', 'thinkingConfig', 'thinkingLevel'] }]

const googleBudgetControls: ReviewedReasoningControlBinding[] = [{ id: 'budget', label: 'Thinking budget', setting: 'thinkingBudget',
  aliases: [['thinkingBudget'], ['google.thinkingConfig.thinkingBudget'], ['google.thinkingConfig', 'thinkingBudget'], ['thinkingConfig', 'thinkingBudget']],
  providerPath: ['google', 'thinkingConfig', 'thinkingBudget'] }]
const mimoControls: ReviewedReasoningControlBinding[] = [{ id: 'thinking', label: 'Thinking', setting: 'mimoThinking',
  aliases: [['mimoThinking']], providerPath: ['batshit_reasoning', 'mimoThinking'] }]
const qwenControls: ReviewedReasoningControlBinding[] = [{ id: 'effort', label: 'Reasoning effort', setting: 'qwenReasoningEffort',
  aliases: [['qwenReasoningEffort']], providerPath: ['batshit_reasoning', 'qwenEffort'] }]

export const REVIEWED_REASONING_SETTING_OWNERS: Readonly<Record<string, string>> = {
  anthropicEffort: 'anthropic', googleThinkingLevel: 'google', mimoThinking: 'mimo', qwenReasoningEffort: 'qwencloud'
}

/**
 * SA-139: the Claude plan's controls write its own preset settings (`anthropicEffort`, `claudePlanThinking`),
 * never the Anthropic API's keys. Its admission owner turns them into `--effort` and `alwaysThinkingEnabled`;
 * nothing goes into provider options.
 */
const claudePlanControls: ReviewedReasoningControlBinding[] = [
  { id: 'effort', label: 'Reasoning effort', setting: 'anthropicEffort', aliases: [['anthropicEffort']], providerPath: ['claudePlan', 'effort'] },
  { id: 'thinking', label: 'Thinking', setting: 'claudePlanThinking', aliases: [['claudePlanThinking']], providerPath: ['claudePlan', 'thinking'] }
]
function claudePlanBinding(modelId: string): ReviewedReasoningBinding | null {
  if (!claudePlanModelChoice(modelId)) return null
  const thinking = Object.hasOwn(CLAUDE_PLAN_THINKING_CONTROLS, modelId)
  return {
    descriptor: { version: 1, connection: 'claude-plan', effectiveModelId: modelId, endpoint: CLAUDE_PLAN_REASONING_ADAPTER,
      controls: [{ id: 'effort', kind: 'effort', values: [...claudePlanEffortsFor(modelId)] }, ...(thinking ? [{ id: 'thinking' as const, kind: 'toggle' as const }] : [])],
      evidence: [{ url: CLAUDE_PLAN_EFFORT_SOURCE.url, checkedAt: CLAUDE_PLAN_EFFORT_SOURCE.checkedOn }, { url: CLAUDE_PLAN_THINKING_SOURCE.url, checkedAt: CLAUDE_PLAN_THINKING_SOURCE.checkedOn }],
      lastVerified: CLAUDE_PLAN_EFFORT_SOURCE.checkedOn },
    // The qualified version is the server-owned managed pin (`MANAGED_CLI_PINNED_VERSIONS.claude`), which this
    // client-safe module cannot import; P2's executable binding refuses any other version before a run.
    adapter: { package: CLAUDE_PLAN_REASONING_ADAPTER, qualifiedVersion: 'managed-pin', endpoint: CLAUDE_PLAN_REASONING_ADAPTER },
    controls: thinking ? claudePlanControls : claudePlanControls.filter(control => control.id === 'effort')
  }
}

export function isOllamaReasoningConnection(connection: ModelConnectionInfo | null | undefined): boolean {
  return connection?.type === 'direct' && connection.id === 'direct:ollama' && connection.service === 'ollama'
}
const ollamaControls: ReviewedReasoningControlBinding[] = [{ id: 'thinking', label: 'Thinking', setting: 'ollamaThink',
  aliases: [['ollamaThink'], ['think'], ['ollama.think']], providerPath: ['ollama', 'think'] }]

export function reviewedReasoningBinding(args: {
  modelId?: string | null
  connection?: ModelConnectionInfo | null
  localReasoning?: LocalReasoningContract | null
}): ReviewedReasoningBinding | null {
  const connection = args.connection
  if (!args.modelId || connection?.type !== 'direct') return null
  if (isOllamaReasoningConnection(connection)) {
    const local = args.localReasoning
    if (!local || local.version !== 1 || local.status !== 'verified' || local.connectionId !== 'direct:ollama' ||
      local.effectiveModelId !== args.modelId || local.adapterVersion !== '4.0.1' || ollamaPackage.version !== '4.0.1' ||
      typeof local.runtimeVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(local.runtimeVersion) ||
      !Number.isFinite(Date.parse(local.checkedAt)) || !local.thinking || typeof local.thinking.default !== 'boolean' || !Array.isArray(local.thinking.values) ||
      local.thinking.values.length !== 2 || !local.thinking.values.includes(false) || !local.thinking.values.includes(true)) return null
    return { descriptor: { version: 1, connection: 'direct:ollama', effectiveModelId: args.modelId, endpoint: 'api/chat',
      controls: [{ id: 'thinking', kind: 'toggle', defaultValue: local.thinking.default }],
      evidence: [{ url: 'https://docs.ollama.com/api/show', checkedAt: local.checkedAt }], lastVerified: local.checkedAt },
      adapter: { package: 'ollama-ai-provider-v2', qualifiedVersion: '4.0.1', endpoint: 'api/chat' }, controls: ollamaControls }
  }
  if (isExactClaudePlanConnection(connection)) return claudePlanBinding(args.modelId)
  const plan = connection.service === 'chatgpt-plan' && Boolean(chatgptPlanAccountId(connection.id))
  const service = plan ? 'openai' : connection.service
  if (!service || !['openai', 'anthropic', 'google', 'mimo', 'qwencloud'].includes(service)) return null
  if (!plan && connection.id !== undefined && connection.id !== `direct:${service}`) return null
  const fact = reviewedPublicReasoningFact(`direct:${service}`, args.modelId)
  if (!fact) return null
  const installed = { openai: openaiPackage.version, anthropic: anthropicPackage.version, google: googlePackage.version, mimo: openaiPackage.version, qwencloud: alibabaPackage.version }[service]
  if (installed !== fact.sdk.version) return null
  return {
    descriptor: { ...fact.descriptor, ...(plan ? { connection: 'chatgpt-plan' } : {}) },
    adapter: { package: fact.sdk.id, qualifiedVersion: fact.sdk.version, endpoint: fact.descriptor.endpoint },
    controls: service === 'openai' ? openaiControls : service === 'anthropic' ? anthropicControls : service === 'mimo' ? mimoControls : service === 'qwencloud' ? qwenControls : fact.descriptor.controls.some(control => control.kind === 'budget') ? googleBudgetControls : googleControls
  }
}
