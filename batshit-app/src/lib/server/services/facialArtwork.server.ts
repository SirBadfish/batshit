import {
  collectFacialArtworkUploads,
  parseFacialArtworkDefinition,
  parseFacialArtworkState,
  type FacialArtworkDefinitionV4,
  type FacialArtworkStateV4
} from '$lib/goons/facialArtwork'
import type { GoonRecord } from '$lib/types/goons'
import { loadGoonEyeAppearanceDefinition } from './eyeAppearance.server'
import {
  readStoredGoonManifest,
  StoredUploadJsonError,
  type StoredUploadJsonReader
} from './storedUploadJson.server'

type RedisJsonReader = StoredUploadJsonReader

function fail(message: string): never {
  throw new Error(`[facial-artwork/v4] ${message}`)
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function assertStoredArtworkOwnership(
  client: RedisJsonReader,
  state: FacialArtworkStateV4
): Promise<void> {
  for (const upload of collectFacialArtworkUploads(state)) {
    const stored = await client.json.get(`upload:goon_facial_artwork:${upload.filename}`)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      fail(`validated artwork upload ${upload.filename} is missing`)
    }
    const record = stored as Record<string, unknown>
    const validation = record.facialArtwork
    if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
      fail(`validated artwork upload ${upload.filename} has no ownership record`)
    }
    const proof = validation as Record<string, unknown>
    if (
      record.uploadType !== 'goon_facial_artwork' ||
      record.mimetype !== 'image/png' ||
      record.size !== upload.size ||
      proof.role !== upload.role ||
      proof.definitionSha256 !== state.definitionSha256 ||
      proof.sha256 !== upload.sha256 ||
      !exactJson(proof.template, upload.template) ||
      !exactJson(proof.provenance, upload.provenance)
    ) {
      fail(`validated artwork upload ${upload.filename} does not match its stored ownership record`)
    }
  }
}

export async function loadGoonFacialArtworkDefinition(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>
): Promise<FacialArtworkDefinitionV4 | null> {
  const filename = goon.customAvatar?.manifest?.filename
  if (!filename) return null

  let manifest: Record<string, unknown>
  try {
    manifest = await readStoredGoonManifest(client, filename)
  } catch (error) {
    if (error instanceof StoredUploadJsonError) {
      fail(error.message)
    }
    throw error
  }
  const value = manifest.facialArtwork
  if (value === undefined) return null
  const definition = parseFacialArtworkDefinition(value)
  const eyeAppearance = await loadGoonEyeAppearanceDefinition(client, goon)
  if (!eyeAppearance) {
    fail('facial-artwork/v4 requires the complete eye-appearance/v3 socket-eye tuple')
  }
  if (definition.dependencies.eyeAppearance.definitionSha256 !== eyeAppearance.definitionSha256) {
    fail('facial-artwork/v4 Eye Appearance dependency does not match the installed package')
  }
  return definition
}

export async function validateGoonFacialArtworkState(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
): Promise<FacialArtworkStateV4 | null> {
  if (value === null) return null
  const definition = await loadGoonFacialArtworkDefinition(client, goon)
  if (!definition) fail('current Goon package does not support facial artwork')
  const state = parseFacialArtworkState(definition, value)
  await assertStoredArtworkOwnership(client, state)
  return state
}
