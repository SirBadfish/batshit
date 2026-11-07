import { describe, expect, it } from 'vitest'
import type { CatalogModel, CatalogReasoningEvidence } from '$lib/types/modelCatalog'
import {
  admitReviewedCatalogReasoningEvidence, assertCatalogReasoningConservation, mergeCatalogReasoningEvidence, projectCatalogReasoningEvidence,
  readCatalogReasoningEvidence, retainCatalogReasoningRows
} from './catalogReasoningEvidence'

const identity = { connectionId: 'direct:openai', effectiveId: 'exact-model' }
function evidence(): CatalogReasoningEvidence {
  return { lastGood: { version: 1, scope: 'public', support: 'supported', connection: identity.connectionId,
    effectiveModelId: identity.effectiveId, endpoint: 'responses', controls: [{ id: 'effort', kind: 'effort', values: ['low', 'high'], defaultValue: 'low' }],
    evidence: [{ url: 'https://developers.openai.com/api/docs/models/exact-model', checkedAt: '2026-10-14' }], lastVerified: '2026-10-14' },
    lastAttempt: { at: '2026-10-14T12:00:00Z', outcome: 'verified' } }
}
function row(value = evidence()): CatalogModel {
  return { id: 'openai/exact-model', provider: 'openai', name: 'exact-model', displayName: 'Exact model',
    connectionId: identity.connectionId, contextWindow: 32000, pricing: { input: 1, output: 2 },
    idVariants: { [identity.connectionId]: { developerId: 'openai', modelId: 'exact-model', effectiveId: 'exact-model', source: 'direct', reasoningEvidence: value } } }
}

describe('exact-connection reasoning evidence', () => {
  it('retains facts and the attempt when a fresh model list supplies no reasoning refresh', () => {
    const previous = evidence()
    expect(mergeCatalogReasoningEvidence(previous, undefined, identity)).toEqual(previous)
    const failed = mergeCatalogReasoningEvidence(previous, { lastAttempt: { at: '2026-10-14T13:00:00Z', outcome: 'unavailable' } }, identity)
    expect(failed?.lastGood).toEqual(previous.lastGood)
    expect(failed?.lastAttempt.outcome).toBe('unavailable')
    expect(previous.lastAttempt.outcome).toBe('verified')
    expect(mergeCatalogReasoningEvidence(undefined, failed, identity)).toEqual(failed)
  })

  it('holds changed defaults/removals as conflicts rather than rewriting last-good support', () => {
    for (const change of ['default', 'removal', 'unsupported']) {
      const previous = evidence(), next = evidence()
      next.lastAttempt.at = '2026-10-14T13:00:00Z'
      if (change === 'default') (next.lastGood!.controls[0] as any).defaultValue = 'high'
      if (change === 'removal') (next.lastGood!.controls[0] as any).values = ['low']
      if (change === 'unsupported') { next.lastGood!.controls = []; next.lastGood!.support = 'unsupported' }
      const merged = mergeCatalogReasoningEvidence(previous, next, identity)
      expect(merged?.lastGood).toEqual(previous.lastGood)
      expect(merged?.lastAttempt.outcome).toBe('conflict')
    }
  })

  it('distinguishes explicit unsupported, absent metadata and malformed input', () => {
    const unsupported = evidence(); unsupported.lastGood!.support = 'unsupported'; unsupported.lastGood!.controls = []
    expect(projectCatalogReasoningEvidence(row(unsupported), identity.connectionId, identity.effectiveId).status).toBe('unsupported')
    const absent = row(); delete absent.idVariants![identity.connectionId].reasoningEvidence
    expect(projectCatalogReasoningEvidence(absent, identity.connectionId, identity.effectiveId).status).toBe('unknown')
    const previous = evidence()
    const invalid = { ...evidence(), lastGood: { ...evidence().lastGood, controls: undefined } }
    const retained = mergeCatalogReasoningEvidence(previous, invalid, identity)
    expect(retained?.lastGood).toEqual(previous.lastGood)
    expect(retained?.lastAttempt.outcome).toBe('conflict')
    expect(() => mergeCatalogReasoningEvidence(invalid, undefined, identity)).toThrow(/malformed/)
    expect(() => mergeCatalogReasoningEvidence({ ...evidence(), version: 9 }, undefined, identity)).toThrow(/malformed/)
  })

  it('does not transfer facts by row/developer aliases, case folding or local/account identities', () => {
    expect(projectCatalogReasoningEvidence(row(), 'openrouter', identity.effectiveId).status).toBe('unknown')
    expect(projectCatalogReasoningEvidence(row(), identity.connectionId, 'EXACT-MODEL').status).toBe('unknown')
    for (const connectionId of ['direct:ollama', 'direct:chatgpt-plan:account-id', 'direct:custom-provider']) {
      expect(readCatalogReasoningEvidence(evidence(), { ...identity, connectionId })).toBeNull()
      expect(() => mergeCatalogReasoningEvidence(undefined, evidence(), { ...identity, connectionId })).toThrow(/Non-public/)
    }
    const executable = evidence(); (executable.lastGood as any).adapter = { setting: 'arbitrary-wire-field' }
    expect(readCatalogReasoningEvidence(executable, identity)).toBeNull()
  })

  it('rejects inapplicable per-kind fields while keeping explicit false and numeric zero', () => {
    for (const control of [
      { id: 'thinking', kind: 'toggle', defaultValue: false, values: { opaque: 'payload' } },
      { id: 'thinking', kind: 'toggle', min: { opaque: 'payload' } },
      { id: 'effort', kind: 'effort', values: ['low'], max: { opaque: 'payload' } },
      { id: 'mode', kind: 'mode', values: ['adaptive'], min: 0 },
      { id: 'budget', kind: 'budget', min: 0, defaultValue: 0, values: { opaque: 'payload' } }
    ]) {
      const invalid = evidence(); invalid.lastGood!.controls = [control as any]
      expect(readCatalogReasoningEvidence(invalid, identity)).toBeNull()
      expect(mergeCatalogReasoningEvidence(evidence(), invalid, identity)?.lastAttempt.outcome).toBe('conflict')
    }
    for (const control of [
      { id: 'thinking', kind: 'toggle', defaultValue: false },
      { id: 'budget', kind: 'budget', min: 0, max: 10, defaultValue: 0 }
    ]) {
      const valid = evidence(); valid.lastGood!.controls = [control as any]
      expect(readCatalogReasoningEvidence(valid, identity)?.lastGood?.controls).toEqual([control])
    }
  })

  it('validates explicit numeric budget specials and conserves their choices/defaults', () => {
    const old = evidence()
    old.lastGood!.controls = [{ id: 'budget', kind: 'budget', min: 512, max: 24576, specialValues: [-1, 0], defaultValue: 0 }]
    expect(readCatalogReasoningEvidence(old, identity)).toEqual(old)
    for (const specialValues of [[-1, -1], [NaN], [Infinity], [1.5], ['-1'], Array.from({ length: 17 }, (_, index) => index), [Number.MAX_SAFE_INTEGER + 1]]) {
      const invalid = structuredClone(old); (invalid.lastGood!.controls[0] as any).specialValues = specialValues
      expect(readCatalogReasoningEvidence(invalid, identity)).toBeNull()
    }
    for (const change of ['dynamic', 'off', 'default', 'range']) {
      const next = structuredClone(old)
      next.lastAttempt.at = '2026-10-14T13:00:00Z'
      const budget = next.lastGood!.controls[0]
      if (budget.kind !== 'budget') throw new Error('budget fixture')
      if (change === 'dynamic') budget.specialValues = [0]
      if (change === 'off') { budget.specialValues = [-1]; budget.defaultValue = -1 }
      if (change === 'default') budget.defaultValue = -1
      if (change === 'range') budget.min = 1024
      const retained = mergeCatalogReasoningEvidence(old, next, identity)
      expect(retained?.lastGood).toEqual(old.lastGood)
      expect(retained?.lastAttempt.outcome).toBe('conflict')
      expect(() => assertCatalogReasoningConservation([row(old)], [row(next)])).toThrow(/lost or changed/)
      expect(admitReviewedCatalogReasoningEvidence(old, next, identity)).toEqual(next)
    }
    const malformed = structuredClone(old); (malformed.lastGood!.controls[0] as any).min = -1
    expect(readCatalogReasoningEvidence(malformed, identity)).toBeNull()
    const unknownDefault = structuredClone(old); (unknownDefault.lastGood!.controls[0] as any).defaultValue = -2
    expect(readCatalogReasoningEvidence(unknownDefault, identity)).toBeNull()
  })

  it('keeps an evidence-bearing identity, price and limits through a raw gateway fallback', () => {
    const previous = row()
    const gateway: CatalogModel = { ...row(), connectionId: 'vercel-gateway', contextWindow: 100000,
      idVariants: { 'vercel-gateway': { developerId: 'openai', modelId: 'exact-model', effectiveId: 'openai/exact-model', source: 'vercel' } } }
    const kept = retainCatalogReasoningRows([previous], [gateway], { retainMissing: true })[0]
    expect(kept.contextWindow).toBe(100000)
    expect(kept.idVariants![identity.connectionId]).toMatchObject({ reasoningEvidence: evidence(), limits: { contextWindow: 32000, maxOutputTokens: null }, pricing: { input: 1, output: 2 } })
    expect(previous.idVariants![identity.connectionId]).not.toHaveProperty('limits')
    const missing = { ...gateway, id: 'unrelated', canonicalId: 'unrelated' }
    expect(retainCatalogReasoningRows([previous], [missing], { retainMissing: true })).toHaveLength(2)
  })

  it('retains ordinary exact variants only when missing-identity retention is requested', () => {
    const previous = row()
    delete previous.idVariants![identity.connectionId].reasoningEvidence
    const gateway: CatalogModel = { ...previous, connectionId: 'vercel-gateway', contextWindow: 100000,
      idVariants: { 'vercel-gateway': { developerId: 'openai', modelId: 'exact-model', effectiveId: 'openai/exact-model', source: 'vercel' } } }
    const kept = retainCatalogReasoningRows([previous], [gateway], { retainMissing: true })[0]
    expect(kept.idVariants![identity.connectionId]).toMatchObject({ effectiveId: 'exact-model', limits: { contextWindow: 32000, maxOutputTokens: null }, pricing: { input: 1, output: 2 } })
    expect(kept.idVariants![identity.connectionId]).not.toHaveProperty('reasoningEvidence')
    expect(previous.idVariants![identity.connectionId]).not.toHaveProperty('limits')
    expect(retainCatalogReasoningRows([previous], [gateway], { authoritative: true })[0].idVariants).not.toHaveProperty(identity.connectionId)
    const changed = structuredClone(gateway)
    changed.idVariants![identity.connectionId] = { ...previous.idVariants![identity.connectionId], effectiveId: 'different-model' }
    expect(() => retainCatalogReasoningRows([previous], [changed], { retainMissing: true })).toThrow(/replace.*identity/)
  })

  it('adopts reviewed newer defaults/removals only through explicit authoritative consumption', () => {
    const old = evidence(), next = evidence()
    next.lastAttempt.at = '2026-10-14T13:00:00Z'
    next.lastGood!.controls = [{ id: 'effort', kind: 'effort', values: ['high'], defaultValue: 'high' }]
    expect(mergeCatalogReasoningEvidence(old, next, identity)?.lastAttempt.outcome).toBe('conflict')
    expect(admitReviewedCatalogReasoningEvidence(old, next, identity)).toEqual(next)
    expect(retainCatalogReasoningRows([row(old)], [row(next)], { authoritative: true })[0].idVariants![identity.connectionId].reasoningEvidence).toEqual(next)
    next.lastAttempt.outcome = 'unavailable'
    expect(admitReviewedCatalogReasoningEvidence(old, next, identity)?.lastGood).toEqual(old.lastGood)
  })

  it('rejects a downstream fact loss even when the identity count is unchanged', () => {
    const previous = row(), next = row()
    delete next.idVariants![identity.connectionId].reasoningEvidence
    expect(() => assertCatalogReasoningConservation([previous], [next])).toThrow(/last-good reasoning evidence/)
    expect(() => assertCatalogReasoningConservation([previous], [previous])).not.toThrow()
    const malformed = row(); delete (malformed.idVariants![identity.connectionId].reasoningEvidence as any).lastAttempt
    expect(() => assertCatalogReasoningConservation([previous], [malformed])).toThrow(/Cannot publish malformed/)
  })
})
