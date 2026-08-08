import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultNailSurfaceState,
  createNailSurfacePresenceState,
  parseNailSurfaceDefinition
} from '$lib/goons/nailSurface'
import {
  loadGoonNailSurfaceDefinition,
  validateGoonNailSurfacePresenceState,
  validateGoonNailSurfaceState
} from '../nailSurface.server'

function canonicalDefinition() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/nail-surface/v1/nail-surface-v1.json'),
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

describe('nailSurface.server', () => {
  it('loads the strict package definition and accepts null inheritance', async () => {
    const definition = canonicalDefinition()
    await expect(
      loadGoonNailSurfaceDefinition(reader({ nailSurface: definition }), goon)
    ).resolves.toMatchObject({
      schemaVersion: 'nail-surface/v1',
      definitionSha256: definition.definitionSha256
    })
    await expect(
      validateGoonNailSurfaceState(reader({ contractVersion: 1 }), goon, null)
    ).resolves.toBeNull()
  })

  it('accepts an explicit package-bound Nail Surface off state', async () => {
    const rawDefinition = canonicalDefinition()
    const definition = parseNailSurfaceDefinition(rawDefinition)
    const state = createNailSurfacePresenceState(definition, false)
    await expect(
      validateGoonNailSurfacePresenceState(
        reader({ nailSurface: rawDefinition }),
        goon,
        state
      )
    ).resolves.toEqual(state)
  })

  it('binds each artwork family to its exact stored ownership proof', async () => {
    const rawDefinition = canonicalDefinition()
    const definition = parseNailSurfaceDefinition(rawDefinition)
    const state = createDefaultNailSurfaceState(definition)
    const template = definition.templates.fingers
    const artwork = {
      schemaVersion: 'nail-artwork/v1' as const,
      family: 'fingers' as const,
      url: '/uploads/goon_nail_artwork/fingers.png',
      filename: 'fingers.png',
      size: 4321,
      mimeType: 'image/png' as const,
      sha256: 'a'.repeat(64),
      definitionSha256: definition.definitionSha256,
      template: {
        id: template.id,
        version: template.version,
        guideSha256: template.guide.sha256,
        slotMaskSha256: template.slotMask.sha256,
        baseArtworkSha256: template.baseArtwork.sha256
      },
      provenance: {
        sourceKind: 'user-authored' as const,
        author: 'Fixture Artist',
        license: 'User-owned',
        rightsConfirmed: true as const
      }
    }
    state.appearance.fingers.artwork = artwork
    const exactRecord = {
      uploadType: 'goon_nail_artwork',
      mimetype: 'image/png',
      size: artwork.size,
      nailArtwork: {
        schemaVersion: artwork.schemaVersion,
        family: artwork.family,
        definitionSha256: artwork.definitionSha256,
        template: artwork.template,
        provenance: artwork.provenance,
        sha256: artwork.sha256
      }
    }

    await expect(
      validateGoonNailSurfaceState(
        reader(
          { nailSurface: rawDefinition },
          { 'upload:goon_nail_artwork:fingers.png': exactRecord }
        ),
        goon,
        state
      )
    ).resolves.toEqual(state)

    await expect(
      validateGoonNailSurfaceState(reader({ nailSurface: rawDefinition }), goon, state)
    ).rejects.toThrow(/fingers artwork upload fingers.png is missing/)

    await expect(
      validateGoonNailSurfaceState(
        reader(
          { nailSurface: rawDefinition },
          {
            'upload:goon_nail_artwork:fingers.png': {
              ...exactRecord,
              nailArtwork: { ...exactRecord.nailArtwork, family: 'toes' }
            }
          }
        ),
        goon,
        state
      )
    ).rejects.toThrow(/does not match its stored ownership record/)
  })
})
