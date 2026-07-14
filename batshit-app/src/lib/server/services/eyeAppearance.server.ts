import {
  parseEyeAppearanceDefinition,
  parseEyeAppearanceState,
  type EyeAppearanceDefinitionV1,
  type EyeAppearanceStateV1
} from '$lib/goons/eyeAppearance'
import { parseFacialArtworkDefinition } from '$lib/goons/facialArtwork'
import type { GoonRecord } from '$lib/types/goons'

type RedisJsonReader = {
  json: {
    get(key: string): Promise<unknown>
  }
}

function fail(message: string): never {
  throw new Error(`[eye-appearance/v1] ${message}`)
}

async function loadStoredManifest(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar'>
): Promise<Record<string, unknown> | null> {
  const filename = goon.customAvatar?.manifest?.filename
  if (!filename) return null
  const upload = await client.json.get(`upload:goon_custom_manifests:${filename}`)
  if (!upload || typeof upload !== 'object' || Array.isArray(upload)) {
    fail('current Custom Goon manifest upload is missing')
  }
  const textContent = (upload as Record<string, unknown>).textContent
  if (typeof textContent !== 'string' || !textContent.trim()) {
    fail('current Custom Goon manifest upload has no JSON content')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(textContent)
  } catch {
    fail('current Custom Goon manifest upload is invalid JSON')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('current Custom Goon manifest must be a JSON object')
  }
  return manifest as Record<string, unknown>
}

export async function loadGoonEyeAppearanceDefinition(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar'>
): Promise<EyeAppearanceDefinitionV1 | null> {
  const manifest = await loadStoredManifest(client, goon)
  if (!manifest || manifest.eyeAppearance === undefined) return null
  if (manifest.appearanceDials === undefined || manifest.appearanceDials === null) {
    fail('eye-appearance/v1 requires the package Recipe appearance-dials/v2 definition')
  }
  const definition = parseEyeAppearanceDefinition(manifest.eyeAppearance)
  if (manifest.facialArtwork === undefined) {
    fail('eye-appearance/v1 requires the matching facial-artwork/v2 package definition')
  }
  const facialArtwork = parseFacialArtworkDefinition(manifest.facialArtwork)
  if (definition.facialArtworkDependency.definitionSha256 !== facialArtwork.definitionSha256) {
    fail('eye-appearance/v1 facial artwork dependency does not match the installed package')
  }
  return definition
}

export async function validateGoonEyeAppearanceState(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar'>,
  value: unknown
): Promise<EyeAppearanceStateV1 | null> {
  if (value === null) return null
  const definition = await loadGoonEyeAppearanceDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Eye Appearance')
  return parseEyeAppearanceState(definition, value)
}
