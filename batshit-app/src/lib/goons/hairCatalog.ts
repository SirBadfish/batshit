import {
  createHairState,
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
    !Array.isArray((payload as { refitSources?: unknown }).refitSources)
  ) {
    throw new Error('Hair catalog response is invalid.')
  }
  const responsePayload = payload as { assets: unknown[]; refitSources: unknown[] }
  const assets = await Promise.all(responsePayload.assets.map((asset) => verifyHairAsset(asset)))
  const refitSources = responsePayload.refitSources.map((source) => parseHairRefitSource(source))
  const identities = new Set(assets.map((asset) => `${asset.assetId}@${asset.revisionId}`))
  if (refitSources.some((source) => !identities.has(`${source.assetId}@${source.revisionId}`))) {
    throw new Error('Hair catalog contains an orphaned refit source.')
  }
  return { assets, refitSources }
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
  const fit = asset.attachment.fitReceipt
  if (
    fit.appearanceDefinitionSha256 !== source.definitionSha256 ||
    fit.physicalBasisSha256 !== source.physicalBasisSha256 ||
    fit.topologySha256 !== source.topologySha256 ||
    fit.skeletonHierarchySha256 !== source.skeletonHierarchySha256
  ) {
    return {
      status: 'stale-fit',
      selectable: false,
      label: 'Refit required',
      message: 'This style was fitted to an older head definition and must be refitted.'
    }
  }
  return { status: 'ready', selectable: true, label: 'Ready', message: null }
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
