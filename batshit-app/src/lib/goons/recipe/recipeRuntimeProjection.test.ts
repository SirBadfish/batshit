import { describe, expect, it } from 'vitest'

import {
  GOON_RECIPE_FIT_RECEIPT_CONTRACT,
  applyRecipeRevisionProjection,
  projectGoonRecipeSource,
  recipeRevisionIdentity,
  reconcileGoonRecipeFitReceipts,
  resolveGoonLiveActivationKey,
  type GoonRecipeFitReceipt,
  type GoonRecipeV2,
  type RecipeRevisionEnvelope,
  type RecipeStateSnapshot
} from '$lib/goons/recipe'
import type { AppearanceDialValueState } from '$lib/goons/appearanceDials'
import type { GoonRecord } from '$lib/types/goons'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const SHA_D = 'd'.repeat(64)

function appearanceState(): AppearanceDialValueState {
  return {
    contract: 'appearance-dial-values/v2',
    definitionSha256: SHA_A,
    neutralId: 'neutral-v1',
    neutralRecipeSha256: SHA_B,
    values: { head_size: 0.4 },
    unlockedDialIds: []
  }
}

function sibling(
  id: string,
  contract: string,
  definitionSha256: string,
  state: Record<string, any>
) {
  return {
    id,
    contract,
    definitionSha256,
    stateSha256: SHA_D,
    state
  }
}

function state(): RecipeStateSnapshot {
  return {
    contract: 'appearance-recipe-state/v1',
    stateSha256: SHA_C,
    appearanceDials: appearanceState(),
    siblings: [
      sibling('facialArtwork', 'facial-artwork-state/v4', SHA_A, {
        schemaVersion: 'facial-artwork-state/v4',
        definitionSha256: SHA_A,
        roles: {}
      }),
      sibling('eyeAppearance', 'eye-appearance-state/v3', SHA_B, {
        schemaVersion: 'eye-appearance-state/v3',
        definitionSha256: SHA_B,
        values: {}
      }),
      sibling('oralAppearance', 'oral-appearance-state/v1', SHA_C, {
        schemaVersion: 'oral-appearance-state/v1',
        definitionSha256: SHA_C,
        values: { tongue_rest: 0.2 }
      })
    ]
  }
}

function recipeOwner(recipeState = state()): GoonRecipeV2 {
  return {
    contract: 'goon-recipe/v2',
    writeVersion: 4,
    nextRecipeRevision: 3,
    liveStatus: 'up_to_date',
    authoringRevision: {
      contract: 'goon-recipe-authoring-revision/v1',
      recipeRevision: 2,
      revisionId: 'recipe_revision_2',
      revisionSha256: SHA_A,
      source: {
        package: { ref: '/source/recipe.bgoon', sha256: SHA_A },
        model: { ref: '/source/avatar.glb', sha256: SHA_B },
        manifest: { ref: '/source/avatar.json', sha256: SHA_C },
        identities: {
          contract: 'recipe-source-identity/v1',
          baseId: 'base-f',
          topologySha256: SHA_A,
          skeletonSha256: SHA_B,
          fitFamilySha256: SHA_C,
          modelSha256: SHA_B,
          semanticManifestSha256: SHA_C,
          definitionSha256: SHA_A,
          neutralRecipeSha256: SHA_B,
          physicalBasisSha256: SHA_C,
          behaviorSha256: SHA_D,
          componentGraphSha256: SHA_A
        }
      },
      state: recipeState,
      updateReport: null
    },
    authoringSourceContainmentReceipt: {
      contract: 'recipe-archive-containment-receipt/v1',
      ref: 'goon_recipe_document:user:goon:source',
      sha256: SHA_A
    },
    activeRevision: {
      contract: 'goon-recipe-revision-envelope/v1',
      ref: 'goon_recipe_revision:user:goon:recipe_revision_2',
      sha256: SHA_B
    },
    previousRevision: null,
    pendingAnalysis: null,
    pendingJob: null,
    latestUpdateReport: null,
    lastFailure: null,
    maintenanceFailure: null
  } as GoonRecipeV2
}

function goon(recipeState = state()): GoonRecord {
  return {
    id: 'goon_1',
    user_id: 'user',
    name: 'Recipe Goon',
    kind: 'custom',
    files: { animations: [] },
    customAvatar: {
      package: { url: '/live/live.bgoon', filename: 'live.bgoon' },
      model: { url: '/live/avatar.glb', filename: 'avatar.glb' },
      manifest: { url: '/live/avatar.json', filename: 'avatar.json' }
    },
    recipe: recipeOwner(recipeState),
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z'
  }
}

function envelope(recipeState = state()): RecipeRevisionEnvelope {
  return {
    contract: 'goon-recipe-revision-envelope/v1',
    envelopeSha256: SHA_D,
    revision: {
      contract: 'goon-recipe-revision/v1',
      recipeRevision: 2,
      revisionId: 'recipe_revision_2',
      revisionSha256: SHA_A,
      source: recipeOwner(recipeState).authoringRevision.source,
      state: recipeState,
      liveBuildReceipt: {
        contract: 'goon-live-build/v1',
        ref: 'goon_recipe_document:user:goon:live',
        sha256: SHA_C
      },
      updateReport: null
    },
    sourceContainmentReceipt: {
      contract: 'recipe-archive-containment-receipt/v1',
      ref: 'goon_recipe_document:user:goon:source',
      sha256: SHA_B
    },
    live: {
      package: { ref: '/next/live.bgoon', sha256: SHA_A, bytes: 10 },
      model: { ref: '/next/avatar.glb', sha256: SHA_B, bytes: 20 },
      manifest: { ref: '/next/avatar.json', sha256: SHA_C, bytes: 30 }
    }
  } as RecipeRevisionEnvelope
}

function fitReceipt(bound = recipeRevisionIdentity(envelope().revision)): GoonRecipeFitReceipt {
  return {
    contract: GOON_RECIPE_FIT_RECEIPT_CONTRACT,
    receiptId: 'fit_hair_1',
    surface: 'hair',
    assetId: 'hair_1',
    fitSha256: SHA_D,
    boundRevision: bound,
    evaluatedRevision: bound,
    status: 'current',
    staleReason: null
  }
}

describe('Recipe runtime projection', () => {
  it('projects immutable Recipe Source and all sibling state for the editor only', () => {
    const liveGoon = goon()
    const editorGoon = projectGoonRecipeSource(liveGoon)

    expect(editorGoon.customAvatar?.model?.url).toBe('/source/avatar.glb')
    expect(editorGoon.customAvatar?.manifest?.url).toBe('/source/avatar.json')
    expect(editorGoon.appearanceDials?.values.head_size).toBe(0.4)
    expect(editorGoon.facialArtwork?.schemaVersion).toBe('facial-artwork-state/v4')
    expect(editorGoon.eyeAppearance?.schemaVersion).toBe('eye-appearance-state/v3')
    expect(editorGoon.oralAppearance?.schemaVersion).toBe('oral-appearance-state/v1')
    expect(liveGoon.customAvatar?.model?.url).toBe('/live/avatar.glb')
  })

  it('keys mounted replacement to the exact active revision identity', () => {
    const first = goon()
    const second = goon()
    ;(second.recipe as GoonRecipeV2).activeRevision = {
      contract: 'goon-recipe-revision-envelope/v1',
      ref: 'goon_recipe_revision:user:goon:recipe_revision_3',
      sha256: SHA_C
    }

    expect(resolveGoonLiveActivationKey(first)).not.toBe(resolveGoonLiveActivationKey(second))
    expect(resolveGoonLiveActivationKey(first)).toContain(SHA_B)
  })

  it('atomically projects Live refs, Appearance, Facial, Eye, and Oral state', () => {
    const target = goon()
    applyRecipeRevisionProjection(target, envelope(), (asset) => ({
      url: asset.ref,
      filename: asset.ref.split('/').pop()!
    }))

    expect(target.customAvatar?.model?.url).toBe('/next/avatar.glb')
    expect(target.appearanceDials?.values.head_size).toBe(0.4)
    expect(target.facialArtwork?.definitionSha256).toBe(SHA_A)
    expect(target.eyeAppearance?.definitionSha256).toBe(SHA_B)
    expect(target.oralAppearance?.definitionSha256).toBe(SHA_C)
  })

  it('rejects an ambiguous sibling projection instead of mixing revisions', () => {
    const ambiguous = state()
    ambiguous.siblings.push(
      sibling('facial-artwork', 'facial-artwork-state/v4', SHA_A, {
        schemaVersion: 'facial-artwork-state/v4',
        definitionSha256: SHA_A
      })
    )
    expect(() => projectGoonRecipeSource(goon(ambiguous))).toThrow(/ambiguously binds/)
  })

  it('rejects a sibling whose record and state contracts disagree', () => {
    const invalid = state()
    invalid.siblings[0] = {
      ...invalid.siblings[0],
      contract: 'facial-artwork-state/v2'
    }

    expect(() => projectGoonRecipeSource(goon(invalid))).toThrow(
      /must use facial-artwork-state\/v4/
    )
  })

  it('marks exact revision-bound fit receipts stale and restores them on rollback', () => {
    const original = recipeRevisionIdentity(envelope().revision)
    const next = { ...original, recipeRevision: 3, revisionId: 'recipe_revision_3', revisionSha256: SHA_B }
    const stale = reconcileGoonRecipeFitReceipts([fitReceipt(original)], next)
    expect(stale[0]).toMatchObject({
      status: 'stale',
      staleReason: 'recipe-revision-mismatch',
      boundRevision: original,
      evaluatedRevision: next
    })

    const restored = reconcileGoonRecipeFitReceipts(stale, original)
    expect(restored[0]).toMatchObject({ status: 'current', staleReason: null })
  })
})
