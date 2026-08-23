import { describe, expect, it } from 'vitest'
import {
  deserializeRecipeExternalSiblingInputs,
  serializeRecipeExternalSiblingInputs,
} from './recipeReviewContracts'

const hash = (character: string) => character.repeat(64)

const hairTargetState = (id: string, definitionCharacter: string, stateCharacter: string) => ({
  id,
  contract: 'hair-state/v2',
  definitionSha256: hash(definitionCharacter),
  stateSha256: hash(stateCharacter),
  state: { schemaVersion: 'hair-state/v2' }
})

describe('Recipe review external sibling contracts', () => {
  it('serializes external sibling validation in deterministic source-id order', () => {
    expect(
      serializeRecipeExternalSiblingInputs([
        {
          sourceStateId: 'hairStateB',
          targetStateId: 'hairStateB',
          validationSha256: hash('2'),
          message: 'Hair B remains exactly compatible.',
          targetState: hairTargetState('hairStateB', 'a', 'b')
        },
        {
          sourceStateId: 'hairStateA',
          targetStateId: 'hairStateA',
          validationSha256: hash('1'),
          message: 'Hair A remains exactly compatible.',
          targetState: hairTargetState('hairStateA', 'c', 'd')
        },
      ]).map((input) => input.sourceStateId),
    ).toEqual(['hairStateA', 'hairStateB'])
  })

  it('rejects identity-changing or unsorted external bindings', () => {
    expect(() =>
      serializeRecipeExternalSiblingInputs([
        {
          sourceStateId: 'hairState',
          targetStateId: 'hairState-v2',
          validationSha256: hash('2'),
          message: 'Identity changed.',
          targetState: hairTargetState('hairState-v2', 'a', 'b')
        },
      ]),
    ).toThrow(/retain the exact external sibling state id/)

    expect(() =>
      deserializeRecipeExternalSiblingInputs([
        {
          sourceStateId: 'hairStateB',
          targetStateId: 'hairStateB',
          validationSha256: hash('2'),
          message: 'Hair B remains exactly compatible.',
          targetState: hairTargetState('hairStateB', 'a', 'b')
        },
        {
          sourceStateId: 'hairStateA',
          targetStateId: 'hairStateA',
          validationSha256: hash('1'),
          message: 'Hair A remains exactly compatible.',
          targetState: hairTargetState('hairStateA', 'c', 'd')
        },
      ]),
    ).toThrow(/sorted and unique/)
  })
})
