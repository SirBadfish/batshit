import {
  collectFacialArtworkUploads,
  parseFacialArtworkDefinition,
  parseFacialArtworkState,
  type FacialArtworkDefinitionV3,
  type FacialArtworkStateV3
} from '$lib/goons/facialArtwork'
import type { GoonRecord } from '$lib/types/goons'

type RedisJsonReader = {
  json: {
    get(key: string): Promise<unknown>
  }
}

function fail(message: string): never {
  throw new Error(`[facial-artwork/v3] ${message}`)
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function assertStoredArtworkOwnership(
  client: RedisJsonReader,
  state: FacialArtworkStateV3
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
  goon: Pick<GoonRecord, 'customAvatar'>
): Promise<FacialArtworkDefinitionV3 | null> {
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
  const definition = (manifest as Record<string, unknown>).facialArtwork
  return definition === undefined ? null : parseFacialArtworkDefinition(definition)
}

export async function validateGoonFacialArtworkState(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar'>,
  value: unknown
): Promise<FacialArtworkStateV3 | null> {
  if (value === null) return null
  const definition = await loadGoonFacialArtworkDefinition(client, goon)
  if (!definition) fail('current Goon package does not support facial artwork')
  const state = parseFacialArtworkState(definition, value)
  await assertStoredArtworkOwnership(client, state)
  return state
}
