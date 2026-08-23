import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { APPEARANCE_DIAL_VALUES_CONTRACT } from '../appearanceDials.contracts'
import { parseAppearanceDialsManifest } from '../appearanceDials'
import { createHairState } from '../hairAssets'
import { hairFollowerDefinitionSha256 } from '../hairFollowers'
import { createDefaultNailSurfaceState, parseNailSurfaceDefinition } from '../nailSurface'
import {
  HAIR_ROOT_WEIGHTED_MOTION_TAG,
  secondaryMotionDefinitionSha256
} from '../secondaryMotion'
import {
  createDefaultSkinAppearanceState,
  parseSkinAppearanceDefinition
} from '../skinAppearance'
import {
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  createRecipeArchiveContainmentReceipt,
  type RecipeArchiveContainmentReceipt
} from './archiveContainmentContracts'
import {
  GOON_LIVE_BUILD_CONTRACT,
  createGoonLiveBuildReceipt,
  type GoonLiveBuildReceiptContent
} from './liveBuildContracts'
import { canonicalRecipeString, sha256Hex } from './recipeCanonical'
import {
  GOON_RECIPE_STATE_CONTRACT,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  type RecipeSource,
  type RecipeStateSnapshot
} from './recipeContracts'
import {
  buildRecipeStateSnapshot,
  buildRecipeSiblingInputs,
  deriveRecipeAssetSetFromUpload,
  deriveServerAuthorizedRecipePreviewControls,
  RecipeWorkflowClient,
  RecipeWorkflowHttpError,
  resolveRecipeAssetUrl,
  resolveRecipePreviewGoonAssetUrls,
  type RecipeCommitResponse,
  type RecipeCandidateAssetsResponse,
  type RecipeJobActionResponse,
  type RecipeJobRecoveryResponse,
  type RecipeStageResponse
} from './recipeWorkflowClient'
import type { GoonRecord } from '$lib/types/goons'
import type { GoonRecipeJob, GoonRecipeV2 } from './recipeLifecycleContracts'
import type {
  RecipeAnalysisHydration,
  RecipeJobStartResponse,
  RecipeReviewedState
} from './recipeReviewContracts'
import { createRecipePhysicalMigrationFixture } from './fixtures/recipePhysicalMigrationPair'
import {
  createHairAssetFixture,
  createRootWeightedFollowerHairGlbFixture,
  createHairFollowerDefinitionFixture,
  createHairSecondaryMotionDefinitionFixture,
  HAIR_HIGHLIGHT_MASK_PNG_FIXTURE,
  HAIR_NEUTRAL_VALUE_PNG_FIXTURE
} from './fixtures/hairAssetFixture'
import { planAppearanceRecipeMigration } from './appearanceRecipeMigrationPlanner'

const hash = (character: string) => character.repeat(64)
const bytes = (value: string) => new TextEncoder().encode(value)

function minimalGoon(overrides: Partial<GoonRecord> = {}): GoonRecord {
  return {
    id: 'goon_recipe_client',
    user_id: 'user_recipe_client',
    name: 'Recipe Client',
    sourceProfile: 'expert-custom-glb',
    files: {},
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    ...overrides
  }
}

function appearanceState() {
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: hash('1'),
    neutralId: 'neutral_recipe_client',
    neutralRecipeSha256: hash('2'),
    values: { body_height: 0.25 },
    unlockedDialIds: []
  }
}

async function storedArchive(
  packageBytes: Uint8Array,
  modelBytes: Uint8Array,
  manifestBytes: Uint8Array
): Promise<RecipeArchiveContainmentReceipt> {
  const packageSha256 = await sha256Hex(packageBytes)
  const modelSha256 = await sha256Hex(modelBytes)
  const manifestSha256 = await sha256Hex(manifestBytes)
  return createRecipeArchiveContainmentReceipt({
    contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    archiveFormat: 'zip',
    extractor: { id: 'batshit-server-recipe-archive', version: 1 },
    archive: {
      ref: '/uploads/goon_custom_packages/live.bgoon',
      sha256: packageSha256,
      bytes: packageBytes.byteLength
    },
    entryCount: 2,
    totalUncompressedBytes: modelBytes.byteLength + manifestBytes.byteLength,
    members: [
      {
        role: 'manifest',
        path: 'avatar.json',
        sha256: manifestSha256,
        bytes: manifestBytes.byteLength,
        extracted: {
          ref: '/uploads/goon_custom_manifests/live.json',
          sha256: manifestSha256,
          bytes: manifestBytes.byteLength
        }
      },
      {
        role: 'model',
        path: 'avatar.glb',
        sha256: modelSha256,
        bytes: modelBytes.byteLength,
        extracted: {
          ref: '/uploads/goon_custom_models/live.glb',
          sha256: modelSha256,
          bytes: modelBytes.byteLength
        }
      }
    ]
  })
}

async function liveReceipt(
  packageBytes: Uint8Array,
  modelBytes: Uint8Array,
  manifestBytes: Uint8Array,
  state: RecipeStateSnapshot
) {
  const content: GoonLiveBuildReceiptContent = {
    contract: GOON_LIVE_BUILD_CONTRACT,
    source: {
      revisionId: 'recipe_revision_2_client',
      revision: 2,
      packageSha256: hash('3'),
      modelSha256: hash('4'),
      manifestSha256: hash('5'),
      definitionSha256: hash('1'),
      neutralRecipeSha256: hash('2'),
      basisSha256: hash('6')
    },
    state: { contract: state.contract, sha256: state.stateSha256 },
    baker: {
      id: 'batshit-live-goon-baker',
      version: 'r4-v1',
      resolverVersion: 'appearance-recipe-physical-evaluation/v1',
      schemaVersion: 'goon-live-manifest/v1'
    },
    inventory: {
      kept: ['node:/Body/morph:/blink'],
      removed: ['manifest:/appearanceDials', 'node:/Body/morph:/identity'],
      liveMorphTargets: ['node:/Body/morph:/blink'],
      retainedDynamicMorphs: ['node:/Body/morph:/blink'],
      retainedCorrectiveMorphs: []
    },
    proofs: {
      neutralPositionSha256: hash('7'),
      skeletonRestSha256: hash('8'),
      followerSha256: hash('9'),
      rootSha256: hash('a'),
      groundingSha256: hash('b'),
      performanceSha256: hash('c'),
      pivotSha256: hash('d'),
      attachmentSha256: hash('e'),
      validationReportSha256: hash('f'),
      liveManifestProvenanceSha256: hash('0')
    },
    output: {
      package: {
        sha256: await sha256Hex(packageBytes),
        bytes: packageBytes.byteLength
      },
      model: {
        sha256: await sha256Hex(modelBytes),
        bytes: modelBytes.byteLength
      },
      manifest: {
        sha256: await sha256Hex(manifestBytes),
        bytes: manifestBytes.byteLength
      },
      counts: {
        meshes: 1,
        vertices: 3,
        nodes: 1,
        bones: 0,
        morphTargets: 1,
        dynamicMorphTargets: 1,
        correctiveMorphTargets: 0,
        recipeMorphTargets: 0
      }
    },
    cost: {
      inputBytes: 30,
      meshesProcessed: 1,
      verticesProcessed: 3,
      morphTargetsProcessed: 2
    },
    validation: {
      maxWeightScalarError: 0,
      maxVertexErrorMeters: 0,
      maxJointErrorMeters: 0,
      maxNodeTranslationErrorMeters: 0,
      maxPivotErrorMeters: 0,
      maxScaleError: 0,
      maxRotationErrorRadians: 0,
      maxGroundingErrorMeters: 0,
      maxFinalPositionErrorMeters: 0,
      rmsFinalPositionErrorMeters: 0
    }
  }
  return createGoonLiveBuildReceipt(content)
}

function source(
  packageBytes: Uint8Array,
  modelBytes: Uint8Array,
  manifestBytes: Uint8Array
): Promise<RecipeSource> {
  return Promise.all([
    sha256Hex(packageBytes),
    sha256Hex(modelBytes),
    sha256Hex(manifestBytes)
  ]).then(
    ([packageSha256, modelSha256, manifestSha256]) =>
      ({
        package: {
          ref: '/uploads/source/package.bgoon',
          sha256: packageSha256
        },
        model: { ref: '/uploads/source/model.glb', sha256: modelSha256 },
        manifest: {
          ref: '/uploads/source/manifest.json',
          sha256: manifestSha256
        },
        identities: {
          contract: 'recipe-source/v1',
          baseId: 'base_client',
          fitFamily: 'fit_client',
          definitionSha256: hash('1'),
          neutralId: 'neutral_recipe_client',
          neutralRecipeSha256: hash('2'),
          manifestSemanticSha256: hash('3'),
          physicalBasisSha256: hash('4'),
          behaviorSha256: hash('5'),
          componentGraphSha256: hash('6'),
          topologySha256: hash('7'),
          skeletonHierarchySha256: hash('8')
        }
      }) as unknown as RecipeSource
  )
}

async function createFailureWorkflowHarness(
  point: 'upload' | 'registration' | 'staging' | 'commit'
) {
  const sourcePackage = bytes(`failure-source-package-${point}`)
  const sourceModel = bytes(`failure-source-model-${point}`)
  const sourceManifest = bytes(`failure-source-manifest-${point}`)
  const livePackage = bytes(`failure-live-package-${point}`)
  const liveModel = bytes(`failure-live-model-${point}`)
  const liveManifest = bytes(`failure-live-manifest-${point}`)
  const recipeState = await buildRecipeStateSnapshot({
    goon: minimalGoon(),
    appearanceDials: appearanceState()
  })
  const buildReceipt = await liveReceipt(livePackage, liveModel, liveManifest, recipeState)
  const archiveReceipt = await storedArchive(livePackage, liveModel, liveManifest)
  const recipeSource = await source(sourcePackage, sourceModel, sourceManifest)
  const job = {
    jobId: `job_${point}_failure`,
    operation: 'rebake',
    status: 'baking',
    stateVersion: 3,
    targetRevisionId: 'recipe_revision_2_client',
    targetRecipeRevision: 2,
    stagedSource: { source: recipeSource }
  } as GoonRecipeJob
  const started = {
    goon: minimalGoon({ recipe: { writeVersion: 20 } as GoonRecipeV2 }),
    job,
    reviewedState: {
      operation: 'rebake',
      state: recipeState
    } as RecipeReviewedState,
    replayed: false
  } as RecipeJobStartResponse
  const upload = {
    package: {
      url: archiveReceipt.archive.ref,
      filename: 'live.bgoon',
      size: livePackage.byteLength
    },
    model: {
      url: archiveReceipt.members[1].extracted.ref,
      filename: 'live.glb',
      size: liveModel.byteLength
    },
    manifest: {
      url: archiveReceipt.members[0].extracted.ref,
      filename: 'live.json',
      size: liveManifest.byteLength
    },
    archiveReceipt
  }
  const sourceByRef = new Map([
    [recipeSource.package.ref, sourcePackage],
    [recipeSource.model.ref, sourceModel],
    [recipeSource.manifest.ref, sourceManifest]
  ])
  const cleanupCustomPackage = vi.fn(async () => ({
    deleted: [],
    retained: []
  }))
  const uploadCustomPackage = vi.fn(async () => upload)
  const client = new RecipeWorkflowClient(minimalGoon().id, {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const body = sourceByRef.get(String(input))
      return body
        ? new Response(body.slice().buffer, { status: 200 })
        : new Response('missing', { status: 404 })
    }) as typeof fetch,
    assetUrl: (ref) => ref,
    bake: vi.fn(
      async () =>
        ({
          contract: 'goon-live-bake-output/v1' as const,
          packageBytes: livePackage,
          modelBytes: liveModel,
          manifestBytes: liveManifest,
          receipt: buildReceipt,
          manifest: {},
          liveManifest: {},
          audit: {}
        }) as any
    ),
    uploadCustomPackage,
    cleanupCustomPackage
  })
  vi.spyOn(client, 'startBake').mockResolvedValue(started)
  const registered = {
    owner: { writeVersion: 21 } as GoonRecipeV2,
    job: { ...job, status: 'packaging', stateVersion: 4 } as GoonRecipeJob,
    replayed: false
  } as RecipeCandidateAssetsResponse
  const staged = {
    goon: minimalGoon(),
    owner: { writeVersion: 22 } as GoonRecipeV2,
    job: { ...job, status: 'ready', stateVersion: 5 } as GoonRecipeJob
  } as RecipeStageResponse
  const injectedError = new Error(`Injected ${point} failure.`)
  const register = vi.spyOn(client, 'registerCandidateAssets')
  const stage = vi.spyOn(client, 'stageCandidate')
  const commit = vi.spyOn(client, 'commitJob')
  if (point === 'upload') uploadCustomPackage.mockRejectedValue(injectedError)
  if (point === 'registration') register.mockRejectedValue(injectedError)
  else register.mockResolvedValue(registered)
  if (point === 'staging') stage.mockRejectedValue(injectedError)
  else stage.mockResolvedValue(staged)
  if (point === 'commit') commit.mockRejectedValue(injectedError)
  else commit.mockResolvedValue({} as RecipeCommitResponse)
  const recoveryJob =
    point === 'upload' || point === 'registration'
      ? job
      : point === 'staging'
        ? registered.job
        : staged.job
  vi.spyOn(client, 'recoverJob').mockResolvedValue({
    owner: {
      writeVersion:
        point === 'upload' || point === 'registration' ? 20 : point === 'staging' ? 21 : 22
    } as GoonRecipeV2,
    job: recoveryJob
  } as RecipeJobRecoveryResponse)
  const action = vi.spyOn(client, 'actOnJob').mockResolvedValue({} as RecipeJobActionResponse)
  const previewCandidate = vi.fn(async () => undefined)

  return {
    client,
    recipeState,
    archiveReceipt,
    cleanupCustomPackage,
    uploadCustomPackage,
    register,
    stage,
    commit,
    action,
    previewCandidate,
    injectedError
  }
}

describe('Recipe workflow browser client', () => {
  it('resolves stored Recipe upload refs against the browser-facing batshit-server URL', () => {
    expect(
      resolveRecipeAssetUrl('/uploads/goon_custom_manifests/live.json', 'http://127.0.0.1:5651/')
    ).toBe('http://127.0.0.1:5651/uploads/goon_custom_manifests/live.json')
    expect(resolveRecipeAssetUrl('https://cdn.example/live.json', 'http://127.0.0.1:5651')).toBe(
      'https://cdn.example/live.json'
    )
  })

  it('resolves every projected Recipe preview asset through the isolated file server', () => {
    const projected = minimalGoon({
      customAvatar: {
        package: {
          url: '/uploads/goon_custom_packages/source.bgoon',
          filename: 'source.bgoon'
        },
        model: {
          url: '/uploads/goon_custom_models/source.glb',
          filename: 'source.glb'
        },
        manifest: {
          url: '/uploads/goon_custom_manifests/source.json',
          filename: 'source.json'
        }
      }
    })

    const resolved = resolveRecipePreviewGoonAssetUrls(projected, 'http://127.0.0.1:5651/')

    expect(resolved.customAvatar?.package?.url).toBe(
      'http://127.0.0.1:5651/uploads/goon_custom_packages/source.bgoon'
    )
    expect(resolved.customAvatar?.model?.url).toBe(
      'http://127.0.0.1:5651/uploads/goon_custom_models/source.glb'
    )
    expect(resolved.customAvatar?.manifest?.url).toBe(
      'http://127.0.0.1:5651/uploads/goon_custom_manifests/source.json'
    )
    expect(projected.customAvatar?.manifest?.url).toBe('/uploads/goon_custom_manifests/source.json')
  })

  it('refreshes the Goon after source upload so a runtime-only camera save cannot stale initial preparation', async () => {
    const packageBytes = bytes('recipe-source-package')
    const modelBytes = bytes('recipe-source-model')
    const manifestBytes = bytes('recipe-source-manifest')
    const archiveReceipt = await storedArchive(packageBytes, modelBytes, manifestBytes)
    const sourcePackage = {
      url: 'http://localhost:5600/uploads/goon_custom_packages/source.bgoon',
      filename: 'source.bgoon',
      size: packageBytes.byteLength
    }
    const goon = minimalGoon({
      customAvatar: { package: sourcePackage }
    })
    const state = await buildRecipeStateSnapshot({
      goon,
      appearanceDials: appearanceState()
    })
    const latestGoon = minimalGoon({
      updated_at: '2026-07-17T00:00:01.000Z',
      camera: { mode: 'free', fov: 42 },
      customAvatar: { package: sourcePackage }
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === sourcePackage.url) return new Response(packageBytes)
      if (url === `/api/goons/${goon.id}`) {
        return new Response(JSON.stringify(latestGoon), {
          headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const uploadCustomPackage = vi.fn(async () => ({ archiveReceipt }))
    const cleanupCustomPackage = vi.fn(async () => ({
      deleted: [],
      retained: []
    }))
    const client = new RecipeWorkflowClient(goon.id, {
      fetchImpl: fetchImpl as typeof fetch,
      uploadCustomPackage: uploadCustomPackage as any,
      cleanupCustomPackage
    })
    const initialized = {
      goon: latestGoon,
      owner: { writeVersion: 1 } as GoonRecipeV2,
      containmentReceipt: {
        contract: 'goon-recipe-document-ref/v1',
        ref: 'doc',
        sha256: hash('a')
      }
    }
    const initialize = vi.spyOn(client, 'initialize').mockResolvedValue(initialized as any)

    await expect(client.initializeFromCurrentPackage(goon, state)).resolves.toBe(initialized)

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: latestGoon.updated_at }),
      expect.any(Object)
    )
    expect(cleanupCustomPackage).not.toHaveBeenCalled()
  })

  it('fails closed and removes the temporary upload if the source package changes during preparation', async () => {
    const packageBytes = bytes('recipe-source-package')
    const archiveReceipt = await storedArchive(
      packageBytes,
      bytes('recipe-source-model'),
      bytes('recipe-source-manifest')
    )
    const goon = minimalGoon({
      customAvatar: {
        package: {
          url: 'http://localhost:5600/uploads/goon_custom_packages/source.bgoon',
          filename: 'source.bgoon',
          size: packageBytes.byteLength
        }
      }
    })
    const latestGoon = minimalGoon({
      updated_at: '2026-07-17T00:00:01.000Z',
      customAvatar: {
        package: {
          url: '/uploads/goon_custom_packages/replaced.bgoon',
          filename: 'replaced.bgoon',
          size: packageBytes.byteLength
        }
      }
    })
    const state = await buildRecipeStateSnapshot({
      goon,
      appearanceDials: appearanceState()
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === goon.customAvatar?.package?.url) return new Response(packageBytes)
      if (url === `/api/goons/${goon.id}`) return new Response(JSON.stringify(latestGoon))
      throw new Error(`Unexpected request: ${url}`)
    })
    const uploadCustomPackage = vi.fn(async () => ({ archiveReceipt }))
    const cleanupCustomPackage = vi.fn(async () => ({
      deleted: ['temporary'],
      retained: []
    }))
    const client = new RecipeWorkflowClient(goon.id, {
      fetchImpl: fetchImpl as typeof fetch,
      uploadCustomPackage: uploadCustomPackage as any,
      cleanupCustomPackage
    })
    const initialize = vi.spyOn(client, 'initialize')

    await expect(client.initializeFromCurrentPackage(goon, state)).rejects.toThrow(
      'The Goon file changed while initial preparation was starting'
    )

    expect(initialize).not.toHaveBeenCalled()
    expect(cleanupCustomPackage).toHaveBeenCalledWith(goon.id, archiveReceipt)
  })

  it('resumes a verified ready candidate at preview instead of replaying completed bake stages', async () => {
    const goon = minimalGoon()
    const live = {
      package: {
        ref: '/uploads/goon_custom_packages/ready.bgoon',
        sha256: hash('1'),
        bytes: 10
      },
      model: {
        ref: '/uploads/goon_custom_models/ready.glb',
        sha256: hash('2'),
        bytes: 20
      },
      manifest: {
        ref: '/uploads/goon_custom_manifests/ready.json',
        sha256: hash('3'),
        bytes: 30
      }
    }
    const recovery = {
      goon,
      owner: { writeVersion: 41 } as GoonRecipeV2,
      job: {
        jobId: 'recipe_job_ready_resume',
        goonId: goon.id,
        status: 'ready',
        stateVersion: 8,
        stagedLive: live
      } as GoonRecipeJob,
      candidate: { live } as any,
      reviewedState: {} as RecipeReviewedState,
      recovered: false
    } as RecipeJobRecoveryResponse
    const client = new RecipeWorkflowClient(goon.id)
    const previewCandidate = vi.fn(async () => undefined)
    const committed = { goon } as RecipeCommitResponse
    const commit = vi.spyOn(client, 'commitJob').mockResolvedValue(committed)

    await expect(client.resumeReadyCandidate({ recovery, previewCandidate })).resolves.toBe(
      committed
    )

    expect(previewCandidate).toHaveBeenCalledWith({
      goon,
      owner: recovery.owner,
      job: recovery.job,
      envelope: recovery.candidate
    })
    expect(commit).toHaveBeenCalledWith('recipe_job_ready_resume', {
      expectedWriteVersion: 41,
      expectedJobStateVersion: 8
    })
    expect(previewCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      commit.mock.invocationCallOrder[0]
    )
  })

  it('builds one deterministic Recipe State and preserves definition-bound siblings', async () => {
    const goon = minimalGoon({
      facialArtwork: {
        schemaVersion: 'facial-artwork-state/v3',
        definitionSha256: hash('a'),
        templateSet: { id: 'template', version: '1' },
        roles: {}
      } as GoonRecord['facialArtwork'],
      eyeAppearance: {
        schemaVersion: 'eye-appearance-state/v1',
        definitionSha256: hash('b'),
        irisSize: 1,
        pupilSize: 1,
        eyeConvergence: 0,
        scleraFit: { scale: 1, tilt: 0, horizontal: 0, vertical: 0, depth: 0 }
      },
      oralAppearance: {
        schemaVersion: 'oral-appearance-state/v1',
        definitionSha256: hash('c'),
        values: { tongue_rest: 0.25 }
      },
      nailSurface: {
        schemaVersion: 'nail-surface-state/v1',
        definitionSha256: hash('d'),
        geometry: {},
        appearance: {}
      } as unknown as GoonRecord['nailSurface'],
      lipArtworkPresence: {
        schemaVersion: 'lip-artwork-presence-state/v1',
        definitionSha256: hash('f'),
        enabled: false
      },
      nailSurfacePresence: {
        schemaVersion: 'nail-surface-presence-state/v1',
        definitionSha256: hash('d'),
        enabled: false
      },
      skinAppearance: {
        schemaVersion: 'skin-appearance-state/v2',
        definitionSha256: hash('e'),
        surface: {},
        regions: {}
      } as unknown as GoonRecord['skinAppearance'],
      skinMaterialArtwork: {
        schemaVersion: 'skin-material-artwork-state/v2',
        definitionSha256: hash('e'),
        baseColor: {},
        tint: [1, 1, 1]
      } as unknown as GoonRecord['skinMaterialArtwork'],
      hairState: {
        schemaVersion: 'hair-state/v2',
        definitionSha256: hash('9'),
        selected: {
          assetId: 'style-01',
          assetRevisionId: 'style-01-r1',
          assetRevision: 1,
          assetRevisionSha256: hash('9'),
          fitFamily: 'batshit-base-female-v1',
          fitSha256: hash('8')
        },
        baseColor: '#2a1738',
        highlightColor: '#6f4a8e',
        motionSettings: {
          enabled: true,
          intensity: 1.1
        }
      }
    })

    const first = await buildRecipeStateSnapshot({
      goon,
      appearanceDials: appearanceState()
    })
    const second = await buildRecipeStateSnapshot({
      goon,
      appearanceDials: appearanceState()
    })

    expect(first).toEqual(second)
    expect(first.siblings.map((entry) => entry.id)).toEqual([
      'eyeAppearance',
      'facialArtwork',
      'hairState',
      'lipArtworkPresence',
      'nailSurface',
      'nailSurfacePresence',
      'oralAppearance',
      'skinAppearance'
    ])
    expect(first.siblings.every((entry) => /^[a-f0-9]{64}$/.test(entry.stateSha256))).toBe(true)
    expect(first.siblings.find((entry) => entry.id === 'hairState')?.state).toMatchObject({
      motionSettings: { enabled: true, intensity: 1.1 }
    })
    expect(first.stateSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('replaces or removes the managed Anatomy Fit sibling instead of retaining stale output', async () => {
    const definitionSha256 = hash('d')
    const fitted = await buildRecipeStateSnapshot({
      goon: minimalGoon(),
      appearanceDials: appearanceState(),
      anatomyFitState: {
        id: 'anatomy-fit',
        contract: 'anatomy-fit-state/v2',
        definitionSha256,
        state: {
          contract: 'anatomy-fit-state/v2',
          definitionSha256,
          fits: [],
          stateSha256: hash('e')
        }
      }
    })
    expect(fitted.siblings.map((entry) => entry.id)).toEqual(['anatomy-fit'])

    const retained = minimalGoon({
      recipe: {
        authoringRevision: { state: fitted }
      } as unknown as GoonRecipeV2
    })
    const removed = await buildRecipeStateSnapshot({
      goon: retained,
      appearanceDials: appearanceState(),
      anatomyFitState: null
    })
    expect(removed.siblings).toEqual([])
  })

  it('derives all sibling analysis bindings from the exact state, target manifest, and edge', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()

    const siblingInputs = await buildRecipeSiblingInputs({
      state: fixture.sourceState,
      targetManifest: fixture.target.avatarManifest,
      edge: fixture.edge
    })

    expect(Object.keys(siblingInputs).sort()).toEqual([
      'eyeAppearance',
      'facialArtwork',
      'oralAppearance'
    ])
    expect(
      Object.values(siblingInputs).every(
        (input) =>
          input.sourceStateId === null &&
          input.targetStateId === null &&
          input.targetDefinition === null
      )
    ).toBe(true)
  })

  it('derives package sibling bindings while retaining selected Hair as an external sibling', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const state = await buildRecipeStateSnapshot({
      goon: minimalGoon({
        hairState: {
          schemaVersion: 'hair-state/v2',
          definitionSha256: hash('9'),
          selected: {
            assetId: 'style-01',
            assetRevisionId: 'style-01-r1',
            assetRevision: 1,
            assetRevisionSha256: hash('9'),
            fitFamily: 'batshit-base-female-v1',
            fitSha256: hash('8')
          },
          baseColor: '#2a1738',
          highlightColor: '#6f4a8e',
          motionSettings: { enabled: true, intensity: 1.1 }
        }
      }),
      appearanceDials: fixture.sourceState.appearanceDials
    })

    await expect(
      buildRecipeSiblingInputs({
        state,
        targetManifest: fixture.target.avatarManifest,
        edge: fixture.edge
      })
    ).resolves.toMatchObject({
      eyeAppearance: { sourceStateId: null },
      facialArtwork: { sourceStateId: null },
      oralAppearance: { sourceStateId: null }
    })
  })

  it('recognizes exact Nail Surface and Skin Appearance state as package-managed siblings', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const nailRaw = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/nail-surface/v1/nail-surface-v1.json'),
        'utf8'
      )
    )
    const skinRaw = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/skin-appearance/v1/skin-appearance-v1.json'),
        'utf8'
      )
    )
    const nail = parseNailSurfaceDefinition(nailRaw)
    const skin = parseSkinAppearanceDefinition(skinRaw)
    const nailState = createDefaultNailSurfaceState(nail)
    const skinState = createDefaultSkinAppearanceState(skin)
    const state = structuredClone(fixture.sourceState)
    state.siblings.push(
      {
        id: 'nailSurface',
        contract: nailState.schemaVersion,
        definitionSha256: nail.definitionSha256,
        stateSha256: await recipeSiblingStateSha256(nailState),
        state: nailState
      },
      {
        id: 'skinAppearance',
        contract: skinState.schemaVersion,
        definitionSha256: skin.definitionSha256,
        stateSha256: await recipeSiblingStateSha256(skinState),
        state: skinState
      }
    )
    state.siblings.sort((left, right) => left.id.localeCompare(right.id))
    state.stateSha256 = await recipeStateSnapshotSha256(state)

    await expect(
      buildRecipeSiblingInputs({
        state,
        targetManifest: {
          ...fixture.target.avatarManifest,
          nailSurface: nailRaw,
          skinAppearance: skinRaw
        },
        edge: fixture.edge
      })
    ).resolves.toMatchObject({
      eyeAppearance: { sourceStateId: null },
      facialArtwork: { sourceStateId: null },
      oralAppearance: { sourceStateId: null }
    })
  })

  it('uses the server-authored proposed state for initial Analyze preview controls', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const plan = await planAppearanceRecipeMigration({
      planId: 'migration.recipe-client.initial-preview',
      fromRecipeRevision: 1,
      edge: fixture.edge,
      sourceState: fixture.sourceState,
      sourcePackage: {
        recipeSource: fixture.source.recipeSource,
        packageBytes: fixture.source.packageBytes,
        glbBytes: fixture.source.glbBytes,
        manifestBytes: fixture.source.manifestBytes
      },
      targetPackage: {
        recipeSource: fixture.target.recipeSource,
        packageBytes: fixture.target.packageBytes,
        glbBytes: fixture.target.glbBytes,
        manifestBytes: fixture.target.manifestBytes
      },
      siblingInputs: fixture.siblingInputs,
      componentMapBundle: fixture.componentMapBundle
    })
    const manifest = parseAppearanceDialsManifest(fixture.target.avatarManifest)
    expect(manifest).not.toBeNull()

    const controls = await deriveServerAuthorizedRecipePreviewControls(
      {
        plan,
        reviewedState: null
      } as RecipeAnalysisHydration,
      manifest!
    )

    expect(controls).toContainEqual(
      expect.objectContaining({
        authorization: 'server-verified',
        id: 'new_control',
        classification: 'new',
        value: 0
      })
    )
  })

  it('derives complete stored Live assets from the verified archive receipt', async () => {
    const packageBytes = bytes('live-package')
    const modelBytes = bytes('live-model')
    const manifestBytes = bytes('live-manifest')
    const receipt = await storedArchive(packageBytes, modelBytes, manifestBytes)
    const upload = {
      package: {
        url: 'http://localhost:5600/uploads/goon_custom_packages/live.bgoon',
        filename: 'live.bgoon',
        size: packageBytes.byteLength
      },
      model: {
        url: 'http://localhost:5600/uploads/goon_custom_models/live.glb',
        filename: 'live.glb',
        size: modelBytes.byteLength
      },
      manifest: {
        url: 'http://localhost:5600/uploads/goon_custom_manifests/live.json',
        filename: 'live.json',
        size: manifestBytes.byteLength
      },
      archiveReceipt: receipt
    }

    const live = await deriveRecipeAssetSetFromUpload(upload)

    expect(live).toEqual({
      package: receipt.archive,
      model: receipt.members[1].extracted,
      manifest: receipt.members[0].extracted
    })
    expect(live.package).toMatchObject({
      sha256: await sha256Hex(packageBytes),
      bytes: packageBytes.byteLength
    })
  })

  it('bakes exact server state, registers upload ownership, stages, then commits with current CAS', async () => {
    const sourcePackage = bytes('source-package')
    const sourceModel = bytes('source-model')
    const sourceManifest = bytes('source-manifest')
    const livePackage = bytes('live-package')
    const liveModel = bytes('live-model')
    const liveManifest = bytes('live-manifest')
    const recipeSource = await source(sourcePackage, sourceModel, sourceManifest)
    const hairBytes = createRootWeightedFollowerHairGlbFixture()
    const followerDefinition = createHairFollowerDefinitionFixture({
      recipeSource,
      geometrySha256: await sha256Hex(hairBytes),
      headNode: 'HeadAnchor'
    })
    const followerBytes = bytes(`${canonicalRecipeString(followerDefinition)}\n`)
    const physicsDefinition = createHairSecondaryMotionDefinitionFixture({
      recipeSource,
      geometrySha256: await sha256Hex(hairBytes),
      motionNode: 'HairFollowerFixtureMotion',
      colliderNode: 'HeadAnchor'
    })
    const physicsBytes = bytes(`${canonicalRecipeString(physicsDefinition)}\n`)
    const hairAsset = await createHairAssetFixture({
      recipeSource,
      mainBytes: hairBytes,
      headNode: 'HeadAnchor',
      tags: [HAIR_ROOT_WEIGHTED_MOTION_TAG],
      follower: {
        bytes: followerBytes,
        definitionSha256: await hairFollowerDefinitionSha256(followerDefinition)
      },
      physics: {
        bytes: physicsBytes,
        definitionSha256: await secondaryMotionDefinitionSha256(physicsDefinition)
      }
    })
    const recipeState = await buildRecipeStateSnapshot({
      goon: minimalGoon({ hairState: createHairState(hairAsset) }),
      appearanceDials: appearanceState()
    })
    const buildReceipt = await liveReceipt(livePackage, liveModel, liveManifest, recipeState)
    const archiveReceipt = await storedArchive(livePackage, liveModel, liveManifest)
    const job = {
      jobId: 'job_client',
      operation: 'package-update',
      status: 'baking',
      stateVersion: 4,
      targetRevisionId: 'recipe_revision_2_client',
      targetRecipeRevision: 2,
      stagedSource: { source: recipeSource }
    } as GoonRecipeJob
    const reviewedState = {
      operation: 'package-update',
      state: recipeState
    } as RecipeReviewedState
    const started = {
      goon: minimalGoon({ recipe: { writeVersion: 11 } as GoonRecipeV2 }),
      job,
      reviewedState,
      replayed: false
    } as RecipeJobStartResponse
    const upload = {
      package: {
        url: archiveReceipt.archive.ref,
        filename: 'live.bgoon',
        size: livePackage.byteLength
      },
      model: {
        url: archiveReceipt.members[1].extracted.ref,
        filename: 'live.glb',
        size: liveModel.byteLength
      },
      manifest: {
        url: archiveReceipt.members[0].extracted.ref,
        filename: 'live.json',
        size: liveManifest.byteLength
      },
      archiveReceipt
    }
    const sourceByRef = new Map([
      [recipeSource.package.ref, sourcePackage],
      [recipeSource.model.ref, sourceModel],
      [recipeSource.manifest.ref, sourceManifest],
      [hairAsset.geometry.main.ref, hairBytes],
      [hairAsset.follower.asset!.ref, followerBytes],
      [hairAsset.physics.asset!.ref, physicsBytes],
      [hairAsset.material.neutralValueTexture!.ref, HAIR_NEUTRAL_VALUE_PNG_FIXTURE],
      [hairAsset.material.highlightMask!.ref, HAIR_HIGHLIGHT_MASK_PNG_FIXTURE]
    ])
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/goons/hair-assets/h1-test-hair/h1-test-hair-r1?sha256=')) {
        return new Response(JSON.stringify({ asset: hairAsset }), {
          status: 200
        })
      }
      const body = sourceByRef.get(String(input))
      return body
        ? new Response(body.slice().buffer, { status: 200 })
        : new Response('missing', { status: 404 })
    })
    const bake = vi.fn(
      async (input) =>
        ({
          contract: 'goon-live-bake-output/v1' as const,
          packageBytes: livePackage,
          modelBytes: liveModel,
          manifestBytes: liveManifest,
          receipt: buildReceipt,
          manifest: {},
          liveManifest: {},
          audit: {}
        }) as any
    )
    const client = new RecipeWorkflowClient(minimalGoon().id, {
      fetchImpl: fetchImpl as typeof fetch,
      assetUrl: (ref) => ref,
      bake,
      uploadCustomPackage: vi.fn(async () => upload)
    })
    vi.spyOn(client, 'startPackageUpdate').mockResolvedValue(started)
    const registered = {
      owner: { writeVersion: 12 } as GoonRecipeV2,
      job: { ...job, stateVersion: 5 } as GoonRecipeJob,
      replayed: false
    } as RecipeCandidateAssetsResponse
    const register = vi.spyOn(client, 'registerCandidateAssets').mockResolvedValue(registered)
    const staged = {
      owner: { writeVersion: 13 } as GoonRecipeV2,
      job: { ...job, status: 'ready', stateVersion: 6 } as GoonRecipeJob
    } as RecipeStageResponse
    const stage = vi.spyOn(client, 'stageCandidate').mockResolvedValue(staged)
    const commit = vi.spyOn(client, 'commitJob').mockResolvedValue({} as RecipeCommitResponse)
    const previewCandidate = vi.fn(async () => undefined)

    const result = await client.buildUploadStageCommit({
      start: {
        kind: 'package-update',
        request: {
          expectedWriteVersion: 11,
          idempotencyKey: 'client-key',
          analysisId: 'analysis_client'
        }
      },
      previewCandidate
    })

    const [bakeInput, bakeOptions] = bake.mock.calls[0]
    expect(bakeInput.state).toEqual(recipeState)
    expect(bakeInput.source).toEqual(recipeSource)
    expect(Array.from(bakeInput.packageBytes)).toEqual(Array.from(sourcePackage))
    expect(Array.from(bakeInput.modelBytes)).toEqual(Array.from(sourceModel))
    expect(Array.from(bakeInput.manifestBytes)).toEqual(Array.from(sourceManifest))
    expect(bakeInput.hair.asset).toEqual(hairAsset)
    expect(Array.from(bakeInput.hair.mainBytes)).toEqual(Array.from(hairBytes))
    expect(Array.from(bakeInput.hair.followerBytes)).toEqual(Array.from(followerBytes))
    expect(Array.from(bakeInput.hair.physicsBytes)).toEqual(Array.from(physicsBytes))
    expect(Array.from(bakeInput.hair.neutralValueBytes)).toEqual(
      Array.from(HAIR_NEUTRAL_VALUE_PNG_FIXTURE)
    )
    expect(Array.from(bakeInput.hair.highlightMaskBytes)).toEqual(
      Array.from(HAIR_HIGHLIGHT_MASK_PNG_FIXTURE)
    )
    expect(bakeOptions).toEqual({ signal: undefined, onProgress: undefined })
    expect(register).toHaveBeenCalledWith('job_client', {
      expectedWriteVersion: 11,
      expectedJobStateVersion: 4,
      live: result.live
    })
    expect(stage).toHaveBeenCalledWith(
      'job_client',
      expect.objectContaining({
        expectedWriteVersion: 12,
        expectedJobStateVersion: 5,
        liveBuildReceipt: buildReceipt,
        live: result.live
      })
    )
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(stage.mock.invocationCallOrder[0])
    expect(previewCandidate).toHaveBeenCalledWith(staged)
    expect(stage.mock.invocationCallOrder[0]).toBeLessThan(
      previewCandidate.mock.invocationCallOrder[0]
    )
    expect(previewCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      commit.mock.invocationCallOrder[0]
    )
    expect(commit).toHaveBeenCalledWith('job_client', {
      expectedWriteVersion: 13,
      expectedJobStateVersion: 6
    })
  })

  it('records post-Start failures durably before rejecting', async () => {
    const sourcePackage = bytes('source-package')
    const sourceModel = bytes('source-model')
    const sourceManifest = bytes('source-manifest')
    const recipeState = await buildRecipeStateSnapshot({
      goon: minimalGoon(),
      appearanceDials: appearanceState()
    })
    const recipeSource = await source(sourcePackage, sourceModel, sourceManifest)
    const job = {
      jobId: 'job_failure',
      operation: 'rebake',
      status: 'baking',
      stateVersion: 3,
      targetRevisionId: 'recipe_revision_3_client',
      targetRecipeRevision: 3,
      stagedSource: { source: recipeSource }
    } as GoonRecipeJob
    const started = {
      goon: minimalGoon({ recipe: { writeVersion: 20 } as GoonRecipeV2 }),
      job,
      reviewedState: {
        operation: 'rebake',
        state: recipeState
      } as RecipeReviewedState,
      replayed: false
    } as RecipeJobStartResponse
    const sourceByRef = new Map([
      [recipeSource.package.ref, sourcePackage],
      [recipeSource.model.ref, sourceModel],
      [recipeSource.manifest.ref, sourceManifest]
    ])
    const client = new RecipeWorkflowClient(minimalGoon().id, {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const body = sourceByRef.get(String(input))!
        return new Response(body.slice().buffer)
      }) as typeof fetch,
      assetUrl: (ref) => ref,
      bake: vi.fn(async () => {
        const error = new Error('Worker canceled')
        error.name = 'AbortError'
        throw error
      })
    })
    vi.spyOn(client, 'startBake').mockResolvedValue(started)
    const recovery = {
      owner: { writeVersion: 21 } as GoonRecipeV2,
      job: { ...job, stateVersion: 4 } as GoonRecipeJob
    } as RecipeJobRecoveryResponse
    vi.spyOn(client, 'recoverJob').mockResolvedValue(recovery)
    const action = vi.spyOn(client, 'actOnJob').mockResolvedValue({} as RecipeJobActionResponse)

    await expect(
      client.buildUploadStageCommit({
        start: {
          kind: 'bake',
          request: {
            expectedWriteVersion: 20,
            idempotencyKey: 'rebake-key',
            state: recipeState
          }
        },
        previewCandidate: vi.fn(async () => undefined)
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(action).toHaveBeenCalledWith(
      'job_failure',
      expect.objectContaining({
        action: 'fail',
        expectedWriteVersion: 21,
        expectedJobStateVersion: 4,
        stage: 'baking',
        reason: 'Worker canceled'
      })
    )
  })

  it('records the exact source ref when a Recipe asset load fails before baking', async () => {
    const sourcePackage = bytes('source-package')
    const sourceModel = bytes('source-model')
    const sourceManifest = bytes('source-manifest')
    const recipeState = await buildRecipeStateSnapshot({
      goon: minimalGoon(),
      appearanceDials: appearanceState()
    })
    const recipeSource = await source(sourcePackage, sourceModel, sourceManifest)
    const job = {
      jobId: 'job_source_load_failure',
      operation: 'first-bake',
      status: 'validating',
      stateVersion: 3,
      targetRevisionId: 'recipe_revision_1_source_load',
      targetRecipeRevision: 1,
      stagedSource: { source: recipeSource }
    } as GoonRecipeJob
    const started = {
      goon: minimalGoon({ recipe: { writeVersion: 20 } as GoonRecipeV2 }),
      job,
      reviewedState: {
        operation: 'first-bake',
        state: recipeState
      } as RecipeReviewedState,
      replayed: false
    } as RecipeJobStartResponse
    const client = new RecipeWorkflowClient(minimalGoon().id, {
      fetchImpl: vi.fn(async () => {
        throw new TypeError('Load failed')
      }) as typeof fetch,
      assetUrl: (ref) => ref
    })
    vi.spyOn(client, 'startBake').mockResolvedValue(started)
    vi.spyOn(client, 'recoverJob').mockResolvedValue({
      owner: { writeVersion: 21 } as GoonRecipeV2,
      job: { ...job, stateVersion: 4 }
    } as RecipeJobRecoveryResponse)
    const action = vi.spyOn(client, 'actOnJob').mockResolvedValue({} as RecipeJobActionResponse)

    await expect(
      client.buildUploadStageCommit({
        start: {
          kind: 'bake',
          request: {
            expectedWriteVersion: 20,
            idempotencyKey: 'source-load-key',
            state: recipeState
          }
        },
        previewCandidate: vi.fn(async () => undefined)
      })
    ).rejects.toThrow(`Failed to load exact Recipe asset ${recipeSource.package.ref}: Load failed`)

    expect(action).toHaveBeenCalledWith(
      'job_source_load_failure',
      expect.objectContaining({
        action: 'fail',
        expectedWriteVersion: 21,
        expectedJobStateVersion: 4,
        stage: 'validating',
        reason: `Failed to load exact Recipe asset ${recipeSource.package.ref}: Load failed`
      })
    )
  })

  it('records preview-load failure durably and never commits the staged candidate', async () => {
    const sourcePackage = bytes('preview-source-package')
    const sourceModel = bytes('preview-source-model')
    const sourceManifest = bytes('preview-source-manifest')
    const livePackage = bytes('preview-live-package')
    const liveModel = bytes('preview-live-model')
    const liveManifest = bytes('preview-live-manifest')
    const recipeState = await buildRecipeStateSnapshot({
      goon: minimalGoon(),
      appearanceDials: appearanceState()
    })
    const buildReceipt = await liveReceipt(livePackage, liveModel, liveManifest, recipeState)
    const archiveReceipt = await storedArchive(livePackage, liveModel, liveManifest)
    const recipeSource = await source(sourcePackage, sourceModel, sourceManifest)
    const job = {
      jobId: 'job_preview_failure',
      operation: 'rebake',
      status: 'baking',
      stateVersion: 3,
      targetRevisionId: 'recipe_revision_3_preview',
      targetRecipeRevision: 3,
      stagedSource: { source: recipeSource }
    } as GoonRecipeJob
    const started = {
      goon: minimalGoon({ recipe: { writeVersion: 20 } as GoonRecipeV2 }),
      job,
      reviewedState: {
        operation: 'rebake',
        state: recipeState
      } as RecipeReviewedState,
      replayed: false
    } as RecipeJobStartResponse
    const upload = {
      package: {
        url: archiveReceipt.archive.ref,
        filename: 'live.bgoon',
        size: livePackage.byteLength
      },
      model: {
        url: archiveReceipt.members[1].extracted.ref,
        filename: 'live.glb',
        size: liveModel.byteLength
      },
      manifest: {
        url: archiveReceipt.members[0].extracted.ref,
        filename: 'live.json',
        size: liveManifest.byteLength
      },
      archiveReceipt
    }
    const sourceByRef = new Map([
      [recipeSource.package.ref, sourcePackage],
      [recipeSource.model.ref, sourceModel],
      [recipeSource.manifest.ref, sourceManifest]
    ])
    const cleanupCustomPackage = vi.fn(async () => ({
      deleted: [],
      retained: []
    }))
    const client = new RecipeWorkflowClient(minimalGoon().id, {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const body = sourceByRef.get(String(input))
        return body
          ? new Response(body.slice().buffer, { status: 200 })
          : new Response('missing', { status: 404 })
      }) as typeof fetch,
      assetUrl: (ref) => ref,
      bake: vi.fn(
        async () =>
          ({
            contract: 'goon-live-bake-output/v1' as const,
            packageBytes: livePackage,
            modelBytes: liveModel,
            manifestBytes: liveManifest,
            receipt: buildReceipt,
            manifest: {},
            liveManifest: {},
            audit: {}
          }) as any
      ),
      uploadCustomPackage: vi.fn(async () => upload),
      cleanupCustomPackage
    })
    vi.spyOn(client, 'startBake').mockResolvedValue(started)
    vi.spyOn(client, 'registerCandidateAssets').mockResolvedValue({
      owner: { writeVersion: 21 } as GoonRecipeV2,
      job: { ...job, status: 'packaging', stateVersion: 4 } as GoonRecipeJob,
      replayed: false
    } as RecipeCandidateAssetsResponse)
    const staged = {
      goon: minimalGoon(),
      owner: { writeVersion: 22 } as GoonRecipeV2,
      job: { ...job, status: 'ready', stateVersion: 5 } as GoonRecipeJob
    } as RecipeStageResponse
    vi.spyOn(client, 'stageCandidate').mockResolvedValue(staged)
    const commit = vi.spyOn(client, 'commitJob')
    vi.spyOn(client, 'recoverJob').mockResolvedValue({
      owner: { writeVersion: 22 } as GoonRecipeV2,
      job: staged.job
    } as RecipeJobRecoveryResponse)
    const action = vi.spyOn(client, 'actOnJob').mockResolvedValue({} as RecipeJobActionResponse)

    await expect(
      client.buildUploadStageCommit({
        start: {
          kind: 'bake',
          request: {
            expectedWriteVersion: 20,
            idempotencyKey: 'preview-key',
            state: recipeState
          }
        },
        previewCandidate: vi.fn(async () => {
          throw new Error('Candidate GLB could not be loaded')
        })
      })
    ).rejects.toThrow('Candidate GLB could not be loaded')

    expect(commit).not.toHaveBeenCalled()
    expect(cleanupCustomPackage).toHaveBeenCalledWith(minimalGoon().id, archiveReceipt)
    expect(action).toHaveBeenCalledWith(
      'job_preview_failure',
      expect.objectContaining({
        action: 'fail',
        expectedWriteVersion: 22,
        expectedJobStateVersion: 5,
        stage: 'preview-load',
        reason: 'Candidate GLB could not be loaded'
      })
    )
  })

  it.each([
    { point: 'upload', stage: 'upload', previewed: false },
    { point: 'registration', stage: 'packaging', previewed: false },
    { point: 'staging', stage: 'verifying', previewed: false },
    { point: 'commit', stage: 'committing', previewed: true }
  ] as const)(
    'preserves durable ownership and records $point failure before rejecting',
    async ({ point, stage: failureStage, previewed }) => {
      const harness = await createFailureWorkflowHarness(point)

      await expect(
        harness.client.buildUploadStageCommit({
          start: {
            kind: 'bake',
            request: {
              expectedWriteVersion: 20,
              idempotencyKey: `${point}-failure-key`,
              state: harness.recipeState
            }
          },
          previewCandidate: harness.previewCandidate
        })
      ).rejects.toThrow(harness.injectedError.message)

      if (point === 'upload') {
        expect(harness.cleanupCustomPackage).not.toHaveBeenCalled()
      } else {
        expect(harness.cleanupCustomPackage).toHaveBeenCalledWith(
          minimalGoon().id,
          harness.archiveReceipt
        )
      }
      expect(harness.action).toHaveBeenCalledWith(
        `job_${point}_failure`,
        expect.objectContaining({
          action: 'fail',
          stage: failureStage,
          reason: harness.injectedError.message
        })
      )
      expect(harness.previewCandidate).toHaveBeenCalledTimes(previewed ? 1 : 0)
      if (point !== 'commit') expect(harness.commit).not.toHaveBeenCalled()
    }
  )

  it('surfaces typed route errors with the server conflict code', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'The Recipe changed after analysis.',
            code: 'WRITE_CONFLICT'
          }),
          { status: 409 }
        )
    )
    const client = new RecipeWorkflowClient('goon/client id', {
      fetchImpl: fetchImpl as typeof fetch
    })

    const error = await client
      .startPackageUpdate({
        expectedWriteVersion: 2,
        idempotencyKey: 'client-key',
        analysisId: 'analysis_client'
      })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(RecipeWorkflowHttpError)
    expect(error).toMatchObject({ status: 409, code: 'WRITE_CONFLICT' })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/goons/goon%2Fclient%20id/recipe/start',
      expect.objectContaining({ method: 'POST' })
    )
  })
})
