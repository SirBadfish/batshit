import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHairState } from '../hairAssets'
import { hairFollowerDefinitionSha256 } from '../hairFollowers'
import { parseEmbeddedHairMaterial } from '../hairMaterial'
import {
  HAIR_ROOT_WEIGHTED_MOTION_TAG,
  parseEmbeddedSecondaryMotion,
  secondaryMotionDefinitionSha256,
  type SecondaryMotionTuning
} from '../secondaryMotion'
import { parseSemanticGlb } from './semanticGlb'
import { createRecipePhysicalMigrationFixture } from './fixtures/recipePhysicalMigrationPair'
import {
  createHairAssetFixture,
  createHairFollowerDefinitionFixture,
  createHairSecondaryMotionDefinitionFixture,
  createFollowerHairGlbFixture,
  createRigidHairGlbFixture,
  createRootWeightedFollowerHairGlbFixture,
  HAIR_HIGHLIGHT_MASK_PNG_FIXTURE,
  HAIR_NEUTRAL_VALUE_PNG_FIXTURE
} from './fixtures/hairAssetFixture'
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  sha256Hex
} from './recipeCanonical'
import { recipeSiblingStateSha256, recipeStateSnapshotSha256 } from './recipeContracts'
import {
  bakeLiveGoon,
  verifyLiveGoonBakeArtifacts,
  type LiveGoonBakeInput,
  type LiveGoonBakeStage
} from './liveGoonBaker'

async function input(runtimeMorphName?: string): Promise<LiveGoonBakeInput> {
  const fixture = await createRecipePhysicalMigrationFixture({
    runtimeMorphName
  })
  return {
    source: fixture.source.recipeSource,
    sourceRevision: { revisionId: 'recipe-revision-7', revision: 7 },
    state: fixture.sourceState,
    packageBytes: fixture.source.packageBytes,
    modelBytes: fixture.source.glbBytes,
    manifestBytes: fixture.source.manifestBytes
  }
}

async function skinArtworkProjectionFixture() {
  const point = {
    triangle: 0,
    barycentric: [1, 0, 0] as [number, number, number]
  }
  const circle = (side: 'left' | 'right', surfaceCenterUv: [number, number]) => ({
    side,
    sourceArtworkCenterUv: surfaceCenterUv,
    surfaceCenterUv,
    deformationCenterUv: surfaceCenterUv,
    sourceOuterRadiusUv: 0.006,
    deformationFrameRadiusUv: 0.01,
    supportRadiusUv: 0.014,
    neutralOuterRadiusMeters: 0.013,
    neutralSizeFrameMeters: [0.02, 0.02] as [number, number],
    neutralCenterFrameRatios: [0, 0, 0] as [number, number, number],
    anchors: {
      ownershipSeed: point,
      outerBoundary: Array.from({ length: 8 }, () => point),
      deformationFrame: {
        uMinus: point,
        uPlus: point,
        vMinus: point,
        vPlus: point
      }
    }
  })
  const definition = {
    schemaVersion: 'skin-artwork-projection/v8',
    status: 'ready-review',
    productExportApproved: true,
    definitionSha256: '0'.repeat(64),
    metric: 'nipple-base-ring-single-surface-circle/v3',
    projectionOrigin: 'selected-outer-boundary-stable-frame/v1',
    pigmentExtraction: 'isolated-skin-appearance-region-layer/v1',
    surfaceOwnership: 'center-connected-projection-island/v1',
    radiusResponse: {
      driver: 'appearance-dial/nipple_size-positive/v1',
      positiveMaximumMultiplier: 2,
      maximumOuterRadiusMeters: 0.04,
      bakedDriverValue: null
    },
    runtimeBinding: {
      node: 'Body',
      material: 'FixtureMaterial',
      vertexCount: 3,
      indexCount: 3,
      indexSha256: 'b'.repeat(64),
      uvSha256: 'c'.repeat(64),
      surfaceOffsetMeters: 0,
      overlayTextureSize: 64,
      overlayTextureRadiusUv: 0.4
    },
    circles: [
      circle('left', [0.3, 0.3]),
      circle('right', [0.7, 0.3])
    ]
  }
  definition.definitionSha256 = await canonicalRecipeSha256(definition)
  return definition
}

function liveInputFromFixture(
  fixture: Awaited<ReturnType<typeof createRecipePhysicalMigrationFixture>>
): LiveGoonBakeInput {
  return {
    source: fixture.source.recipeSource,
    sourceRevision: { revisionId: 'recipe-revision-7', revision: 7 },
    state: fixture.sourceState,
    packageBytes: fixture.source.packageBytes,
    modelBytes: fixture.source.glbBytes,
    manifestBytes: fixture.source.manifestBytes
  }
}

async function selectFixtureHair(
  source: LiveGoonBakeInput,
  options: {
    includeBakeInput?: boolean
    follower?: boolean
    physics?: boolean
    motionSettings?: SecondaryMotionTuning
  } = {}
) {
  const mainBytes = options.motionSettings
    ? createRootWeightedFollowerHairGlbFixture()
    : options.follower
      ? createFollowerHairGlbFixture()
      : createRigidHairGlbFixture()
  const followerDefinition = options.follower
    ? createHairFollowerDefinitionFixture({
        recipeSource: source.source,
        geometrySha256: await sha256Hex(mainBytes),
        headNode: 'HeadAnchor'
      })
    : null
  const followerBytes = followerDefinition
    ? new TextEncoder().encode(`${canonicalRecipeString(followerDefinition)}\n`)
    : undefined
  const physicsDefinition = options.physics
    ? createHairSecondaryMotionDefinitionFixture({
        recipeSource: source.source,
        geometrySha256: await sha256Hex(mainBytes),
        motionNode: options.motionSettings
          ? 'HairFollowerFixtureMotion'
          : options.follower
            ? 'HairFollowerFixtureGeometry'
            : 'HairFixtureGeometry',
        colliderNode: 'HeadAnchor'
      })
    : null
  const physicsBytes = physicsDefinition
    ? new TextEncoder().encode(`${canonicalRecipeString(physicsDefinition)}\n`)
    : undefined
  const asset = await createHairAssetFixture({
    recipeSource: source.source,
    mainBytes,
    headNode: 'HeadAnchor',
    ...(options.motionSettings ? { tags: [HAIR_ROOT_WEIGHTED_MOTION_TAG] } : {}),
    ...(followerDefinition && followerBytes
      ? {
          follower: {
            bytes: followerBytes,
            definitionSha256: await hairFollowerDefinitionSha256(followerDefinition)
          }
        }
      : {}),
    ...(physicsDefinition && physicsBytes
      ? {
          physics: {
            bytes: physicsBytes,
            definitionSha256: await secondaryMotionDefinitionSha256(physicsDefinition)
          }
        }
      : {})
  })
  const hairState = createHairState(asset, {
    motionSettings: options.motionSettings ?? null
  })
  source.state.siblings = [
    ...source.state.siblings,
    {
      id: 'hairState',
      contract: 'hair-state/v2',
      definitionSha256: hairState.definitionSha256,
      stateSha256: await recipeSiblingStateSha256(hairState),
      state: hairState
    }
  ].sort((left, right) => left.id.localeCompare(right.id))
  source.state.stateSha256 = await recipeStateSnapshotSha256(source.state)
  if (options.includeBakeInput !== false) {
    source.hair = {
      asset,
      mainBytes,
      followerBytes,
      physicsBytes,
      neutralValueBytes: Uint8Array.from(HAIR_NEUTRAL_VALUE_PNG_FIXTURE),
      highlightMaskBytes: Uint8Array.from(HAIR_HIGHLIGHT_MASK_PNG_FIXTURE)
    }
  }
  return { asset, hairState, mainBytes, followerBytes, physicsBytes }
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
    expect((parsed.meshes[0]?.primitives as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'targets'
    )
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
    expect(parsed.meshes[0]?.extras).toEqual({
      targetNames: ['blink_runtime']
    })
    expect((parsed.meshes[0]?.primitives as Array<Record<string, unknown>>)[0]).toHaveProperty(
      'targets'
    )
  })

  it('preserves the geometry-bound Skin Artwork Projection in deterministic Live output', async () => {
    const skinAppearance = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/skin-appearance/v1/skin-appearance-v1.json'),
        'utf8'
      )
    ) as Record<string, unknown>
    const skinArtworkProjection = await skinArtworkProjectionFixture()
    const fixture = await createRecipePhysicalMigrationFixture({
      skinAppearance,
      skinArtworkProjection
    })

    const output = await bakeLiveGoon(liveInputFromFixture(fixture))

    expect(output.manifest.skinAppearance).toEqual(skinAppearance)
    expect(skinArtworkProjection.radiusResponse.bakedDriverValue).toBeNull()
    expect(
      (output.manifest.skinArtworkProjection as typeof skinArtworkProjection)
        .radiusResponse.bakedDriverValue
    ).toBe(0)
    expect(output.manifest.skinArtworkProjection).not.toEqual(
      skinArtworkProjection
    )
  })

  it('rejects a Skin Artwork Projection with no Skin Appearance owner', async () => {
    const fixture = await createRecipePhysicalMigrationFixture({
      skinArtworkProjection: await skinArtworkProjectionFixture()
    })

    await expect(bakeLiveGoon(liveInputFromFixture(fixture))).rejects.toThrow(
      'Recipe Skin Artwork Projection has no Skin Appearance owner'
    )
  })

  it('fails loudly instead of producing a Live Goon that silently drops selected Hair bytes', async () => {
    const source = await input()
    await selectFixtureHair(source, { includeBakeInput: false })

    await expect(bakeLiveGoon(source)).rejects.toThrow(
      'missing its immutable Hair Asset bake input'
    )
  })

  it('deterministically embeds selected rigid Hair into the existing self-contained avatar.glb', async () => {
    const bare = await bakeLiveGoon(await input())
    const firstInput = await input()
    const { asset, hairState, mainBytes } = await selectFixtureHair(firstInput)
    const first = await bakeLiveGoon(firstInput)
    const repeatedInput = await input()
    await selectFixtureHair(repeatedInput)
    const repeated = await bakeLiveGoon(repeatedInput)

    expect(first.modelBytes).toEqual(repeated.modelBytes)
    expect(first.manifestBytes).toEqual(repeated.manifestBytes)
    expect(first.packageBytes).toEqual(repeated.packageBytes)
    expect(first.receipt.receiptSha256).toBe(repeated.receipt.receiptSha256)
    expect(first.receipt.output.counts).toMatchObject({
      meshes: bare.receipt.output.counts.meshes + 1,
      vertices: bare.receipt.output.counts.vertices + 3,
      nodes: bare.receipt.output.counts.nodes + 2
    })
    expect(first.receipt.cost).toMatchObject({
      inputBytes:
        bare.receipt.cost.inputBytes +
        mainBytes.byteLength +
        HAIR_NEUTRAL_VALUE_PNG_FIXTURE.byteLength +
        HAIR_HIGHLIGHT_MASK_PNG_FIXTURE.byteLength,
      meshesProcessed: bare.receipt.cost.meshesProcessed + 1,
      verticesProcessed: bare.receipt.cost.verticesProcessed + 3
    })

    const parsed = parseSemanticGlb(first.modelBytes)
    const headIndex = parsed.rawNodeByName.get('HeadAnchor')
    const hairRootIndex = parsed.rawNodeByName.get('HairFixtureRoot')
    expect(headIndex).toBeTypeOf('number')
    expect(hairRootIndex).toBeTypeOf('number')
    expect(parsed.parents.get(hairRootIndex!)).toBe(headIndex)
    expect(parsed.rawNodeByName.has('HairFixtureGeometry')).toBe(true)

    const images = parsed.gltf.images as Array<{
      name: string
      bufferView: number
      mimeType: string
    }>
    const hairImages = images.filter((image) => image.name.startsWith('BatshitHair'))
    expect(hairImages.map((image) => image.name)).toEqual([
      'BatshitHairNeutralValue',
      'BatshitHairHighlightMask'
    ])
    expect(hairImages.map((image) => image.mimeType)).toEqual(['image/png', 'image/png'])
    const bufferViews = parsed.gltf.bufferViews as Array<{
      byteOffset?: number
      byteLength: number
    }>
    const embeddedImageBytes = hairImages.map((image) => {
      const view = bufferViews[image.bufferView]!
      return parsed.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    })
    expect(embeddedImageBytes[0]).toEqual(HAIR_NEUTRAL_VALUE_PNG_FIXTURE)
    expect(embeddedImageBytes[1]).toEqual(HAIR_HIGHLIGHT_MASK_PNG_FIXTURE)

    const textures = parsed.gltf.textures as Array<{ name: string }>
    const neutralTextureIndex = textures.findIndex(
      (texture) => texture.name === 'BatshitHairNeutralValueTexture'
    )
    const highlightTextureIndex = textures.findIndex(
      (texture) => texture.name === 'BatshitHairHighlightMaskTexture'
    )
    const hairMaterial = (parsed.gltf.materials as Array<Record<string, any>>).at(-1)!
    expect(hairMaterial.pbrMetallicRoughness).toMatchObject({
      baseColorTexture: { index: neutralTextureIndex },
      metallicFactor: asset.material.defaults.metalness,
      roughnessFactor: asset.material.defaults.roughness
    })
    expect(hairMaterial.emissiveTexture).toEqual({
      index: highlightTextureIndex
    })
    expect(hairMaterial.emissiveFactor).toEqual([0, 0, 0])
    expect(parseEmbeddedHairMaterial(hairMaterial.extras?.batshitHairMaterial)).toEqual({
      contract: 'embedded-hair-material/v1',
      assetId: asset.assetId,
      revisionId: asset.revisionId,
      materialDefinitionSha256: asset.material.definitionSha256,
      baseColor: hairState.baseColor,
      highlightColor: hairState.highlightColor,
      metalness: asset.material.defaults.metalness,
      roughness: asset.material.defaults.roughness,
      normalTexture: false,
      roughnessTexture: false
    })

    firstInput.hair!.mainBytes.fill(0)
    await expect(
      verifyLiveGoonBakeArtifacts({
        modelBytes: first.modelBytes,
        manifestBytes: first.manifestBytes,
        packageBytes: first.packageBytes,
        receipt: first.receipt
      })
    ).resolves.toMatchObject({
      receipt: { receiptSha256: first.receipt.receiptSha256 }
    })
  })

  it('bakes an immutable H4 follower into final Hair positions and removes every follower morph', async () => {
    const firstInput = await input()
    const { asset, followerBytes } = await selectFixtureHair(firstInput, {
      follower: true
    })
    expect(firstInput.hair!.followerBytes!.byteLength).toBe(asset.follower.asset!.bytes)
    expect(await sha256Hex(firstInput.hair!.followerBytes!)).toBe(asset.follower.asset!.sha256)
    const first = await bakeLiveGoon(firstInput)
    const repeatedInput = await input()
    await selectFixtureHair(repeatedInput, { follower: true })
    const repeated = await bakeLiveGoon(repeatedInput)

    expect(first.modelBytes).toEqual(repeated.modelBytes)
    expect(first.receipt.receiptSha256).toBe(repeated.receipt.receiptSha256)
    expect(first.receipt.cost.inputBytes).toBeGreaterThanOrEqual(followerBytes!.byteLength)

    const parsed = parseSemanticGlb(first.modelBytes)
    const hairMesh = parsed.meshes.find((mesh) => mesh.name === 'HairFollowerFixtureMesh')
    expect(hairMesh).toBeDefined()
    expect(hairMesh?.extras).toBeUndefined()
    expect(hairMesh?.weights).toBeUndefined()
    expect((hairMesh?.primitives as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'targets'
    )
  })

  it('rejects a production H4 Hair selection when its signed follower bytes are absent', async () => {
    const source = await input()
    await selectFixtureHair(source, { follower: true })
    delete source.hair!.followerBytes

    await expect(bakeLiveGoon(source)).rejects.toThrow(
      'production Hair follower is missing its immutable definition bytes'
    )
  })

  it('embeds resolved H5 secondary motion in the self-contained Live Hair root', async () => {
    const firstInput = await input()
    const { asset, physicsBytes } = await selectFixtureHair(firstInput, {
      follower: true,
      physics: true,
      motionSettings: { enabled: true, intensity: 1.1 }
    })
    expect(firstInput.hair!.physicsBytes!.byteLength).toBe(asset.physics.asset!.bytes)
    const first = await bakeLiveGoon(firstInput)
    const repeatedInput = await input()
    await selectFixtureHair(repeatedInput, {
      follower: true,
      physics: true,
      motionSettings: { enabled: true, intensity: 1.1 }
    })
    const repeated = await bakeLiveGoon(repeatedInput)

    expect(first.modelBytes).toEqual(repeated.modelBytes)
    expect(first.receipt.cost.inputBytes).toBeGreaterThanOrEqual(physicsBytes!.byteLength)
    const parsed = parseSemanticGlb(first.modelBytes)
    const hairRoot = parsed.nodes.find((node) => node.name === 'HairFollowerFixtureRoot')
    const embedded = parseEmbeddedSecondaryMotion(
      (hairRoot?.extras as Record<string, unknown> | undefined)?.batshitSecondaryMotion
    )
    expect(embedded).not.toBeNull()
    expect(embedded?.owner).toMatchObject({
      kind: 'hair',
      assetId: asset.assetId,
      revisionId: asset.revisionId
    })
    expect(embedded?.colliders[0]).not.toHaveProperty('drivers')
    expect(embedded?.motionSettings).toEqual({
      enabled: true,
      intensity: 1.1
    })
  })

  it('rejects production H5 Hair when its immutable motion definition is absent', async () => {
    const source = await input()
    await selectFixtureHair(source, {
      physics: true,
      motionSettings: { enabled: true, intensity: 1 }
    })
    delete source.hair!.physicsBytes

    await expect(bakeLiveGoon(source)).rejects.toThrow(
      'production Hair secondary motion is missing its immutable definition bytes'
    )
  })

  it('accepts an explicit None Hair sibling without inventing geometry', async () => {
    const bare = await bakeLiveGoon(await input())
    const source = await input()
    const hairState = createHairState(null)
    const stateSha256 = await recipeSiblingStateSha256(hairState)
    source.state.siblings = [
      ...source.state.siblings,
      {
        id: 'hairState',
        contract: 'hair-state/v2',
        definitionSha256: stateSha256,
        stateSha256,
        state: hairState
      }
    ].sort((left, right) => left.id.localeCompare(right.id))
    source.state.stateSha256 = await recipeStateSnapshotSha256(source.state)

    const output = await bakeLiveGoon(source)
    expect(output.modelBytes).toEqual(bare.modelBytes)
    expect(parseSemanticGlb(output.modelBytes).rawNodeByName.has('HairFixtureRoot')).toBe(false)
  })

  it('keeps deferred sparse accent geometry out of the V1 Live contract', async () => {
    const source = await input()
    await selectFixtureHair(source)
    source.hair!.sparseAccentBytes = createRigidHairGlbFixture()

    await expect(bakeLiveGoon(source)).rejects.toThrow(
      'sparse Hair accent geometry is not supported by the V1 Live Goon contract'
    )
  })
})
