import { describe, expect, it } from 'vitest'
import {
  deserializeRecipeExternalSiblingInputs,
  serializeRecipeExternalSiblingInputs,
} from './recipeReviewContracts'

const hash = (character: string) => character.repeat(64)

describe('Recipe review external sibling contracts', () => {
  it('serializes external sibling validation in deterministic source-id order', () => {
    expect(
      serializeRecipeExternalSiblingInputs([
        {
          sourceStateId: 'hairState',
          targetStateId: 'hairState',
          validationSha256: hash('2'),
          message: 'Hair remains exactly compatible.',
          targetState: {
            id: 'hairState',
            contract: 'hair-state/v2',
            definitionSha256: hash('a'),
            stateSha256: hash('b'),
            state: { schemaVersion: 'hair-state/v2' }
          }
        },
        {
          sourceStateId: 'clothingState',
          targetStateId: 'clothingState',
          validationSha256: hash('1'),
          message: 'Clothing remains exactly compatible.',
          targetState: {
            id: 'clothingState',
            contract: 'clothing-state/v1',
            definitionSha256: hash('c'),
            stateSha256: hash('d'),
            state: { schemaVersion: 'clothing-state/v1' }
          }
        },
      ]).map((input) => input.sourceStateId),
    ).toEqual(['clothingState', 'hairState'])
  })

  it('rejects duplicate, unsorted, or identity-changing external bindings', () => {
    expect(() =>
      serializeRecipeExternalSiblingInputs([
        {
          sourceStateId: 'hairState',
          targetStateId: 'hairState-v2',
          validationSha256: hash('2'),
          message: 'Identity changed.',
          targetState: {
            id: 'hairState-v2',
            contract: 'hair-state/v2',
            definitionSha256: hash('a'),
            stateSha256: hash('b'),
            state: { schemaVersion: 'hair-state/v2' }
          }
        },
      ]),
    ).toThrow(/retain the exact external sibling state id/)

    expect(() =>
      deserializeRecipeExternalSiblingInputs([
        {
          sourceStateId: 'hairState',
          targetStateId: 'hairState',
          validationSha256: hash('2'),
          message: 'Hair remains exactly compatible.',
          targetState: {
            id: 'hairState',
            contract: 'hair-state/v2',
            definitionSha256: hash('a'),
            stateSha256: hash('b'),
            state: { schemaVersion: 'hair-state/v2' }
          }
        },
        {
          sourceStateId: 'clothingState',
          targetStateId: 'clothingState',
          validationSha256: hash('1'),
          message: 'Clothing remains exactly compatible.',
          targetState: {
            id: 'clothingState',
            contract: 'clothing-state/v1',
            definitionSha256: hash('c'),
            stateSha256: hash('d'),
            state: { schemaVersion: 'clothing-state/v1' }
          }
        },
      ]),
    ).toThrow(/sorted and unique/)
  })
})
