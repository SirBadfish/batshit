import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition
} from '$lib/goons/eyeAppearance'
import {
  loadGoonEyeAppearanceDefinition,
  validateGoonEyeAppearanceState
} from '../eyeAppearance.server'

function canonical(path: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

const facialArtwork = canonical('static/goons/facial-artwork/v3/facial-artwork-v3.json')
const eyeAppearance = canonical('static/goons/eye-appearance/v1/eye-appearance-v1.json')
const goon = {
  customAvatar: {
    manifest: { url: '/uploads/goon_custom_manifests/avatar.json', filename: 'avatar.json' }
  }
}

function reader(manifest: unknown) {
  return {
    json: {
      async get(key: string) {
        return key === 'upload:goon_custom_manifests:avatar.json'
          ? { textContent: JSON.stringify(manifest) }
          : null
      }
    }
  }
}

describe('eyeAppearance.server', () => {
  it('loads the package definition and validates exact linked state', async () => {
    const manifest = { facialArtwork, eyeAppearance, appearanceDials: {} }
    const definition = parseEyeAppearanceDefinition(eyeAppearance)
    const state = createDefaultEyeAppearanceState(definition)
    await expect(loadGoonEyeAppearanceDefinition(reader(manifest), goon)).resolves.toMatchObject({
      schemaVersion: 'eye-appearance/v1',
      definitionSha256: eyeAppearance.definitionSha256
    })
    await expect(validateGoonEyeAppearanceState(reader(manifest), goon, state)).resolves.toEqual(state)
  })

  it('accepts null and rejects missing or mismatched package dependencies', async () => {
    await expect(validateGoonEyeAppearanceState(reader({}), goon, null)).resolves.toBeNull()
    const definition = parseEyeAppearanceDefinition(eyeAppearance)
    const state = createDefaultEyeAppearanceState(definition)
    await expect(validateGoonEyeAppearanceState(reader({ facialArtwork }), goon, state)).rejects.toThrow(
      /does not support Eye Appearance/
    )
    const mismatched = structuredClone(eyeAppearance)
    mismatched.facialArtworkDependency.definitionSha256 = 'a'.repeat(64)
    await expect(
      validateGoonEyeAppearanceState(
        reader({ facialArtwork, eyeAppearance: mismatched, appearanceDials: {} }),
        goon,
        state
      )
    ).rejects.toThrow(/dependency does not match/)
  })
})
