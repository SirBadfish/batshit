import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultFacialArtworkState,
  parseFacialArtworkDefinition,
  resolveFacialArtworkTemplateVariant
} from '$lib/goons/facialArtwork'
import {
  loadGoonFacialArtworkDefinition,
  validateGoonFacialArtworkState
} from '../facialArtwork.server'

function canonicalDefinition() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/facial-artwork/v3/facial-artwork-v3.json'),
      'utf8'
    )
  )
}

function reader(manifest: unknown, uploads: Record<string, unknown> = {}) {
  return {
    json: {
      async get(key: string) {
        if (key === 'upload:goon_custom_manifests:avatar.json') {
          return { textContent: JSON.stringify(manifest) }
        }
        return uploads[key] ?? null
      }
    }
  }
}

const goon = {
  customAvatar: {
    manifest: { url: '/uploads/goon_custom_manifests/avatar.json', filename: 'avatar.json' }
  }
}

describe('facialArtwork.server', () => {
  it('loads the definition from the Goon package manifest upload', async () => {
    const definition = canonicalDefinition()
    await expect(
      loadGoonFacialArtworkDefinition(reader({ facialArtwork: definition }), goon)
    ).resolves.toMatchObject({
      schemaVersion: 'facial-artwork/v3',
      definitionSha256: definition.definitionSha256
    })
  })

  it('returns null when the current package has no facial artwork definition', async () => {
    await expect(loadGoonFacialArtworkDefinition(reader({ contractVersion: 1 }), goon)).resolves.toBe(
      null
    )
  })

  it('accepts null as the embedded-default state', async () => {
    await expect(
      validateGoonFacialArtworkState(reader({ contractVersion: 1 }), goon, null)
    ).resolves.toBeNull()
  })

  it('validates non-null state against the exact current package definition', async () => {
    const rawDefinition = canonicalDefinition()
    const definition = parseFacialArtworkDefinition(rawDefinition)
    const state = createDefaultFacialArtworkState(definition)
    await expect(
      validateGoonFacialArtworkState(reader({ facialArtwork: rawDefinition }), goon, state)
    ).resolves.toEqual(state)

    state.definitionSha256 = 'f'.repeat(64)
    await expect(
      validateGoonFacialArtworkState(reader({ facialArtwork: rawDefinition }), goon, state)
    ).rejects.toThrow(/does not match the package definition/)
  })

  it('fails loudly when non-null state targets a package without the feature', async () => {
    const definition = parseFacialArtworkDefinition(canonicalDefinition())
    await expect(
      validateGoonFacialArtworkState(
        reader({ contractVersion: 1 }),
        goon,
        createDefaultFacialArtworkState(definition)
      )
    ).rejects.toThrow(/does not support facial artwork/)
  })

  it('binds every artwork reference to its exact stored validation record', async () => {
    const rawDefinition = canonicalDefinition()
    const definition = parseFacialArtworkDefinition(rawDefinition)
    const state = createDefaultFacialArtworkState(definition)
    const role = definition.roles.find((candidate) => candidate.id === 'brows')!
    const template = definition.templates.find((candidate) => candidate.id === role.template)!
    const variant = resolveFacialArtworkTemplateVariant(template, template.canonicalOrientation)
    const artwork = {
      role: 'brows' as const,
      url: '/uploads/goon_facial_artwork/brow-left.png',
      filename: 'brow-left.png',
      size: 4321,
      mimeType: 'image/png' as const,
      sha256: 'a'.repeat(64),
      template: {
        id: template.id,
        version: template.version,
        orientation: template.canonicalOrientation,
        guideSha256: variant.guide.sha256,
        maskSha256: variant.safePaintMask.sha256
      },
      provenance: {
        sourceKind: 'user-authored' as const,
        author: 'Fixture Artist',
        license: 'User-owned',
        rightsConfirmed: true as const
      }
    }
    if (state.roles.brows.mode !== 'shared') throw new Error('fixture expects shared brows')
    state.roles.brows.shared = {
      ...state.roles.brows.shared,
      visible: true,
      artwork: {
        mapping: 'planar',
        transform: { translateU: 0, translateV: 0, scale: 1, rotationDegrees: 0 },
        tint: [1, 1, 1, 1],
        opacity: 1,
        upload: artwork
      }
    }
    const exactRecord = {
      uploadType: 'goon_facial_artwork',
      mimetype: 'image/png',
      size: artwork.size,
      facialArtwork: {
        role: artwork.role,
        definitionSha256: definition.definitionSha256,
        template: artwork.template,
        provenance: artwork.provenance,
        sha256: artwork.sha256
      }
    }
    const uploads = { 'upload:goon_facial_artwork:brow-left.png': exactRecord }

    await expect(
      validateGoonFacialArtworkState(reader({ facialArtwork: rawDefinition }, uploads), goon, state)
    ).resolves.toEqual(state)

    await expect(
      validateGoonFacialArtworkState(reader({ facialArtwork: rawDefinition }), goon, state)
    ).rejects.toThrow(/is missing/)

    await expect(
      validateGoonFacialArtworkState(
        reader(
          { facialArtwork: rawDefinition },
          {
            'upload:goon_facial_artwork:brow-left.png': {
              ...exactRecord,
              facialArtwork: { ...exactRecord.facialArtwork, role: 'lashes_eye_outline' }
            }
          }
        ),
        goon,
        state
      )
    ).rejects.toThrow(/does not match its stored ownership record/)
  })
})
