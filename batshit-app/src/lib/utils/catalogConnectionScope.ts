import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
import { resolveCatalogIds } from '$lib/utils/modelIdResolver'

export type ConnectionScopedCatalogModel = {
  catalogId: string
  developerId: string
  modelId: string
  effectiveModelId: string
  displayName: string
  model: CatalogModel
}

function normalizeScopeValue(value?: string | null): string {
  return value?.trim().toLowerCase() ?? ''
}

export function resolveConnectionScopedCatalogModel(
  model: CatalogModel,
  connection: CatalogConnectionOption | null
): ConnectionScopedCatalogModel {
  const resolvedIds = resolveCatalogIds({
    connectionId: connection?.id ?? null,
    connection,
    developerId: model.provider,
    modelId: model.name,
    idVariants: model.idVariants ?? null
  })

  return {
    catalogId: model.id,
    developerId: resolvedIds?.developerId ?? model.provider,
    modelId: resolvedIds?.modelId ?? model.name,
    effectiveModelId: resolvedIds?.effectiveModelId ?? model.name,
    displayName: model.displayName,
    model
  }
}

export function buildConnectionScopedCatalogModels(
  models: CatalogModel[],
  connection: CatalogConnectionOption | null
): ConnectionScopedCatalogModel[] {
  const unique = new Map<string, ConnectionScopedCatalogModel>()

  for (const model of models) {
    const scoped = resolveConnectionScopedCatalogModel(model, connection)
    const key = `${normalizeScopeValue(scoped.developerId)}::${normalizeScopeValue(
      scoped.effectiveModelId
    )}`
    if (!unique.has(key)) {
      unique.set(key, scoped)
    }
  }

  return Array.from(unique.values())
}
