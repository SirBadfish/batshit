import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLipArtworkPresenceState,
  parseLipArtworkDefinition,
  type LipArtworkStateV2
} from '../lipArtwork'
import {
  createDefaultNailSurfaceState,
  createNailSurfacePresenceState,
  parseNailSurfaceDefinition
} from '../nailSurface'
import { createDefaultSkinAppearanceState, parseSkinAppearanceDefinition } from '../skinAppearance'
import { createRecipePhysicalMigrationFixture } from './fixtures/recipePhysicalMigrationPair'
import {
  buildPackageRecipeSiblingMigrationInputs,
  collectPackageRecipeSiblingRecords
} from './packageRecipeSiblingMigration'
import {
  GOON_RECIPE_STATE_CONTRACT,
  recipeSiblingStateSha256,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot
} from './recipeContracts'

function staticDefinition(relativePath: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'static', relativePath), 'utf8'))
}

async function sibling(
  id: string,
  contract: string,
  definitionSha256: string,
  state: Record<string, unknown>
): Promise<RecipeSiblingStateRecord> {
  return {
    id,
    contract,
    definitionSha256,
    stateSha256: await recipeSiblingStateSha256(state),
    state
  }
}

async function packageState() {
  const lipRaw = staticDefinition('goons/lip-artwork/v2/lip-artwork-v2.json')
  const nailRaw = staticDefinition('goons/nail-surface/v1/nail-surface-v1.json')
  const skinRaw = staticDefinition('goons/skin-appearance/v1/skin-appearance-v1.json')
  const lip = parseLipArtworkDefinition(lipRaw)
  const nail = parseNailSurfaceDefinition(nailRaw)
  const skin = parseSkinAppearanceDefinition(skinRaw)
  const lipArtwork: LipArtworkStateV2 = {
    schemaVersion: 'lip-artwork-state/v2',
    definitionSha256: lip.definitionSha256,
    artwork: {
      url: '/uploads/goon_facial_artwork/lips.png',
      filename: 'lips.png',
      size: 64,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      definitionSha256: lip.definitionSha256,
      template: {
        id: lip.template.id,
        version: lip.template.version,
        guideSha256: lip.template.guide.sha256,
        maskSha256: lip.template.safePaintMask.sha256,
        baseLipReferenceMaskSha256: lip.template.baseLipReferenceMask.sha256
      },
      provenance: {
        sourceKind: 'user-authored',
        author: 'Recipe Test',
        license: 'LicenseRef-User-Owned',
        rightsConfirmed: true
      }
    },
    tint: [1, 1, 1],
    opacity: 1
  }
  const siblings = await Promise.all([
    sibling('lipArtwork', lipArtwork.schemaVersion, lip.definitionSha256, lipArtwork),
    sibling(
      'lipArtworkPresence',
      'lip-artwork-presence-state/v1',
      lip.definitionSha256,
      createLipArtworkPresenceState(lip, true)
    ),
    sibling(
      'nailSurface',
      'nail-surface-state/v1',
      nail.definitionSha256,
      createDefaultNailSurfaceState(nail)
    ),
    sibling(
      'nailSurfacePresence',
      'nail-surface-presence-state/v1',
      nail.definitionSha256,
      createNailSurfacePresenceState(nail, true)
    ),
    sibling(
      'skinAppearance',
      'skin-appearance-state/v2',
      skin.definitionSha256,
      createDefaultSkinAppearanceState(skin)
    )
  ])
  const state: RecipeStateSnapshot = {
    contract: GOON_RECIPE_STATE_CONTRACT,
    stateSha256: '0'.repeat(64),
    appearanceDials: {
      contract: 'appearance-dial-values/v1',
      definitionSha256: 'b'.repeat(64),
      neutralId: 'package-sibling-test',
      neutralRecipeSha256: 'c'.repeat(64),
      values: {},
      unlockedDialIds: []
    },
    siblings: siblings.sort((left, right) => left.id.localeCompare(right.id))
  }
  return {
    state,
    manifest: {
      lipArtwork: lipRaw,
      nailSurface: nailRaw,
      skinAppearance: skinRaw
    }
  }
}

describe('package Recipe sibling migration', () => {
  it('binds every exact package-managed sibling whether its state is default or customized', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const { state, manifest } = await packageState()

    expect(
      collectPackageRecipeSiblingRecords({
        state,
        targetManifest: manifest
      }).map((entry) => entry.id)
    ).toEqual([
      'lipArtwork',
      'lipArtworkPresence',
      'nailSurface',
      'nailSurfacePresence',
      'skinAppearance'
    ])

    const bindings = await buildPackageRecipeSiblingMigrationInputs({
      state,
      sourceManifest: manifest,
      targetManifest: structuredClone(manifest),
      sourceRecipeIdentities: fixture.source.recipeSource.identities,
      targetRecipeIdentities: fixture.target.recipeSource.identities
    })
    expect(bindings.map((entry) => entry.sourceStateId)).toEqual([
      'lipArtwork',
      'lipArtworkPresence',
      'nailSurface',
      'nailSurfacePresence',
      'skinAppearance'
    ])
    expect(bindings.every((entry) => entry.sourceStateId === entry.targetStateId)).toBe(true)
    expect(bindings.every((entry) => /^[a-f0-9]{64}$/.test(entry.validationSha256))).toBe(true)
  })

  it('blocks carry-forward when a target package definition no longer accepts the saved state', async () => {
    const { state, manifest } = await packageState()
    const changed = structuredClone(manifest) as Record<string, Record<string, unknown>>
    changed.skinAppearance.definitionSha256 = 'd'.repeat(64)

    expect(() => collectPackageRecipeSiblingRecords({ state, targetManifest: changed })).toThrow(
      /Skin Appearance cannot be carried.*target package definition/
    )
  })
})
