/**
 * BL-241: `/api/models` returns one row per catalog id (`canonicalId`), which is
 * what the Model Catalog Viewer keys its rows by. A bare model id is not unique
 * and is not merged on: Kimi K3 through Moonshot and through Qwen Cloud are both
 * `kimi-k3` but different rows, and folding them would be a guess about identity.
 */
import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '$lib/types/modelCatalog'
import { _mergeCatalogs } from './+server'

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
