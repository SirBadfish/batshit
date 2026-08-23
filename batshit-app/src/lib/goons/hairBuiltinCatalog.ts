import {
  createHairState,
  parseHairState,
  verifyHairAsset,
  type HairAssetSelectionV1,
  type HairAssetV1,
  type HairStateV2
} from './hairAssets'
import { requireLowercaseSha256 } from './recipe/recipeCanonical'
import { HAIR_ROOT_WEIGHTED_MOTION_TAG } from './secondaryMotion'

export const HAIR_BUILTIN_CATALOG_CONTRACT = 'hair-catalog/v2' as const

export type HairBuiltinRevisionRefV2 = {
  assetId: string
  revisionId: string
  revision: number
  revisionSha256: string
}

export type HairBuiltinSuccessorEdgeV2 = {
  from: HairBuiltinRevisionRefV2
  to: HairBuiltinRevisionRefV2
}

export type HairBuiltinCatalogV2 = {
  schemaVersion: typeof HAIR_BUILTIN_CATALOG_CONTRACT
  assets: HairAssetV1[]
  currentRevisions: HairBuiltinRevisionRefV2[]
  successorEdges: HairBuiltinSuccessorEdgeV2[]
}

export type HairBuiltinCatalogErrorCode =
  | 'INVALID_CATALOG'
  | 'UNKNOWN_BUILTIN_SELECTION'
  | 'TAMPERED_BUILTIN_SELECTION'
  | 'MISSING_SUCCESSOR'
  | 'INCOMPATIBLE_SUCCESSOR'

export class HairBuiltinCatalogError extends Error {
  constructor(
    readonly code: HairBuiltinCatalogErrorCode,
    message: string
  ) {
    super(`[${HAIR_BUILTIN_CATALOG_CONTRACT}] ${message}`)
    this.name = 'HairBuiltinCatalogError'
  }
}

export type HairBuiltinStateMigration =
  | {
      status: 'none' | 'user-selection' | 'current'
      state: HairStateV2
      sourceAsset: HairAssetV1 | null
      targetAsset: HairAssetV1 | null
      path: HairBuiltinRevisionRefV2[]
    }
  | {
      status: 'migrated'
      state: HairStateV2
      sourceAsset: HairAssetV1
      targetAsset: HairAssetV1
      path: HairBuiltinRevisionRefV2[]
    }

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function invalid(message: string): never {
  throw new HairBuiltinCatalogError('INVALID_CATALOG', message)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${context} must be an object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${context} must be a plain object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${context} must contain exactly: ${wanted.join(', ')}.`)
  }
}

function stableId(value: unknown, context: string): string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
    invalid(`${context} must be a stable id.`)
  }
  return value
}

function positiveInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalid(`${context} must be a positive integer.`)
  }
  return value
}

function revisionRef(value: unknown, context: string): HairBuiltinRevisionRefV2 {
  const raw = record(value, context)
  exactKeys(raw, ['assetId', 'revisionId', 'revision', 'revisionSha256'], context)
  let revisionSha256: string
  try {
    revisionSha256 = requireLowercaseSha256(raw.revisionSha256, `${context}.revisionSha256`)
  } catch (error) {
    invalid(error instanceof Error ? error.message : `${context}.revisionSha256 is invalid.`)
  }
  return {
    assetId: stableId(raw.assetId, `${context}.assetId`),
    revisionId: stableId(raw.revisionId, `${context}.revisionId`),
    revision: positiveInteger(raw.revision, `${context}.revision`),
    revisionSha256
  }
}

export function hairBuiltinRevisionRef(asset: HairAssetV1): HairBuiltinRevisionRefV2 {
  return {
    assetId: asset.assetId,
    revisionId: asset.revisionId,
    revision: asset.revision,
    revisionSha256: asset.revisionSha256
  }
}

function revisionKey(value: HairBuiltinRevisionRefV2): string {
  return `${value.assetId}@${value.revisionId}#${value.revision}:${value.revisionSha256}`
}

function assetIdentityKey(asset: HairAssetV1): string {
  return `${asset.assetId}@${asset.revisionId}`
}

function refMatchesAsset(ref: HairBuiltinRevisionRefV2, asset: HairAssetV1): boolean {
  return (
    ref.assetId === asset.assetId &&
    ref.revisionId === asset.revisionId &&
    ref.revision === asset.revision &&
    ref.revisionSha256 === asset.revisionSha256
  )
}

function selectionMatchesAsset(selection: HairAssetSelectionV1, asset: HairAssetV1): boolean {
  return (
    selection.assetId === asset.assetId &&
    selection.assetRevisionId === asset.revisionId &&
    selection.assetRevision === asset.revision &&
    selection.assetRevisionSha256 === asset.revisionSha256 &&
    selection.fitFamily === asset.compatibility.fitFamily &&
    selection.fitSha256 === asset.attachment.fitReceipt.fitSha256
  )
}

function requireSorted<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) >= key(values[index]!)) {
      invalid(`${context} must be unique and sorted.`)
    }
  }
}

export async function parseHairBuiltinCatalog(value: unknown): Promise<HairBuiltinCatalogV2> {
  const raw = record(value, 'catalog')
  exactKeys(raw, ['schemaVersion', 'assets', 'currentRevisions', 'successorEdges'], 'catalog')
  if (raw.schemaVersion !== HAIR_BUILTIN_CATALOG_CONTRACT) {
    invalid(`catalog.schemaVersion must equal ${HAIR_BUILTIN_CATALOG_CONTRACT}.`)
  }
  if (!Array.isArray(raw.assets) || raw.assets.length === 0) {
    invalid('catalog.assets must be a non-empty array.')
  }
  if (!Array.isArray(raw.currentRevisions) || raw.currentRevisions.length === 0) {
    invalid('catalog.currentRevisions must be a non-empty array.')
  }
  if (!Array.isArray(raw.successorEdges)) {
    invalid('catalog.successorEdges must be an array.')
  }

  let assets: HairAssetV1[]
  try {
    assets = await Promise.all(raw.assets.map((asset) => verifyHairAsset(asset)))
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'catalog.assets contain an invalid revision.')
  }
  if (
    assets.some(
      (asset) =>
        asset.sourceClass !== 'builtin' ||
        !asset.provenance.catalogEligible ||
        !asset.provenance.productExportApproved
    )
  ) {
    invalid('catalog assets must be approved built-in product revisions.')
  }
  requireSorted(
    assets,
    (asset) => `${asset.assetId}\u0000${String(asset.revision).padStart(12, '0')}\u0000${asset.revisionId}`,
    'catalog.assets'
  )

  const identityMap = new Map<string, HairAssetV1>()
  const revisionNumberKeys = new Set<string>()
  for (const asset of assets) {
    const identity = assetIdentityKey(asset)
    if (identityMap.has(identity)) invalid(`catalog contains duplicate revision ${identity}.`)
    identityMap.set(identity, asset)
    const numberKey = `${asset.assetId}#${asset.revision}`
    if (revisionNumberKeys.has(numberKey)) {
      invalid(`catalog contains duplicate revision number ${asset.assetId}#${asset.revision}.`)
    }
    revisionNumberKeys.add(numberKey)
  }

  const currentRevisions = raw.currentRevisions.map((entry, index) =>
    revisionRef(entry, `catalog.currentRevisions[${index}]`)
  )
  requireSorted(currentRevisions, (entry) => entry.assetId, 'catalog.currentRevisions')
  const assetIds = new Set(assets.map((asset) => asset.assetId))
  if (currentRevisions.length !== assetIds.size) {
    invalid('catalog must declare exactly one current revision for every built-in style.')
  }
  const currentByAssetId = new Map<string, HairAssetV1>()
  for (const ref of currentRevisions) {
    const asset = identityMap.get(`${ref.assetId}@${ref.revisionId}`)
    if (!asset || !refMatchesAsset(ref, asset)) {
      invalid(`current revision ${revisionKey(ref)} does not match an immutable catalog asset.`)
    }
    if (currentByAssetId.has(ref.assetId)) {
      invalid(`catalog declares more than one current revision for ${ref.assetId}.`)
    }
    currentByAssetId.set(ref.assetId, asset)
  }
  for (const assetId of assetIds) {
    if (!currentByAssetId.has(assetId)) {
      invalid(`catalog has no current revision for ${assetId}.`)
    }
  }

  const successorEdges = raw.successorEdges.map((entry, index) => {
    const edge = record(entry, `catalog.successorEdges[${index}]`)
    exactKeys(edge, ['from', 'to'], `catalog.successorEdges[${index}]`)
    return {
      from: revisionRef(edge.from, `catalog.successorEdges[${index}].from`),
      to: revisionRef(edge.to, `catalog.successorEdges[${index}].to`)
    }
  })
  requireSorted(successorEdges, (edge) => revisionKey(edge.from), 'catalog.successorEdges')

  const successorBySource = new Map<string, HairBuiltinSuccessorEdgeV2>()
  for (const edge of successorEdges) {
    const fromAsset = identityMap.get(`${edge.from.assetId}@${edge.from.revisionId}`)
    const toAsset = identityMap.get(`${edge.to.assetId}@${edge.to.revisionId}`)
    if (!fromAsset || !refMatchesAsset(edge.from, fromAsset)) {
      invalid(`successor source ${revisionKey(edge.from)} does not match an immutable catalog asset.`)
    }
    if (!toAsset || !refMatchesAsset(edge.to, toAsset)) {
      invalid(`successor target ${revisionKey(edge.to)} does not match an immutable catalog asset.`)
    }
    if (edge.from.assetId !== edge.to.assetId) {
      invalid('successor edges cannot change the built-in style id.')
    }
    if (edge.to.revision <= edge.from.revision) {
      invalid(`successor edge for ${edge.from.assetId} must advance the revision number.`)
    }
    const fromKey = revisionKey(edge.from)
    if (successorBySource.has(fromKey)) {
      invalid(`catalog declares ambiguous successors for ${fromKey}.`)
    }
    successorBySource.set(fromKey, edge)
  }

  for (const asset of assets) {
    const ref = hairBuiltinRevisionRef(asset)
    const key = revisionKey(ref)
    const current = currentByAssetId.get(asset.assetId)!
    if (asset === current) {
      if (successorBySource.has(key)) {
        invalid(`current revision ${key} cannot declare a successor.`)
      }
      continue
    }
    if (!successorBySource.has(key)) {
      invalid(`historical built-in revision ${key} has no declared successor.`)
    }
    const visited = new Set<string>()
    let cursor = ref
    while (!refMatchesAsset(cursor, current)) {
      const cursorKey = revisionKey(cursor)
      if (visited.has(cursorKey)) invalid(`successor path for ${asset.assetId} contains a cycle.`)
      visited.add(cursorKey)
      const edge = successorBySource.get(cursorKey)
      if (!edge) {
        invalid(`successor path for ${key} does not reach the declared current revision.`)
      }
      cursor = edge.to
    }
  }

  return {
    schemaVersion: HAIR_BUILTIN_CATALOG_CONTRACT,
    assets,
    currentRevisions,
    successorEdges
  }
}

export function listCurrentHairBuiltinAssets(catalog: HairBuiltinCatalogV2): HairAssetV1[] {
  return catalog.currentRevisions.map((ref) => {
    const asset = catalog.assets.find((candidate) => refMatchesAsset(ref, candidate))
    if (!asset) {
      invalid(`current revision ${revisionKey(ref)} is missing from catalog.assets.`)
    }
    return asset
  })
}

export function resolveHairBuiltinSelection(
  catalog: HairBuiltinCatalogV2,
  selection: HairAssetSelectionV1
): HairAssetV1 | null {
  const matchingStyle = catalog.assets.filter((asset) => asset.assetId === selection.assetId)
  if (matchingStyle.length === 0) return null
  const matchingIdentity = matchingStyle.find(
    (asset) => asset.revisionId === selection.assetRevisionId
  )
  if (!matchingIdentity) {
    throw new HairBuiltinCatalogError(
      'UNKNOWN_BUILTIN_SELECTION',
      `saved built-in selection ${selection.assetId}@${selection.assetRevisionId} is not retained by the catalog.`
    )
  }
  if (!selectionMatchesAsset(selection, matchingIdentity)) {
    throw new HairBuiltinCatalogError(
      'TAMPERED_BUILTIN_SELECTION',
      `saved built-in selection ${selection.assetId}@${selection.assetRevisionId} does not match its immutable revision and fit identity.`
    )
  }
  return matchingIdentity
}

export function migrateHairBuiltinStateToCurrent(
  stateValue: HairStateV2,
  catalog: HairBuiltinCatalogV2
): HairBuiltinStateMigration {
  const state = parseHairState(stateValue)
  if (!state.selected) {
    return {
      status: 'none',
      state,
      sourceAsset: null,
      targetAsset: null,
      path: []
    }
  }
  const sourceAsset = resolveHairBuiltinSelection(catalog, state.selected)
  if (!sourceAsset) {
    return {
      status: 'user-selection',
      state,
      sourceAsset: null,
      targetAsset: null,
      path: []
    }
  }
  const currentRef = catalog.currentRevisions.find(
    (ref) => ref.assetId === sourceAsset.assetId
  )
  if (!currentRef) {
    throw new HairBuiltinCatalogError(
      'MISSING_SUCCESSOR',
      `catalog has no declared current revision for ${sourceAsset.assetId}.`
    )
  }
  const currentAsset = catalog.assets.find((asset) => refMatchesAsset(currentRef, asset))
  if (!currentAsset) {
    throw new HairBuiltinCatalogError(
      'MISSING_SUCCESSOR',
      `declared current revision ${revisionKey(currentRef)} is missing.`
    )
  }
  const path = [hairBuiltinRevisionRef(sourceAsset)]
  if (sourceAsset === currentAsset) {
    return {
      status: 'current',
      state,
      sourceAsset,
      targetAsset: currentAsset,
      path
    }
  }

  const successors = new Map(
    catalog.successorEdges.map((edge) => [revisionKey(edge.from), edge.to] as const)
  )
  let cursor = path[0]!
  const visited = new Set<string>()
  while (!refMatchesAsset(cursor, currentAsset)) {
    const key = revisionKey(cursor)
    if (visited.has(key)) {
      throw new HairBuiltinCatalogError(
        'MISSING_SUCCESSOR',
        `successor path for ${sourceAsset.assetId} contains a cycle.`
      )
    }
    visited.add(key)
    const next = successors.get(key)
    if (!next) {
      throw new HairBuiltinCatalogError(
        'MISSING_SUCCESSOR',
        `saved built-in selection ${key} has no declared successor.`
      )
    }
    path.push(next)
    cursor = next
  }

  if (
    state.motionSettings &&
    (currentAsset.physics.mode !== 'secondary-motion/v1' ||
      !currentAsset.display.tags.includes(HAIR_ROOT_WEIGHTED_MOTION_TAG))
  ) {
    throw new HairBuiltinCatalogError(
      'INCOMPATIBLE_SUCCESSOR',
      `current revision ${revisionKey(currentRef)} cannot preserve the saved Hair motion settings.`
    )
  }
  return {
    status: 'migrated',
    state: createHairState(currentAsset, {
      baseColor: state.baseColor,
      highlightColor: state.highlightColor,
      motionSettings: state.motionSettings
    }),
    sourceAsset,
    targetAsset: currentAsset,
    path
  }
}
