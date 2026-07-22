import { describe, expect, it } from 'vitest'
import type { RecipeMigrationPlan } from './migrationPlanContracts'
import {
  RECIPE_AUTHOR_CHANGE_FAMILIES,
  RECIPE_AUTHOR_CHANGE_FAMILY_RULES,
  RECIPE_AUTHOR_UPDATE_CLASSIFICATIONS,
  classifyRecipeAuthorUpdatePlan,
  isSupportedFirstPartyRecipeBase,
  type RecipeAuthorUpdateClassification
} from './recipeAuthorUpdatePolicy'

function policyPlan(
  classification: RecipeAuthorUpdateClassification,
  overrides: {
    fromBaseId?: string
    toBaseId?: string
    tampered?: boolean
  } = {}
): RecipeMigrationPlan {
  const automatic =
    classification === 'automatic-appearance-preserving' || classification === 'proven-remap'
  const resetRequired = classification === 'reset-required'
  return {
    fromSource: { identities: { baseId: overrides.fromBaseId ?? 'batshit-base-f-v1' } },
    toSource: { identities: { baseId: overrides.toBaseId ?? 'batshit-base-f-v1' } },
    outcome: automatic
      ? {
          kind: 'automatic',
          preservationClaim: 'appearance-preserved',
          cleanResetEligibility: 'not-applicable'
        }
      : {
          kind: 'unsupported',
          preservationClaim: 'none',
          cleanResetEligibility: resetRequired ? 'eligible' : 'ineligible',
          rejectionCodes: [overrides.tampered ? 'TAMPERED_PROOF' : 'COMPONENT_MAP_MISSING']
        },
    controlRows: classification === 'proven-remap'
      ? [{ resolution: 'component-remapped' }]
      : [],
    siblingRows: []
  } as unknown as RecipeMigrationPlan
}

describe('Recipe Blender-author update policy', () => {
  it('covers every required author change family exactly once with explicit four-way rules', () => {
    expect(RECIPE_AUTHOR_CHANGE_FAMILY_RULES.map((entry) => entry.family)).toEqual(
      RECIPE_AUTHOR_CHANGE_FAMILIES
    )
    expect(new Set(RECIPE_AUTHOR_CHANGE_FAMILY_RULES.map((entry) => entry.family)).size).toBe(
      RECIPE_AUTHOR_CHANGE_FAMILIES.length
    )
    for (const entry of RECIPE_AUTHOR_CHANGE_FAMILY_RULES) {
      expect(entry.proofDomains).toContain('source-identities')
      expect(entry.proofDomains).toContain('stable-control-ledger')
      expect(entry.proofDomains).toContain('direct-update-edge')
      expect(entry.proofDomains).toContain('whole-recipe-physical-proof')
      expect(entry.proofDomains).toContain('structural-eligibility')
      expect(entry.automaticWhen).not.toHaveLength(0)
      expect(entry.provenRemapWhen).not.toHaveLength(0)
      expect(entry.resetRequiredWhen).not.toHaveLength(0)
      expect(entry.blockedWhen).not.toHaveLength(0)
    }
  })

  it('runs a fixture for every change family while covering all four exclusive classes', () => {
    const fixtures = RECIPE_AUTHOR_CHANGE_FAMILIES.map((family, index) => {
      const expected = RECIPE_AUTHOR_UPDATE_CLASSIFICATIONS[
        index % RECIPE_AUTHOR_UPDATE_CLASSIFICATIONS.length
      ]!
      return { family, expected, plan: policyPlan(expected) }
    })

    expect(new Set(fixtures.map((fixture) => fixture.family))).toEqual(
      new Set(RECIPE_AUTHOR_CHANGE_FAMILIES)
    )
    expect(new Set(fixtures.map((fixture) => fixture.expected))).toEqual(
      new Set(RECIPE_AUTHOR_UPDATE_CLASSIFICATIONS)
    )
    for (const fixture of fixtures) {
      expect(classifyRecipeAuthorUpdatePlan(fixture.plan), fixture.family).toBe(fixture.expected)
    }
  })

  it('blocks independent, missing-provenance, and tampered update evidence', () => {
    expect(
      classifyRecipeAuthorUpdatePlan(
        policyPlan('automatic-appearance-preserving', { fromBaseId: 'independent-avatar' })
      )
    ).toBe('blocked-ineligible')
    expect(
      classifyRecipeAuthorUpdatePlan(
        policyPlan('automatic-appearance-preserving', { toBaseId: 'unknown-target' })
      )
    ).toBe('blocked-ineligible')
    expect(
      classifyRecipeAuthorUpdatePlan(policyPlan('blocked-ineligible', { tampered: true }))
    ).toBe('blocked-ineligible')
  })

  it('keeps the initial supported author contract first-party-only', () => {
    expect(isSupportedFirstPartyRecipeBase('batshit-base-f-v1')).toBe(true)
    expect(isSupportedFirstPartyRecipeBase('batshit-base-f')).toBe(false)
    expect(isSupportedFirstPartyRecipeBase('independent-avatar')).toBe(false)
    expect(isSupportedFirstPartyRecipeBase(null)).toBe(false)
  })

  it('fails closed when a nominal automatic plan lacks exact appearance-preservation proof', () => {
    const plan = policyPlan('automatic-appearance-preserving')
    plan.outcome.preservationClaim = 'values-migrated-only'
    expect(classifyRecipeAuthorUpdatePlan(plan)).toBe('blocked-ineligible')
  })
})
