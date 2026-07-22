import { describe, expect, it } from 'vitest'
import { parseSemanticGlb } from './semanticGlb'
import { createRecipePhysicalMigrationFixture } from './fixtures/recipePhysicalMigrationPair'
import {
  bakeLiveGoon,
  verifyLiveGoonBakeArtifacts,
  type LiveGoonBakeInput,
  type LiveGoonBakeStage
} from './liveGoonBaker'

async function input(runtimeMorphName?: string): Promise<LiveGoonBakeInput> {
  const fixture = await createRecipePhysicalMigrationFixture({ runtimeMorphName })
  return {
    source: fixture.source.recipeSource,
    sourceRevision: { revisionId: 'recipe-revision-7', revision: 7 },
    state: fixture.sourceState,
    packageBytes: fixture.source.packageBytes,
    modelBytes: fixture.source.glbBytes,
    manifestBytes: fixture.source.manifestBytes
  }
}

describe('deterministic Live Goon baker', () => {
  it('bakes Recipe morphs into POSITION, emits no authoring channels, and is byte deterministic', async () => {
    const source = await input()
    const stages: LiveGoonBakeStage[] = []
    const first = await bakeLiveGoon(source, (stage) => stages.push(stage))
    const second = await bakeLiveGoon(await input())

    expect(stages).toEqual([
      'validating-source',
      'evaluating-recipe',
      'rewriting-model',
      'auditing-model',
      'packaging-live-goon',
      'verifying-output'
    ])
    expect(first.receipt.receiptSha256).toBe(second.receipt.receiptSha256)
    expect(first.modelBytes).toEqual(second.modelBytes)
    expect(first.manifestBytes).toEqual(second.manifestBytes)
    expect(first.packageBytes).toEqual(second.packageBytes)
    expect(first.manifest).not.toHaveProperty('appearanceDials')
    expect(first.manifest).not.toHaveProperty('recipeSource')
    expect(first.manifest).not.toHaveProperty('recipeUpdates')
    expect(first.manifest).toHaveProperty('liveBuild')
    expect(first.manifest.description).toBe('Deterministic Live Goon baked from Recipe revision 7.')
    expect(first.receipt.output.counts.recipeMorphTargets).toBe(0)
    expect(first.receipt.inventory.liveMorphTargets).toEqual([])
    expect(first.audit.maximumErrors.maxFinalPositionErrorMeters).toBeLessThanOrEqual(1e-6)

    const parsed = parseSemanticGlb(first.modelBytes)
    expect(parsed.meshes[0]?.extras).toBeUndefined()
    expect((parsed.meshes[0]?.primitives as Array<Record<string, unknown>>)[0]).not.toHaveProperty('targets')
  })

  it('rejects independently supplied output bytes that do not match the receipt', async () => {
    const output = await bakeLiveGoon(await input())
    const changedModel = Uint8Array.from(output.modelBytes)
    changedModel[changedModel.length - 1] = changedModel.at(-1)! ^ 0xff
    await expect(
      verifyLiveGoonBakeArtifacts({
        modelBytes: changedModel,
        manifestBytes: output.manifestBytes,
        packageBytes: output.packageBytes,
        receipt: output.receipt
      })
    ).rejects.toThrow(/do not match the external receipt/)
  })

  it('retains an explicit runtime morph while removing every Recipe-owned target', async () => {
    const source = await input('blink_runtime')
    const first = await bakeLiveGoon(source)
    const repeated = await bakeLiveGoon(await input('blink_runtime'))

    expect(first.receipt.receiptSha256).toBe(repeated.receipt.receiptSha256)
    expect(first.receipt.inventory.retainedDynamicMorphs).toHaveLength(1)
    expect(first.receipt.inventory.retainedDynamicMorphs[0]).toContain('blink_runtime')
    expect(first.receipt.inventory.retainedCorrectiveMorphs).toEqual([])
    expect(first.receipt.inventory.liveMorphTargets).toEqual(
      first.receipt.inventory.retainedDynamicMorphs
    )
    expect(first.receipt.output.counts).toMatchObject({
      meshes: 1,
      vertices: 3,
      morphTargets: 1,
      dynamicMorphTargets: 1,
      correctiveMorphTargets: 0,
      recipeMorphTargets: 0
    })
    expect(first.receipt.cost).toMatchObject({
      inputBytes: source.modelBytes.byteLength,
      meshesProcessed: 1,
      verticesProcessed: 3,
      morphTargetsProcessed: 7
    })
    expect(Object.values(first.receipt.validation).every((value) => value <= 1e-6)).toBe(true)

    const parsed = parseSemanticGlb(first.modelBytes)
    expect(parsed.meshes[0]?.extras).toEqual({ targetNames: ['blink_runtime'] })
    expect((parsed.meshes[0]?.primitives as Array<Record<string, unknown>>)[0]).toHaveProperty(
      'targets'
    )
  })

})
