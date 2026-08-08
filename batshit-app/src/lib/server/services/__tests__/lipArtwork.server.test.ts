import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLipArtworkPresenceState,
  parseLipArtworkDefinition
} from '$lib/goons/lipArtwork'
import { validateGoonLipArtworkPresenceState } from '../lipArtwork.server'

function canonicalDefinition() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/lip-artwork/v2/lip-artwork-v2.json'),
      'utf8'
    )
  )
}

function reader(manifest: unknown) {
  return {
    json: {
      async get(key: string) {
        if (key === 'upload:goon_custom_manifests:avatar.json') {
          return { textContent: JSON.stringify(manifest) }
        }
        return null
      }
    }
  }
}

const goon = {
  customAvatar: {
    manifest: { url: '/uploads/goon_custom_manifests/avatar.json', filename: 'avatar.json' }
  }
}

describe('lipArtwork.server', () => {
  it('accepts an explicit package-bound Lip Artwork off state', async () => {
    const rawDefinition = canonicalDefinition()
    const definition = parseLipArtworkDefinition(rawDefinition)
    const state = createLipArtworkPresenceState(definition, false)
    await expect(
      validateGoonLipArtworkPresenceState(
        reader({ lipArtwork: rawDefinition }),
        goon,
        state
      )
    ).resolves.toEqual(state)
  })

  it('rejects an off state when the package has no Lip Artwork definition', async () => {
    const definition = parseLipArtworkDefinition(canonicalDefinition())
    await expect(
      validateGoonLipArtworkPresenceState(
        reader({ contractVersion: 1 }),
        goon,
        createLipArtworkPresenceState(definition, false)
      )
    ).rejects.toThrow(/does not support Lip Artwork/)
  })
})
