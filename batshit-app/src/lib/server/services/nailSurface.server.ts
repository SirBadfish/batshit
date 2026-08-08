import {
  parseNailSurfaceDefinition,
  parseNailSurfacePresenceState,
  parseNailSurfaceState,
  type NailArtworkUploadV1,
  type NailFamily,
  type NailSurfaceDefinitionV1,
  type NailSurfacePresenceStateV1,
  type NailSurfaceStateV1
} from '$lib/goons/nailSurface'
import type { GoonRecord } from '$lib/types/goons'
import {
  readStoredGoonManifest,
  StoredUploadJsonError,
  type StoredUploadJsonReader
} from './storedUploadJson.server'

function fail(message: string): never {
  throw new Error(`[nail-surface/v1] ${message}`)
}

export async function validateGoonNailSurfacePresenceState(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
): Promise<NailSurfacePresenceStateV1 | null> {
  if (value === null) return null
  const definition = await loadGoonNailSurfaceDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Nail Surface')
  return parseNailSurfacePresenceState(definition, value)
}

function exactJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function loadGoonNailSurfaceDefinition(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>
): Promise<NailSurfaceDefinitionV1 | null> {
  const filename = goon.customAvatar?.manifest?.filename
  if (!filename) return null
  let manifest: Record<string, unknown>
  try {
    manifest = await readStoredGoonManifest(client, filename)
  } catch (error) {
    if (error instanceof StoredUploadJsonError) fail(error.message)
    throw error
  }
  if (manifest.nailSurface === undefined) return null
  return parseNailSurfaceDefinition(manifest.nailSurface)
}

async function assertStoredArtworkOwnership(
  client: StoredUploadJsonReader,
  family: NailFamily,
  upload: NailArtworkUploadV1
) {
  const stored = await client.json.get(`upload:goon_nail_artwork:${upload.filename}`)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    fail(`validated ${family} artwork upload ${upload.filename} is missing`)
  }
  const record = stored as Record<string, unknown>
  const proof = record.nailArtwork
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    fail(`validated ${family} artwork upload ${upload.filename} has no Nail Artwork ownership record`)
  }
  const validation = proof as Record<string, unknown>
  if (
    record.uploadType !== 'goon_nail_artwork' ||
    record.mimetype !== 'image/png' ||
    record.size !== upload.size ||
    validation.schemaVersion !== upload.schemaVersion ||
    validation.family !== family ||
    validation.definitionSha256 !== upload.definitionSha256 ||
    validation.sha256 !== upload.sha256 ||
    !exactJson(validation.template, upload.template) ||
    !exactJson(validation.provenance, upload.provenance)
  ) {
    fail(`validated ${family} artwork upload ${upload.filename} does not match its stored ownership record`)
  }
}

export async function validateGoonNailSurfaceState(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
): Promise<NailSurfaceStateV1 | null> {
  if (value === null) return null
  const definition = await loadGoonNailSurfaceDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Nail Surface')
  const state = parseNailSurfaceState(definition, value)
  for (const family of ['fingers', 'toes'] as const) {
    const upload = state.appearance[family].artwork
    if (upload) await assertStoredArtworkOwnership(client, family, upload)
  }
  return state
}
