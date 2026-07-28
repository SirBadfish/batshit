import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultOralAppearanceState,
  parseOralAppearanceDefinition
} from '$lib/goons/oralAppearance'
import {
  loadGoonOralAppearanceDefinition,
  validateGoonOralAppearanceState
} from '../oralAppearance.server'

const oralAppearance = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'static/goons/oral-appearance/v1/oral-appearance-v1.json'),
    'utf8'
  )
)
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

describe('oralAppearance.server', () => {
  it('loads the exact installed definition and validates its state', async () => {
    const manifest = { oralAppearance, appearanceDials: {} }
    const definition = parseOralAppearanceDefinition(oralAppearance)
    const state = createDefaultOralAppearanceState(definition)
    await expect(loadGoonOralAppearanceDefinition(reader(manifest), goon)).resolves.toEqual(
      definition
    )
    await expect(validateGoonOralAppearanceState(reader(manifest), goon, state)).resolves.toEqual(
      state
    )
  })

  it('accepts null and rejects state for a package without Oral Appearance', async () => {
    const definition = parseOralAppearanceDefinition(oralAppearance)
    const state = createDefaultOralAppearanceState(definition)
    await expect(validateGoonOralAppearanceState(reader({}), goon, null)).resolves.toBeNull()
    await expect(validateGoonOralAppearanceState(reader({}), goon, state)).rejects.toThrow(
      /does not support Oral Appearance/
    )
  })
})
