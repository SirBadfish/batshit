import { redis } from '$lib/server/redis'
import type { SavedModel } from '$lib/types/savedModels'
import { isChatgptPlanConnection } from '$lib/utils/chatgptPlanConnection'
import { withChatgptPlanPublishedMetadata } from '$lib/data/chatgpt-plan-published-metadata'
import { readCachedVercelModelCatalog, readCachedVercelModelCatalogStamp } from './vercelModelCatalog'
import {
  buildSavedModelCatalogLookup,
  gatewayListsCatalogRow,
  isGatewayCatalogPreset,
  type SavedModelCatalogLookup
} from './savedModelCatalogMatch'

export class RuntimeModelPresetError extends Error {
  readonly status: number
  readonly code: 'model_preset_missing' | 'model_preset_load_failed' | 'model_preset_unavailable'

  constructor(message: string, status: number, code: RuntimeModelPresetError['code']) {
    super(message)
    this.name = 'RuntimeModelPresetError'
    this.status = status
    this.code = code
  }
}

/**
 * The saved model preset a record names, read fresh on every run so an edit to the preset (its
 * connection, its settings) reaches every agent and Subagent that names it. A primary's model
 * resolves through it in `send-routed`, and an API Subagent's own model in
 * `subagentModelSelection.ts` (BL-266). No id means no preset; a missing or unreadable preset
 * fails loudly, never a quiet default. BL-517: an AI Gateway preset whose model the gateway no
 * longer lists is refused with that cause (the list load keeps such a preset and marks it
 * unavailable; it used to delete it).
 */
export async function loadRuntimeModelPreset(
  presetId: string | null | undefined,
  label: 'primary' | 'Subagent',
): Promise<SavedModel | null> {
  const normalized = typeof presetId === 'string' ? presetId.trim() : ''
  if (!normalized) {
    return null
  }

  let preset: SavedModel | null
  try {
    preset = (await redis.get(`model:${normalized}`)) as SavedModel | null
  } catch (error) {
    console.error(`[RuntimeModelPreset] Failed to load selected ${label} model preset:`, error)
    throw new RuntimeModelPresetError(
      `Failed to load selected ${label} model preset.`,
      500,
      'model_preset_load_failed',
    )
  }
  if (!preset) {
    throw new RuntimeModelPresetError(
      `Selected ${label} model preset no longer exists. Pick the model again in Agent settings.`,
      400,
      'model_preset_missing',
    )
  }
  if (isChatgptPlanConnection(preset.connection?.id) || preset.connection?.service === 'chatgpt-plan') {
    // Same effective capability rule as list/save; no read-time data backfill.
    return withChatgptPlanPublishedMetadata(preset)
  }
  if (isGatewayCatalogPreset(preset)) {
    await refuseUnlistedGatewayPreset(preset, label)
  }
  return preset
}

/**
 * The lookup built from the cached catalog, kept in this process while the cache's `fetchedAt`
 * stays the same, so a send does not rebuild it (about 3,000 rows) every time.
 */
let cachedCatalogLookup: { fetchedAt: string; lookup: SavedModelCatalogLookup } | null = null

async function readCachedCatalogLookup(): Promise<SavedModelCatalogLookup | null> {
  const stamp = await readCachedVercelModelCatalogStamp()
  if (stamp && cachedCatalogLookup?.fetchedAt === stamp) return cachedCatalogLookup.lookup
  const catalog = await readCachedVercelModelCatalog()
  if (!catalog) return null
  const lookup = buildSavedModelCatalogLookup(catalog.models)
  if (catalog.fetchedAt) cachedCatalogLookup = { fetchedAt: catalog.fetchedAt, lookup }
  return lookup
}

/**
 * BL-517: refuse a gateway catalog preset the gateway no longer lists, through the same lookup
 * the list load uses (a renamed or merged row is still found by its gateway variant). The check
 * reads the CACHED catalog only, whatever its age, and never the network, so a send never waits
 * on the registry (review). With no catalog cached, or a cache that cannot be read, the check
 * cannot run: the send goes on to the gateway with the model the preset names (no other model is
 * put in its place), the gateway answers for its own list, and the log says the check did not run.
 */
async function refuseUnlistedGatewayPreset(preset: SavedModel, label: 'primary' | 'Subagent'): Promise<void> {
  const model = preset.effectiveModelId || preset.vercelSourceId || preset.catalogModelId || preset.modelId
  let lookup: SavedModelCatalogLookup | null
  try {
    lookup = await readCachedCatalogLookup()
  } catch (error) {
    console.warn(
      `[RuntimeModelPreset] Could not read the cached model catalog to check that the AI Gateway still lists ${model}; sending without the check:`,
      error,
    )
    return
  }
  if (!lookup) {
    console.warn(
      `[RuntimeModelPreset] Did not check that the AI Gateway still lists ${model}: no model catalog is cached yet; sending without the check.`,
    )
    return
  }
  if (gatewayListsCatalogRow(lookup(preset))) return
  throw new RuntimeModelPresetError(
    `Vercel AI Gateway no longer lists ${model}, the model of the selected ${label} model preset "${preset.modelName}". Pick another model in Agent settings.`,
    400,
    'model_preset_unavailable',
  )
}
