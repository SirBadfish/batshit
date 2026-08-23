import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildFacialArtworkV6DefinitionFixture } from '../__fixtures__/facialArtworkV6'
import {
  createDefaultFacialArtworkState,
  parseFacialArtworkDefinition,
  parseFacialArtworkState
} from '../facialArtwork'
import { recipeSiblingStateSha256 } from './recipeContracts'
import { createFacialArtworkRecipeSiblingVerifier } from './facialArtworkRecipeMigration'

function sourceDefinitionValue() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/facial-artwork/v5/facial-artwork-v5.json'),
      'utf8'
    )
  ) as Record<string, any>
}

function sourceState(source: Record<string, any>) {
  const roles = Object.fromEntries(
    source.roles.map((role: Record<string, any>) => [
      role.id,
      { mode: 'shared', shared: structuredClone(role.defaultEyeState) }
    ])
  )
  const irisRole = source.roles.find((role: Record<string, any>) => role.id === 'iris')!
  const irisTemplate = source.templates.find(
    (template: Record<string, any>) => template.id === irisRole.template
  )!
  roles.iris.shared.artwork = {
    upload: {
      role: 'iris',
      url: '/uploads/goon_facial_artwork/iris-user.png',
      filename: 'iris-user.png',
      size: 4096,
      mimeType: 'image/png',
      sha256: '7'.repeat(64),
      template: {
        id: irisTemplate.id,
        version: irisTemplate.version,
        orientation: irisTemplate.canonicalOrientation,
        guideSha256: irisTemplate.guide.sha256,
        maskSha256: irisTemplate.safePaintMask.sha256
      },
      provenance: {
        sourceKind: 'user-authored',
        author: 'Josh',
        license: 'Batshit first-party',
        rightsConfirmed: true
      }
    },
    tint: [0.9, 0.8, 0.7, 0.6],
    opacity: 0.75,
    mapping: 'radial',
    transform: {
      translateU: 0.12,
      translateV: -0.13,
      scale: 1.15,
      rotationDegrees: 14
    }
  }
  roles.pupil.shared.visible = false
  return {
    schemaVersion: 'facial-artwork-state/v5',
    definitionSha256: source.definitionSha256,
    templateSet: structuredClone(source.templateSet),
    roles
  }
}

describe('Facial Artwork Recipe sibling migration', () => {
  it('migrates the exact v5 state to v6 without a general runtime compatibility path', async () => {
    const sourceDefinition = sourceDefinitionValue()
    const targetDefinition = buildFacialArtworkV6DefinitionFixture()
    const value = sourceState(sourceDefinition)
    const sourceRecord = {
      id: 'facialArtwork',
      contract: 'facial-artwork-state/v5',
      definitionSha256: sourceDefinition.definitionSha256,
      stateSha256: await recipeSiblingStateSha256(value),
      state: value
    }
    const verifier = createFacialArtworkRecipeSiblingVerifier(sourceDefinition, targetDefinition)
    const result = await verifier.verify({
      surface: 'facialArtwork',
      operation: 'migrate',
      directEdgeKey: 'recipe-direct-edge/v1|fixture',
      edgeSha256: '8'.repeat(64),
      sourceState: sourceRecord,
      targetStateId: 'facialArtwork',
      targetDefinition: {
        contract: targetDefinition.stateSchemaVersion,
        definitionSha256: targetDefinition.definitionSha256
      }
    })

    const parsedDefinition = parseFacialArtworkDefinition(targetDefinition)
    const parsed = parseFacialArtworkState(parsedDefinition, result.proposedState.state)
    expect(parsed).toMatchObject({
      schemaVersion: 'facial-artwork-state/v6',
      definitionSha256: targetDefinition.definitionSha256,
      templateSet: targetDefinition.templateSet,
      roles: {
        iris: {
          mode: 'shared',
          shared: {
            artwork: {
              tint: [0.9, 0.8, 0.7, 0.6],
              opacity: 0.75,
              transform: {
                translateU: 0,
                translateV: 0,
                scale: 1,
                rotationDegrees: 14
              }
            }
          }
        },
        pupil: { mode: 'shared', shared: { visible: false } }
      }
    })
    expect(
      parsed.roles.iris.mode === 'shared' && parsed.roles.iris.shared.artwork?.upload
    ).toMatchObject({
      filename: 'iris-user.png',
      provenance: { author: 'Josh', rightsConfirmed: true },
      template: {
        id: 'iris-template',
        version: '6.0.0',
        orientation: 'orientation-neutral'
      }
    })
    expect(result.domainEvidenceSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails loudly for an exact-state hash bound to another source definition', async () => {
    const sourceDefinition = sourceDefinitionValue()
    const targetDefinition = buildFacialArtworkV6DefinitionFixture()
    const value = sourceState(sourceDefinition)
    const verifier = createFacialArtworkRecipeSiblingVerifier(sourceDefinition, targetDefinition)
    await expect(
      verifier.verify({
        surface: 'facialArtwork',
        operation: 'migrate',
        directEdgeKey: 'recipe-direct-edge/v1|fixture',
        edgeSha256: '8'.repeat(64),
        sourceState: {
          id: 'facialArtwork',
          contract: 'facial-artwork-state/v5',
          definitionSha256: '9'.repeat(64),
          stateSha256: await recipeSiblingStateSha256(value),
          state: value
        },
        targetStateId: 'facialArtwork',
        targetDefinition: {
          contract: targetDefinition.stateSchemaVersion,
          definitionSha256: targetDefinition.definitionSha256
        }
      })
    ).rejects.toThrow(/exact v5 source state/)
  })

  it('rebinds current v6 definitions for later Recipe revisions', async () => {
    const source = buildFacialArtworkV6DefinitionFixture()
    source.definitionSha256 = '9'.repeat(64)
    const target = buildFacialArtworkV6DefinitionFixture()
    const value = createDefaultFacialArtworkState(source)
    value.roles.eye_highlight.shared.visible = true
    const verifier = createFacialArtworkRecipeSiblingVerifier(source, target)
    const result = await verifier.verify({
      surface: 'facialArtwork',
      operation: 'migrate',
      directEdgeKey: 'recipe-direct-edge/v1|fixture',
      edgeSha256: '8'.repeat(64),
      sourceState: {
        id: 'facialArtwork',
        contract: source.stateSchemaVersion,
        definitionSha256: source.definitionSha256,
        stateSha256: await recipeSiblingStateSha256(value),
        state: value
      },
      targetStateId: 'facialArtwork',
      targetDefinition: {
        contract: target.stateSchemaVersion,
        definitionSha256: target.definitionSha256
      }
    })
    expect(result.proposedState.state).toMatchObject({
      schemaVersion: 'facial-artwork-state/v6',
      definitionSha256: target.definitionSha256,
      roles: { eye_highlight: { shared: { visible: true } } }
    })
  })

  it('clears only uploads whose v6 Guide or Mask coordinates changed', async () => {
    const source = buildFacialArtworkV6DefinitionFixture()
    source.definitionSha256 = '9'.repeat(64)
    const target = buildFacialArtworkV6DefinitionFixture()
    const value = createDefaultFacialArtworkState(source)
    const upload = (roleId: 'brows' | 'lashes_eye_outline') => {
      const role = source.roles.find((entry) => entry.id === roleId)!
      const template = source.templates.find((entry) => entry.id === role.template)!
      return {
        upload: {
          role: roleId,
          url: `/uploads/goon_facial_artwork/${roleId}.png`,
          filename: `${roleId}.png`,
          size: 4096,
          mimeType: 'image/png',
          sha256: '7'.repeat(64),
          template: {
            id: template.id,
            version: template.version,
            orientation: template.canonicalOrientation,
            guideSha256: template.guide.sha256,
            maskSha256: template.safePaintMask.sha256
          },
          provenance: {
            sourceKind: 'user-authored',
            author: 'Josh',
            license: 'Batshit first-party',
            rightsConfirmed: true
          }
        },
        tint: [1, 1, 1, 1],
        opacity: 1,
        mapping: 'planar',
        transform: {
          translateU: 0,
          translateV: 0,
          scale: 1,
          rotationDegrees: 0
        }
      }
    }
    value.roles.brows.shared.artwork = upload('brows')
    value.roles.lashes_eye_outline.shared.artwork = upload('lashes_eye_outline')
    const targetBrowTemplate = target.templates.find(
      (entry) => entry.id === target.roles.find((role) => role.id === 'brows')!.template
    )!
    const targetLashesTemplate = target.templates.find(
      (entry) =>
        entry.id === target.roles.find((role) => role.id === 'lashes_eye_outline')!.template
    )!
    targetBrowTemplate.version = '6.1.0'
    targetLashesTemplate.version = '6.1.0'
    targetLashesTemplate.guide.sha256 = 'a'.repeat(64)
    targetLashesTemplate.safePaintMask.sha256 = 'b'.repeat(64)

    const verifier = createFacialArtworkRecipeSiblingVerifier(source, target)
    const result = await verifier.verify({
      surface: 'facialArtwork',
      operation: 'migrate',
      directEdgeKey: 'recipe-direct-edge/v1|fixture',
      edgeSha256: '8'.repeat(64),
      sourceState: {
        id: 'facialArtwork',
        contract: source.stateSchemaVersion,
        definitionSha256: source.definitionSha256,
        stateSha256: await recipeSiblingStateSha256(value),
        state: value
      },
      targetStateId: 'facialArtwork',
      targetDefinition: {
        contract: target.stateSchemaVersion,
        definitionSha256: target.definitionSha256
      }
    })

    expect(result.proposedState.state.roles.brows.shared.artwork).toMatchObject({
      upload: { template: { version: '6.1.0' } }
    })
    expect(result.proposedState.state.roles.lashes_eye_outline.shared.artwork).toBeNull()
    expect(result.message).toMatch(/cleared every other upload for explicit remigration/)
  })

  it('rebinds a changed v6 template only when the signed target trusts the exact upload bytes', async () => {
    const source = buildFacialArtworkV6DefinitionFixture()
    source.definitionSha256 = '9'.repeat(64)
    const target = buildFacialArtworkV6DefinitionFixture()
    const value = createDefaultFacialArtworkState(source)
    const role = source.roles.find((entry) => entry.id === 'lashes_eye_outline')!
    const sourceTemplate = source.templates.find((entry) => entry.id === role.template)!
    value.roles.lashes_eye_outline.shared.artwork = {
      upload: {
        role: 'lashes_eye_outline',
        url: '/uploads/goon_facial_artwork/exact-trusted-lashes.png',
        filename: 'exact-trusted-lashes.png',
        size: 4096,
        mimeType: 'image/png',
        sha256: '7'.repeat(64),
        template: {
          id: sourceTemplate.id,
          version: sourceTemplate.version,
          orientation: sourceTemplate.canonicalOrientation,
          guideSha256: sourceTemplate.guide.sha256,
          maskSha256: sourceTemplate.safePaintMask.sha256
        },
        provenance: {
          sourceKind: 'user-authored',
          author: 'Josh',
          license: 'Batshit first-party',
          rightsConfirmed: true
        }
      },
      tint: [1, 1, 1, 1],
      opacity: 1,
      mapping: 'planar',
      transform: {
        translateU: 0,
        translateV: 0,
        scale: 1,
        rotationDegrees: 0
      }
    }
    const targetTemplate = target.templates.find((entry) => entry.id === role.template)!
    targetTemplate.version = '6.1.0'
    targetTemplate.guide.sha256 = '1'.repeat(64)
    targetTemplate.safePaintMask.sha256 = '2'.repeat(64)
    const trusted = target.trustedArtwork.entries.find(
      (entry) => entry.role === 'lashes_eye_outline' && entry.side === 'shared'
    )!
    trusted.asset.sha256 = '7'.repeat(64)
    trusted.sourceSha256 = '7'.repeat(64)

    const verifier = createFacialArtworkRecipeSiblingVerifier(source, target)
    const result = await verifier.verify({
      surface: 'facialArtwork',
      operation: 'migrate',
      directEdgeKey: 'recipe-direct-edge/v1|fixture',
      edgeSha256: '8'.repeat(64),
      sourceState: {
        id: 'facialArtwork',
        contract: source.stateSchemaVersion,
        definitionSha256: source.definitionSha256,
        stateSha256: await recipeSiblingStateSha256(value),
        state: value
      },
      targetStateId: 'facialArtwork',
      targetDefinition: {
        contract: target.stateSchemaVersion,
        definitionSha256: target.definitionSha256
      }
    })

    expect(result.proposedState.state.roles.lashes_eye_outline.shared.artwork).toMatchObject({
      upload: {
        sha256: '7'.repeat(64),
        template: {
          version: '6.1.0',
          guideSha256: '1'.repeat(64),
          maskSha256: '2'.repeat(64)
        }
      }
    })
    expect(result.message).toMatch(/exact signed trusted artwork bytes/)
  })
})
