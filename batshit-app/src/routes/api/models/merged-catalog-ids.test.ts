/**
 * BL-241: `/api/models` returns one row per catalog id (`canonicalId`), which is
 * what the Model Catalog Viewer keys its rows by. A bare model id is not unique
 * and is not merged on: Kimi K3 through Moonshot and through Qwen Cloud are both
 * `kimi-k3` but different rows, and folding them would be a guess about identity.
 */
import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '$lib/types/modelCatalog'
import { _mergeCatalogs } from './+server'
import { buildCatalogFromSnapshot } from '$lib/server/services/modelCatalogSync'
import { resolveCatalogIds } from '$lib/utils/modelIdResolver'
import { resolveCatalogConnectionPricing } from '$lib/utils/catalogConnectionLimits'
import mistralCollision from '$lib/server/services/__fixtures__/mistral-catalog-collision.json'

function row(canonicalId: string, connectionId: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  const [provider, name] = canonicalId.split('/')
  return {
    id: name,
    canonicalId,
    provider,
    name,
    displayName: name,
    purpose: 'chat',
    source: 'vercel',
    transport: 'direct',
    connectionId,
    availableConnections: [connectionId],
    idVariants: { [connectionId]: { developerId: provider, modelId: name, effectiveId: name, source: 'direct' } },
    ...extra
  }
}

describe('BL-241 /api/models row identity', () => {
  it('keeps both Mistral selector rows and exact saved-preset targets after replay and actual models merging', () => {
    const models = _mergeCatalogs(buildCatalogFromSnapshot(mistralCollision).payload.models, [])
    expect(models).toHaveLength(mistralCollision.models.length)
    for (const original of mistralCollision.models) {
      const model = models.find(row => row.canonicalId === original.canonicalId)!
      expect(resolveCatalogIds({ connectionId: 'direct:mistral', developerId: model.provider, modelId: model.name, idVariants: model.idVariants })?.effectiveModelId)
        .toBe(original.idVariants['direct:mistral'].effectiveId)
      expect(resolveCatalogConnectionPricing(model, 'direct:mistral').pricing).toEqual(original.pricing)
    }
  })

  it('keeps same-identity reasoning facts while a supplemental row updates other fields', () => {
    const evidence: any = { lastGood: { version: 1, scope: 'public', support: 'supported', connection: 'direct:openai', effectiveModelId: 'exact-model',
      endpoint: 'responses', controls: [{ id: 'effort', kind: 'effort', values: ['low'] }],
      evidence: [{ url: 'https://developers.openai.com/api/docs/models/exact-model', checkedAt: '2026-10-14' }], lastVerified: '2026-10-14' },
      lastAttempt: { at: '2026-10-14T12:00:00Z', outcome: 'verified' } }
    const original = row('openai/exact-model', 'direct:openai')
    original.idVariants!['direct:openai'].reasoningEvidence = evidence
    const models = _mergeCatalogs([original], [row('openai/exact-model', 'direct:openai')])
    expect(models[0].idVariants!['direct:openai'].reasoningEvidence).toEqual(evidence)
    expect(models[0].features).toEqual(original.features)
  })
  it('keeps two rows that share a bare id, each once, with unique catalog ids', () => {
    const models = _mergeCatalogs(
      [row('moonshot/kimi-k3', 'direct:moonshot'), row('system/kimi-k3', 'direct:qwencloud')],
      []
    )
    expect(models.map((model) => model.canonicalId).sort()).toEqual(['moonshot/kimi-k3', 'system/kimi-k3'])
  })

  it('folds a local row with the same catalog id into the catalog row, so ids stay unique', () => {
    const models = _mergeCatalogs(
      [row('ollama/qwen3', 'direct:ollama')],
      [row('ollama/qwen3', 'direct:ollama', { source: 'local', transport: 'local' })]
    )
    expect(models).toHaveLength(1)
    const ids = models.map((model) => model.canonicalId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
