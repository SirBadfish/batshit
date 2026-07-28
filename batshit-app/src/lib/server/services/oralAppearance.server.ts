import {
  parseOralAppearanceDefinition,
  parseOralAppearanceState,
  type OralAppearanceDefinitionV1,
  type OralAppearanceStateV1
} from '$lib/goons/oralAppearance'
import type { GoonRecord } from '$lib/types/goons'
import {
  readStoredGoonManifest,
  StoredUploadJsonError,
  type StoredUploadJsonReader
} from './storedUploadJson.server'

function fail(message: string): never {
  throw new Error(`[oral-appearance/v1] ${message}`)
}

export async function loadGoonOralAppearanceDefinition(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar'>
): Promise<OralAppearanceDefinitionV1 | null> {
  const filename = goon.customAvatar?.manifest?.filename
  if (!filename) return null

  let manifest: Record<string, unknown>
  try {
    manifest = await readStoredGoonManifest(client, filename)
  } catch (error) {
    if (error instanceof StoredUploadJsonError) fail(error.message)
    throw error
  }
  return manifest.oralAppearance === undefined
    ? null
    : parseOralAppearanceDefinition(manifest.oralAppearance)
}

export async function validateGoonOralAppearanceState(
  client: StoredUploadJsonReader,
  goon: Pick<GoonRecord, 'customAvatar'>,
  value: unknown
): Promise<OralAppearanceStateV1 | null> {
  if (value === null) return null
  const definition = await loadGoonOralAppearanceDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Oral Appearance')
  return parseOralAppearanceState(definition, value)
}
