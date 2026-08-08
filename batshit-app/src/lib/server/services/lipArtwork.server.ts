import {
  parseLipArtworkDefinition,
  parseLipArtworkPresenceState,
  parseLipArtworkState,
  type LipArtworkDefinitionV2,
  type LipArtworkPresenceStateV1,
  type LipArtworkStateV2
} from '$lib/goons/lipArtwork'
import type { GoonRecord } from '$lib/types/goons'
import {
  readStoredGoonManifest,
  StoredUploadJsonError,
  type StoredUploadJsonReader
} from './storedUploadJson.server'

function fail(message: string): never {
  throw new Error(`[lip-artwork/v2] ${message}`)
}

export async function validateGoonLipArtworkPresenceState(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
): Promise<LipArtworkPresenceStateV1 | null> {
  if (value === null) return null
  const definition = await loadGoonLipArtworkDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Lip Artwork')
  return parseLipArtworkPresenceState(definition, value)
}

function exactJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function loadGoonLipArtworkDefinition(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>
): Promise<LipArtworkDefinitionV2 | null> {
  const filename = goon.customAvatar?.manifest?.filename
  if (!filename) return null
  let manifest: Record<string, unknown>
  try {
    manifest = await readStoredGoonManifest(client, filename)
  } catch (error) {
    if (error instanceof StoredUploadJsonError) fail(error.message)
    throw error
  }
  if (manifest.lipArtwork === undefined) return null
  return parseLipArtworkDefinition(manifest.lipArtwork)
}

async function assertStoredArtworkOwnership(
  client: StoredUploadJsonReader,
  state: LipArtworkStateV2
) {
  const upload = state.artwork
  const stored = await client.json.get(`upload:goon_facial_artwork:${upload.filename}`)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    fail(`validated artwork upload ${upload.filename} is missing`)
  }
  const record = stored as Record<string, unknown>
  const proof = record.lipArtwork
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    fail(`validated artwork upload ${upload.filename} has no Lip Artwork ownership record`)
  }
  const validation = proof as Record<string, unknown>
  if (
    record.uploadType !== 'goon_facial_artwork' ||
    record.mimetype !== 'image/png' ||
    record.size !== upload.size ||
    validation.definitionSha256 !== state.definitionSha256 ||
    validation.sha256 !== upload.sha256 ||
    !exactJson(validation.template, upload.template) ||
    !exactJson(validation.provenance, upload.provenance)
  ) {
    fail(`validated artwork upload ${upload.filename} does not match its stored ownership record`)
  }
}

export async function validateGoonLipArtworkState(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
): Promise<LipArtworkStateV2 | null> {
  if (value === null) return null
  const definition = await loadGoonLipArtworkDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Lip Artwork')
  const state = parseLipArtworkState(definition, value)
  await assertStoredArtworkOwnership(client, state)
  return state
}
