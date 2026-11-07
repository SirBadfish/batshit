import {
  createHairState,
  hairAssetMatchesRecipeFit,
  hairAssetStyleFitKey,
  parseHairRefitSource,
  parseHairState,
  verifyHairAsset,
  type HairAssetV1,
  type HairRefitSourceV1,
  type HairStateV2
} from './hairAssets'
import { HAIR_ROOT_WEIGHTED_MOTION_TAG } from './secondaryMotion'
import type { RecipeSourceIdentity } from './recipe/packageMetadata'

export type HairAssetAvailability =
  | { status: 'ready'; selectable: true; label: 'Ready'; message: null }
  | {
      status:
        | 'needs-recipe'
        | 'incompatible-base'
        | 'incompatible-fit'
        | 'stale-fit'
        | 'ambiguous-fit'
        | 'material-pending'
        | 'motion-upgrade-required'
      selectable: false
      label: string
      message: string
    }

export type HairSelectionCatalogStatus =
  | { status: 'none'; asset: null; message: null }
  | { status: 'ready'; asset: HairAssetV1; message: null }
  | { status: 'missing'; asset: null; message: string }
  | { status: 'stale-revision'; asset: HairAssetV1 | null; message: string }
  | { status: 'stale-fit'; asset: HairAssetV1; message: string }

export type HairAssetCatalog = {
  assets: HairAssetV1[]
  retainedBuiltinAssets: HairAssetV1[]
  refitSources: HairRefitSourceV1[]
}

export async function loadHairAssetCatalog(
  fetcher: typeof fetch = fetch
): Promise<HairAssetCatalog> {
  const response = await fetcher('/api/goons/hair-assets')
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `Hair catalog request failed (${response.status}).`
    throw new Error(error)
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { assets?: unknown }).assets) ||
    !Array.isArray((payload as { retainedBuiltinAssets?: unknown }).retainedBuiltinAssets) ||
    !Array.isArray((payload as { refitSources?: unknown }).refitSources)
  ) {
    throw new Error('Hair catalog response is invalid.')
  }
  const responsePayload = payload as {
    assets: unknown[]
    retainedBuiltinAssets: unknown[]
    refitSources: unknown[]
  }
  const [assets, retainedBuiltinAssets] = await Promise.all([
    Promise.all(responsePayload.assets.map((asset) => verifyHairAsset(asset))),
    Promise.all(responsePayload.retainedBuiltinAssets.map((asset) => verifyHairAsset(asset)))
  ])
  const refitSources = responsePayload.refitSources.map((source) => parseHairRefitSource(source))
  const identities = new Set<string>()
  const builtinCurrentFits = new Set<string>()
  const builtinStyles = new Set(assets.filter((asset) => asset.sourceClass === 'builtin').map((asset) => asset.assetId))
  for (const asset of assets.filter((entry) => entry.sourceClass === 'builtin')) {
    const key = hairAssetStyleFitKey(asset)
    if (builtinCurrentFits.has(key)) throw new Error('Hair catalog contains ambiguous current fits for one style.')
    builtinCurrentFits.add(key)
  }
  for (const asset of [...assets, ...retainedBuiltinAssets]) {
    const identity = `${asset.assetId}@${asset.revisionId}`
    if (identities.has(identity)) throw new Error('Hair catalog contains an ambiguous revision identity.')
    identities.add(identity)
    if (asset.sourceClass === 'user' && builtinStyles.has(asset.assetId)) {
      throw new Error('Hair catalog contains a user style that conflicts with a built-in style.')
    }
  }
  if (retainedBuiltinAssets.some((asset) => asset.sourceClass !== 'builtin' || !builtinStyles.has(asset.assetId))) {
    throw new Error('Hair catalog contains invalid retained built-in history.')
  }
  const selectableIdentities = new Set(assets.map((asset) => `${asset.assetId}@${asset.revisionId}`))
  if (refitSources.some((source) => !selectableIdentities.has(`${source.assetId}@${source.revisionId}`))) {
    throw new Error('Hair catalog contains an orphaned refit source.')
  }
  return { assets, retainedBuiltinAssets, refitSources }
}

export function resolveHairAssetBrowserUrl(ref: string, batshitServerUrl: string): string {
  return ref.startsWith('/uploads/')
    ? new URL(ref, `${batshitServerUrl.replace(/\/+$/, '')}/`).toString()
    : ref
}

export function classifyHairAssetAvailability(
  asset: HairAssetV1,
  source: RecipeSourceIdentity | null
): HairAssetAvailability {
  if (!source) {
    return {
      status: 'needs-recipe',
      selectable: false,
      label: 'Goon not ready',
      message: 'Finish preparing this Advanced/GLB Goon before choosing Hair.'
    }
  }
  if (asset.material.status !== 'ready') {
    return {
      status: 'material-pending',
      selectable: false,
      label: 'Material finishing',
      message: 'This style is still waiting for its neutral recolor material.'
    }
  }
  if (
    asset.physics.mode === 'secondary-motion/v1' &&
    !asset.display.tags.includes(HAIR_ROOT_WEIGHTED_MOTION_TAG)
  ) {
    return {
      status: 'motion-upgrade-required',
      selectable: false,
      label: 'Refit required',
      message: 'This imported revision uses the retired Hair motion model. Refit or re-import it.'
    }
  }
  if (asset.compatibility.baseId !== source.baseId) {
    return {
      status: 'incompatible-base',
      selectable: false,
      label: 'Different Goon base',
      message: 'This style was fitted for a different Goon base.'
    }
  }
  if (asset.compatibility.fitFamily !== source.fitFamily) {
    return {
      status: 'incompatible-fit',
      selectable: false,
      label: 'Refit required',
      message: 'This style needs a new fit for this Goon family.'
    }
  }
  if (!hairAssetMatchesRecipeFit(asset, source)) {
    return {
      status: 'stale-fit',
      selectable: false,
      label: 'Refit required',
      message: 'This style was fitted to an older head definition and must be refitted.'
    }
  }
  return { status: 'ready', selectable: true, label: 'Ready', message: null }
}

/** A single visible style card resolves only an exact compatible selectable fit. */
export function projectBuiltinHairStyleCards(
  assets: readonly HairAssetV1[], source: RecipeSourceIdentity | null
): Array<{ asset: HairAssetV1; availability: HairAssetAvailability }> {
  const groups = new Map<string, HairAssetV1[]>()
  for (const asset of assets) {
    if (asset.sourceClass !== 'builtin') continue
    const group = groups.get(asset.assetId) ?? []
    group.push(asset)
    groups.set(asset.assetId, group)
  }
  return [...groups.values()].map((group): { asset: HairAssetV1; availability: HairAssetAvailability } => {
    // Display fallback is deterministic and prefers the target's technical
    // family; it never grants selection without an exact fit.
    const ordered = [...group].sort((left, right) =>
      hairAssetStyleFitKey(left).localeCompare(hairAssetStyleFitKey(right)) || left.revisionId.localeCompare(right.revisionId))
    const compatible = source ? ordered.filter((asset) => hairAssetMatchesRecipeFit(asset, source)) : []
    if (compatible.length > 1) {
      return { asset: ordered[0]!, availability: {
        status: 'ambiguous-fit', selectable: false, label: 'Fit unavailable',
        message: 'More than one fit matches this Goon. The style cannot be selected until the catalog is corrected.'
      } }
    }
    const sameFamily = source && ordered.find((asset) => asset.compatibility.baseId === source.baseId && asset.compatibility.fitFamily === source.fitFamily)
    const sameBase = source && ordered.find((asset) => asset.compatibility.baseId === source.baseId)
    const asset = compatible[0] ?? sameFamily ?? sameBase ?? ordered[0]!
    return { asset, availability: classifyHairAssetAvailability(asset, source) }
  })
}

export function resolveHairSelectionCatalogStatus(
  stateValue: HairStateV2,
  assets: readonly HairAssetV1[]
): HairSelectionCatalogStatus {
  const state = parseHairState(stateValue)
  if (!state.selected) return { status: 'none', asset: null, message: null }
  const sameIdentity = assets.find(
    (asset) =>
      asset.assetId === state.selected?.assetId &&
      asset.revisionId === state.selected.assetRevisionId
  )
  if (!sameIdentity) {
    return {
      status: 'missing',
      asset: null,
      message: 'The saved Hair style is missing. Choose None or another compatible style before saving.'
    }
  }
  if (
    sameIdentity.revision !== state.selected.assetRevision ||
    sameIdentity.revisionSha256 !== state.selected.assetRevisionSha256
  ) {
    return {
      status: 'stale-revision',
      asset: sameIdentity,
      message: 'The saved Hair style no longer matches its exact catalog revision.'
    }
  }
  if (
    sameIdentity.compatibility.fitFamily !== state.selected.fitFamily ||
    sameIdentity.attachment.fitReceipt.fitSha256 !== state.selected.fitSha256
  ) {
    return {
      status: 'stale-fit',
      asset: sameIdentity,
      message: 'The saved Hair fit no longer matches this catalog revision.'
    }
  }
  return { status: 'ready', asset: sameIdentity, message: null }
}

export function createHairCatalogSelection(
  asset: HairAssetV1 | null,
  currentState?: HairStateV2 | null
): HairStateV2 {
  if (asset) return createHairState(asset)
  return createHairState(null, currentState
    ? {
        baseColor: currentState.baseColor,
        highlightColor: currentState.highlightColor
      }
    : undefined)
}

export function hairStateEquals(left: HairStateV2 | null, right: HairStateV2 | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
