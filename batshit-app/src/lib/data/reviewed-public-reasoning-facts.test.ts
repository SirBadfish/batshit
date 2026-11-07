import { describe, expect, it } from 'vitest'
import { reviewedPublicReasoningEvidence, REVIEWED_OPENAI_REASONING_MODELS, REVIEWED_ANTHROPIC_REASONING_MODELS, REVIEWED_GOOGLE_REASONING_MODELS, REVIEWED_GOOGLE_BUDGET_MODELS, REVIEWED_MIMO_REASONING_MODELS, REVIEWED_QWEN_REASONING_MODELS } from './reviewed-public-reasoning-facts'
import { readCatalogReasoningEvidence } from '$lib/utils/catalogReasoningEvidence'

describe('reviewed public reasoning facts', () => {
  it('keeps every added fact exact and preserves unspecified defaults', () => {
    for (const [connection, models] of [['direct:openai', REVIEWED_OPENAI_REASONING_MODELS], ['direct:anthropic', REVIEWED_ANTHROPIC_REASONING_MODELS], ['direct:google', [...REVIEWED_GOOGLE_REASONING_MODELS, ...REVIEWED_GOOGLE_BUDGET_MODELS]], ['direct:mimo', REVIEWED_MIMO_REASONING_MODELS], ['direct:qwencloud', REVIEWED_QWEN_REASONING_MODELS]] as const) {
      for (const model of models) {
        const fact = reviewedPublicReasoningEvidence(connection, model)!
        expect(readCatalogReasoningEvidence(fact, { connectionId: connection, effectiveId: model })).toEqual(fact)
        expect(reviewedPublicReasoningEvidence(connection, `${model}-unreviewed`)).toBeUndefined()
      }
    }
    for (const [service, model] of [['mimo', 'mimo-v2.5'], ['qwencloud', 'glm-5.3']]) {
      expect(reviewedPublicReasoningEvidence(`direct:${service}`, model)?.lastGood?.controls[0]).not.toHaveProperty('defaultValue')
      expect(reviewedPublicReasoningEvidence(`direct:${service}_token_plan`, model)).toBeUndefined()
    }
    expect(reviewedPublicReasoningEvidence('direct:openai', 'gpt-6-astra')?.lastGood?.controls[0]).not.toHaveProperty('defaultValue')
  })
  it('publishes the exact reviewed API scope, without executable bindings or account scope', () => {
    const fact = reviewedPublicReasoningEvidence('direct:openai', 'gpt-6.1-sol')!
    expect(readCatalogReasoningEvidence(fact, { connectionId: 'direct:openai', effectiveId: 'gpt-6.1-sol' })).toEqual(fact)
    expect(fact.lastGood).toMatchObject({ endpoint: 'responses', scope: 'public', support: 'supported',
      controls: [{ id: 'effort', kind: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'], defaultValue: 'medium' }] })
    expect(fact).not.toHaveProperty('adapter')
    expect(fact.lastGood).not.toHaveProperty('setting')
    for (const connection of ['vercel-gateway', 'openrouter', 'chatgpt-plan', 'codex-cli', 'direct:custom']) {
      expect(reviewedPublicReasoningEvidence(connection, 'gpt-6.1-sol')).toBeUndefined()
    }
    expect(reviewedPublicReasoningEvidence('direct:openai', 'GPT-6.1-sol')).toBeUndefined()
    fact.lastGood!.controls.length = 0
    expect(reviewedPublicReasoningEvidence('direct:openai', 'gpt-6.1-sol')!.lastGood!.controls).toHaveLength(1)
  })
})
