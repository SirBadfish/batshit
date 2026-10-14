import type { ModelConnectionInfo, SavedModel } from '$lib/types/savedModels'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import type { VercelCatalogEntry } from './vercelModelCatalog'

/** The AI Gateway's connection id in the catalog's `idVariants`. */
export const GATEWAY_CONNECTION_ID = 'vercel-gateway'

/**
 * BL-517: the short reason a picker shows beside a preset whose model the AI Gateway no longer
 * lists. It rides the saved-models list answer only (`SavedModel.unavailableReason`) and is never
 * stored.
 */
export const GATEWAY_UNLISTED_PRESET_REASON = 'Vercel AI Gateway no longer lists this model'

/** The catalog connection id a saved connection names (`direct:<service>` for a direct one). */
export function resolveCatalogConnectionId(connection: ModelConnectionInfo): string | null {
  const explicit = connection.id?.trim()
  if (explicit) return explicit
  if (connection.type === 'vercel-gateway') return GATEWAY_CONNECTION_ID
  if (connection.type === 'openrouter') return 'openrouter'
  const service = connection.service?.trim()
  return service ? `direct:${service}` : null
}

export type SavedModelCatalogLookup = (model: SavedModel) => VercelCatalogEntry | null

/**
 * The catalog row a saved preset belongs to: its catalog id (or gateway id, or developer/model)
 * as a row's id, canonical id, or developer/model; else (BL-68) that key as the exact variant id
 * of the preset's OWN connection, so a preset saved on a row that later merged into or was
 * renamed to another still finds its model. Built once per catalog, used by the saved-models
 * load (repair and availability) and by the send (`loadRuntimeModelPreset`).
 */
export function buildSavedModelCatalogLookup(entries: VercelCatalogEntry[]): SavedModelCatalogLookup {
  const catalogLookup = new Map<string, VercelCatalogEntry>()
  const variantLookup = new Map<string, VercelCatalogEntry>()
  for (const entry of entries) {
    const id = entry.id?.toLowerCase()
    if (id) catalogLookup.set(id, entry)
    const canonicalId = entry.canonicalId?.toLowerCase()
    if (canonicalId) catalogLookup.set(canonicalId, entry)
    const providerKey = entry.provider && entry.name ? `${entry.provider}/${entry.name}`.toLowerCase() : null
    if (providerKey) catalogLookup.set(providerKey, entry)
    for (const [variantConnectionId, variant] of Object.entries(entry.idVariants ?? {})) {
      const effectiveId = variant?.effectiveId?.toLowerCase()
      if (effectiveId) variantLookup.set(`${variantConnectionId}|${effectiveId}`, entry)
    }
  }

  return (model) => {
    const lookupKey =
      model.catalogModelId?.toLowerCase() ||
      model.vercelSourceId?.toLowerCase() ||
      (model.provider && model.modelId ? `${model.provider}/${model.modelId}`.toLowerCase() : null)
    if (!lookupKey) return null
    const connectionId = resolveCatalogConnectionId(resolveSavedModelConnection(model))
    return (
      catalogLookup.get(lookupKey) ??
      (connectionId ? variantLookup.get(`${connectionId}|${lookupKey}`) : undefined) ??
      null
    )
  }
}

/** A preset made from the AI Gateway's catalog (the only presets the old list load deleted). */
export function isGatewayCatalogPreset(model: SavedModel): boolean {
  return Boolean(model.isVercelImport && (model.vercelSourceId || model.catalogModelId))
}

/**
 * Whether the AI Gateway still lists a gateway catalog preset's model: the row the lookup found
 * carries a gateway variant (a row with no variants at all, from the instance's own gateway
 * fallback, counts when it came from the gateway).
 */
export function gatewayListsCatalogRow(entry: VercelCatalogEntry | null): boolean {
  if (!entry) return false
  if (entry.idVariants) return Boolean(entry.idVariants[GATEWAY_CONNECTION_ID])
  return entry.source === 'vercel'
}
