import type { CatalogReasoningEvidence } from '$lib/types/modelCatalog'
import type { ModelReasoningDescriptor } from '$lib/types/reasoningControls'

export const GPT61_SOL_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Public facts only. Executable settings and adapter bindings stay in reasoning-controls.ts. */
export const GPT61_SOL_PUBLIC_REASONING_DESCRIPTOR: ModelReasoningDescriptor = {
  version: 1,
  connection: 'direct:openai',
  effectiveModelId: 'gpt-6.1-sol',
  endpoint: 'responses',
  controls: [{ id: 'effort', kind: 'effort', values: [...GPT61_SOL_REASONING_EFFORTS], defaultValue: 'medium' }],
  evidence: [{ url: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol', checkedAt: '2026-10-14' }],
  lastVerified: '2026-10-14'
}

type ReviewedFact = { descriptor: ModelReasoningDescriptor; sdk: { id: string; version: string } }
const checkedAt = '2026-10-14'
const anthropicEfforts = ['low', 'medium', 'high', 'xhigh', 'max']
export const REVIEWED_OPENAI_REASONING_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'] as const
export const REVIEWED_ANTHROPIC_REASONING_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-fable-5-1'] as const
export const REVIEWED_GOOGLE_BUDGET_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const
export const REVIEWED_MIMO_REASONING_MODELS = ['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-pro'] as const
export const REVIEWED_QWEN_REASONING_MODELS = ['glm-5.3'] as const
export const REVIEWED_GOOGLE_REASONING_MODELS = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash'] as const

const facts: ReviewedFact[] = [
  ...REVIEWED_GOOGLE_BUDGET_MODELS.map(id => ({
    descriptor: { version: 1 as const, connection: 'direct:google', effectiveModelId: id, endpoint: 'generateContent',
      controls: [{ id: 'budget' as const, kind: 'budget' as const,
        min: id === 'gemini-2.5-pro' ? 128 : id === 'gemini-2.5-flash-lite' ? 512 : 0,
        max: id === 'gemini-2.5-pro' ? 32768 : 24576,
        specialValues: id === 'gemini-2.5-flash-lite' ? [-1, 0] : [-1],
        defaultValue: id === 'gemini-2.5-flash-lite' ? 0 : -1 }],
      evidence: [{ url: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking', checkedAt }], lastVerified: checkedAt },
    sdk: { id: '@ai-sdk/google', version: '4.0.84' }
  })),
  ...REVIEWED_MIMO_REASONING_MODELS.map(id => ({
    descriptor: { version: 1 as const, connection: 'direct:mimo', effectiveModelId: id, endpoint: 'chat/completions',
      controls: [{ id: 'thinking' as const, kind: 'toggle' as const }],
      evidence: [
        ...(id === 'mimo-v2.6-pro' ? [] : [{ url: `https://mimo.mi.com/models/en-US/${id}`, checkedAt }]),
        { url: 'https://mimo.mi.com/docs/en-US/quick-start/usage-guide/other/deep-thinking', checkedAt }
      ], lastVerified: checkedAt }, sdk: { id: '@ai-sdk/openai', version: '4.0.79' }
  })),
  { descriptor: { version: 1, connection: 'direct:qwencloud', effectiveModelId: 'glm-5.3', endpoint: 'chat/completions',
    controls: [{ id: 'effort', kind: 'effort', values: ['low', 'high', 'max'] }],
    evidence: [{ url: 'https://www.alibabacloud.com/help/en/model-studio/glm', checkedAt }], lastVerified: checkedAt },
    sdk: { id: '@ai-sdk/alibaba', version: '2.0.57' } },
  { descriptor: GPT61_SOL_PUBLIC_REASONING_DESCRIPTOR, sdk: { id: '@ai-sdk/openai', version: '4.0.79' } },
  ...REVIEWED_OPENAI_REASONING_MODELS.filter(id => id !== 'gpt-6.1-sol').map(id => ({
    descriptor: { version: 1 as const, connection: 'direct:openai', effectiveModelId: id, endpoint: 'responses',
      controls: [{ id: 'effort' as const, kind: 'effort' as const,
        values: id === 'gpt-6-astra' ? [...GPT61_SOL_REASONING_EFFORTS] : ['none', ...GPT61_SOL_REASONING_EFFORTS],
        ...(id === 'gpt-6-astra' ? {} : { defaultValue: 'medium' }) }],
      evidence: [{ url: `https://developers.openai.com/api/docs/models/${id}`, checkedAt }], lastVerified: checkedAt },
    sdk: { id: '@ai-sdk/openai', version: '4.0.79' }
  })),
  ...REVIEWED_ANTHROPIC_REASONING_MODELS.map(id => ({
    descriptor: { version: 1 as const, connection: 'direct:anthropic', effectiveModelId: id, endpoint: 'messages',
      controls: [
        { id: 'effort' as const, kind: 'effort' as const, values: [...anthropicEfforts],
          defaultValue: id === 'claude-opus-5-5' || id === 'claude-haiku-5-5' ? 'medium' : 'high' },
        { id: 'mode' as const, kind: 'mode' as const,
          values: id === 'claude-sonnet-5-5' ? ['adaptive', 'between_tools'] : id === 'claude-haiku-5-5' ? ['adaptive', 'disabled'] : ['adaptive'],
          defaultValue: 'adaptive' }
      ], evidence: [
        { url: 'https://platform.claude.com/docs/en/build-with-claude/effort', checkedAt },
        { url: 'https://platform.claude.com/docs/en/build-with-claude/thinking', checkedAt }
      ], lastVerified: checkedAt }, sdk: { id: '@ai-sdk/anthropic', version: '4.0.67' }
  })),
  ...REVIEWED_GOOGLE_REASONING_MODELS.map(id => ({
    descriptor: { version: 1 as const, connection: 'direct:google', effectiveModelId: id, endpoint: 'generateContent',
      controls: [{ id: 'effort' as const, kind: 'effort' as const,
        values: id === 'gemini-3.6-flash' ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high'], defaultValue: 'medium' }],
      evidence: [{ url: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking', checkedAt }], lastVerified: checkedAt },
    sdk: { id: '@ai-sdk/google', version: '4.0.84' }
  }))
]

export function reviewedPublicReasoningFact(connectionId: string, effectiveId: string): ReviewedFact | undefined {
  const fact = facts.find(fact => fact.descriptor.connection === connectionId && fact.descriptor.effectiveModelId === effectiveId)
  return fact ? structuredClone(fact) : undefined
}

/** An exact reviewed producer input; a sync never advances its verification dates. */
export function reviewedPublicReasoningEvidence(connectionId: string, effectiveId: string): CatalogReasoningEvidence | undefined {
  const fact = reviewedPublicReasoningFact(connectionId, effectiveId)
  if (!fact) return undefined
  return {
    lastGood: {
      ...fact.descriptor,
      scope: 'public', support: 'supported',
      runtime: fact.sdk
    },
    lastAttempt: { at: '2026-10-14', outcome: 'verified' }
  }
}
