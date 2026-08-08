import {
  parseSkinAppearanceDefinition,
  parseSkinAppearanceState,
  type SkinAppearanceDefinitionV1,
  type SkinAppearanceStateV2
} from '$lib/goons/skinAppearance'
import {
  collectSkinSurfaceUploads,
  LEGACY_SKIN_MATERIAL_ARTWORK_SCHEMA_VERSION,
  type SkinSurfaceUploadV1
} from '$lib/goons/skinSurface'
import type { GoonRecord } from '$lib/types/goons'
import {
  readStoredGoonManifest,
  StoredUploadJsonError,
  type StoredUploadJsonReader
} from './storedUploadJson.server'

function fail(message: string): never {
  throw new Error(`[skin-appearance/v2] ${message}`)
}

export async function loadGoonSkinAppearanceDefinition(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>
): Promise<SkinAppearanceDefinitionV1 | null> {
  const filename = goon.customAvatar?.manifest?.filename
  if (!filename) return null
  let manifest: Record<string, unknown>
  try {
    manifest = await readStoredGoonManifest(client, filename)
  } catch (error) {
    if (error instanceof StoredUploadJsonError) fail(error.message)
    throw error
  }
  return manifest.skinAppearance === undefined
    ? null
    : parseSkinAppearanceDefinition(manifest.skinAppearance)
}

function exactJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function matchesLegacyBaseColorOwnership(
  record: Record<string, unknown>,
  upload: SkinSurfaceUploadV1
) {
  if (upload.map !== 'baseColor' || upload.canvas.encoding !== 'rgba8') {
    return false
  }
  const proof = record.skinMaterialArtwork
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return false
  }
  const validation = proof as Record<string, unknown>
  const legacyCanvas = {
    width: upload.canvas.width,
    height: upload.canvas.height,
    colorSpace: upload.canvas.colorSpace,
    flipY: upload.canvas.flipY
  }
  return (
    record.uploadType === 'goon_skin_artwork' &&
    record.mimetype === 'image/png' &&
    record.size === upload.size &&
    validation.schemaVersion ===
      LEGACY_SKIN_MATERIAL_ARTWORK_SCHEMA_VERSION &&
    validation.map === 'baseColor' &&
    validation.definitionSha256 === upload.definitionSha256 &&
    validation.sha256 === upload.sha256 &&
    exactJson(validation.canvas, legacyCanvas) &&
    exactJson(validation.provenance, upload.provenance)
  )
}

async function validateStoredSurfaceUploads(
  client: StoredUploadJsonReader,
  state: SkinAppearanceStateV2
) {
  for (const upload of collectSkinSurfaceUploads(state)) {
    const stored = await client.json.get(
      `upload:goon_skin_artwork:${upload.filename}`
    )
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      fail(`validated ${upload.map} upload ${upload.filename} is missing`)
    }
    const record = stored as Record<string, unknown>
    const proof = record.skinSurfaceArtwork
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      // Base Color uploads created before the unified surface-map contract have
      // an equally strict immutable ownership proof under the legacy field.
      // Accept only that exact v1 proof; other map roles never inherit it.
      if (
        proof === undefined &&
        matchesLegacyBaseColorOwnership(record, upload)
      ) {
        continue
      }
      if (
        proof === undefined &&
        record.skinMaterialArtwork === undefined
      ) {
        fail(
          `validated ${upload.map} upload ${upload.filename} has no ownership record`
        )
      }
      fail(
        `validated ${upload.map} upload ${upload.filename} does not match its ownership record`
      )
    }
    const validation = proof as Record<string, unknown>
    if (
      record.uploadType !== 'goon_skin_artwork' ||
      record.mimetype !== 'image/png' ||
      record.size !== upload.size ||
      validation.schemaVersion !== upload.schemaVersion ||
      validation.map !== upload.map ||
      validation.definitionSha256 !== upload.definitionSha256 ||
      validation.sha256 !== upload.sha256 ||
      !exactJson(validation.canvas, upload.canvas) ||
      !exactJson(validation.provenance, upload.provenance)
    ) {
      fail(
        `validated ${upload.map} upload ${upload.filename} does not match its ownership record`
      )
    }
  }
}

export async function validateGoonSkinAppearanceState(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
): Promise<SkinAppearanceStateV2 | null> {
  if (value === null) return null
  const definition = await loadGoonSkinAppearanceDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Skin Appearance')
  const state = parseSkinAppearanceState(definition, value)
  await validateStoredSurfaceUploads(client, state)
  return state
}

/** Read-only validation for Recipe revisions created before surface-state v2. */
export async function validateGoonLegacySkinMaterialArtworkState(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
) {
  const definition = await loadGoonSkinAppearanceDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Skin Appearance')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('legacy Base Color Artwork state must be an object')
  }
  const source = value as Record<string, unknown>
  const baseColor = source.baseColor
  if (!baseColor || typeof baseColor !== 'object' || Array.isArray(baseColor)) {
    fail('legacy Base Color Artwork upload is missing')
  }
  const upload = baseColor as Record<string, unknown>
  if (
    source.definitionSha256 !== definition.definitionSha256 ||
    upload.map !== 'baseColor' ||
    upload.definitionSha256 !== definition.definitionSha256 ||
    typeof upload.filename !== 'string'
  ) {
    fail('legacy Base Color Artwork does not match this package')
  }
  const stored = await client.json.get(
    `upload:goon_skin_artwork:${upload.filename}`
  )
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    fail(`validated legacy Base Color upload ${upload.filename} is missing`)
  }
  const record = stored as Record<string, unknown>
  const proof = record.skinMaterialArtwork
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    fail(`validated legacy Base Color upload ${upload.filename} has no ownership record`)
  }
  const validation = proof as Record<string, unknown>
  if (
    record.uploadType !== 'goon_skin_artwork' ||
    record.mimetype !== 'image/png' ||
    record.size !== upload.size ||
    validation.schemaVersion !== upload.schemaVersion ||
    validation.map !== upload.map ||
    validation.definitionSha256 !== upload.definitionSha256 ||
    validation.sha256 !== upload.sha256 ||
    !exactJson(validation.canvas, upload.canvas) ||
    !exactJson(validation.provenance, upload.provenance)
  ) {
    fail(`validated legacy Base Color upload ${upload.filename} does not match its ownership record`)
  }
  return value
}
