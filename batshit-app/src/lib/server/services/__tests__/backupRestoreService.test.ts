import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { unzipSync, zipSync } from 'fflate/node'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
// Install the supported lane root before any production module captures skill/voice paths.
const ownedHome = vi.hoisted(() => {
  const root = `${(process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')}/batshit-backup-service-home-${process.pid}-${Date.now()}`
  const previous = process.env.BATSHIT_HOME_DIR
  process.env.BATSHIT_HOME_DIR = `${root}/.batshit`
  return { root, previous }
})
afterAll(async () => {
  if (ownedHome.previous === undefined) delete process.env.BATSHIT_HOME_DIR
  else process.env.BATSHIT_HOME_DIR = ownedHome.previous
  await fs.rm(ownedHome.root, { recursive: true, force: true })
})

// Only the default-lane snapshot reply is adapted. Production parser/classifier/export run;
// this does not qualify Lua atomicity, and the real lane uses its real EVAL unchanged.
vi.mock('../backupHairSnapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backupHairSnapshot')>()
  return { ...original, readHairBackupSnapshot: async (client: any) => {
    if (process.env.VITEST_USE_REAL_REDIS === 'true') return original.readHairBackupSnapshot(client)
    const { fakeHairSnapshotAnswer } = await import('./fixtures/hairSnapshotFake')
    return original.readHairBackupSnapshot({ eval: () => fakeHairSnapshotAnswer(client) })
  } }
})
import { clearRedisTestDatabase, useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
// This file proves the committed restore handoff; physical command/plugin bootstrap
// is qualified by its real-Redis owner suite, never a shared fake Lua implementation.
vi.mock('../systemSlashCommands', async importOriginal => ({
  ...(await importOriginal<typeof import('../systemSlashCommands')>()),
  initializeSystemSlashCommandsForUser: vi.fn(async () => undefined)
}))
import { initializeSystemSlashCommandsForUser } from '../systemSlashCommands'
import { pinokioMachineService, pinokioMachinesKey } from '../pinokioMachineService'
import { ZIP_DEFAULTS_SWEEP_KEY } from '../zipDefaultsSweep'

// The default lane's Redis fake runs no Lua, so the restore's old-default zip sweep would only log
// a failure there; the real lane runs the real sweep (SA-126 1d).
vi.mock('../zipDefaultsSweep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../zipDefaultsSweep')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return actual
  return { ...actual, sweepOldZipDefaults: async () => ({ status: 'already-complete' as const, records: 0, rows: 0, fields: 0, changed: [] }) }
})
import { guardToolModelText } from '../toolModelResultGuard'
import { mcpToolListCache } from '$lib/server/services/mcpToolListCache'
import { DatabaseService, invalidateUserSettingsCache } from '$lib/services/databaseRedis.server'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { captureRecipeVerificationEpoch, isRecipeVerificationEpochCurrent } from '../recipeVerificationEpoch.server'
import { assertSettingsLifecycle, captureSettingsLifecycle, withSettingsRestoreFence } from '../appActions/settings/lifecycle'
import { createPortableSkillToken, validatePortableSkillToken } from '../portableSkillTokens'
import { nativePolicyResponse, portableGrantResponse, saveNativePolicy, savePortableGrant } from '../appActions/settings/authority'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { slashCommandRevisionKey, newSlashCommandRevision } from '../slashCommandRevisionProtocol'
import { __resetPinokioAdmissionForTests, ownPinokioOperation } from '../pinokioAdmission'
import { createRecipeStageAdmissionCache } from '../recipeStageAdmission.server'
import {
  createDefaultFacialArtworkState,
  createFacialArtworkArtworkLayer,
  parseFacialArtworkDefinition,
  resolveFacialArtworkTemplateVariant
} from '$lib/goons/facialArtwork'
import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition
} from '$lib/goons/eyeAppearance'
import { buildFacialArtworkV6DefinitionFixture } from '$lib/goons/__fixtures__/facialArtworkV6'
import {
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT
} from '$lib/goons/socketEyeArtworkProjection'
import {
  GOON_LIVE_BUILD_CONTRACT,
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_FIT_RECEIPT_CONTRACT,
  GOON_RECIPE_JOB_CONTRACT,
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  GOON_RECIPE_STATE_CONTRACT,
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  RECIPE_MIGRATION_PLAN_CONTRACT,
  RECIPE_SOURCE_CONTRACT,
  createGoonLiveBuildReceipt,
  createGoonRecipeDocument,
  createRecipeMigrationPlan,
  createRecipeRevisionEnvelope,
  recipeAuthoringRevisionSha256,
  recipeRevisionBundleSha256,
  recipeRevisionIdentity,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  verifyGoonRecipeDocument,
  verifyRecipeReviewedState
} from '$lib/goons/recipe'
import {
  agentRunCredentialKey,
  agentRunCredentialsIndexKey
} from '$lib/server/services/agentRunCredentials'
import {
  BackupRestoreError,
  beginBackupRestoreMaintenance,
  createBackupBundle,
  createBackupBundleStream,
  ensureBackupRestoreRecovery,
  enterBackupRestoreHttpRequest,
  preflightBackupRestore,
  preflightStagedBackupRestore,
  restoreStagedBackup,
  restoreBackupBundle
} from '../backupRestoreService'
import {
  __resetScheduleDueCacheForTests,
  listDueSchedules
} from '$lib/server/services/schedules/scheduleStore'
import {
  __resetStreamAbortRegistryForTests,
  queueSessionTurn,
  registerSessionTurn,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  collectGoonUploadReferencesForClient,
  hasGoonUploadReference
} from '../goonAssetCleanupService'
import {
  listCoreSystemPromptDefinitions,
  listCoreSystemPrompts,
  reconcileCoreSystemPromptsAfterRestore,
  resetCoreSystemPrompt,
  saveCoreSystemPrompt
} from '../systemPromptRegistry'

const managedHelper = vi.hoisted(() => vi.fn())
vi.mock('../localAiManagedProfiles', async original => ({ ...await original<typeof import('../localAiManagedProfiles')>(), managedProfileHelper: managedHelper }))

const savedPoolId = process.env.VITEST_POOL_ID
beforeAll(() => { if (process.env.SA133_REDIS_RUN_ID) process.env.VITEST_POOL_ID = '0' })
afterAll(() => {
  if (savedPoolId === undefined) delete process.env.VITEST_POOL_ID
  else process.env.VITEST_POOL_ID = savedPoolId
})
// Optional packet-owned admission uses the existing harness, never a borrowed allocation.
const ownedRedisRunId = process.env.COOPER_FIXTURE_REDIS_RUN_ID
const ownedRedisDir = process.env.COOPER_FIXTURE_REDIS_DIR
const ownedRedisLane = ownedRedisRunId !== undefined || ownedRedisDir !== undefined
const ownedRedisUrl = 'redis://127.0.0.1:6393/15'
const ownedRedisPreviousPool = process.env.VITEST_POOL_ID
let ownedRedisClient: any
let ownedRedisAdmitted = false
let ownedRedisRetired = false
let ownedRedisAcquisition: Promise<unknown> | undefined
function checkOwnedRedisIntent() {
  if (!ownedRedisLane) return
  if (process.env.VITEST_USE_REAL_REDIS !== 'true' || !ownedRedisRunId || !/^[a-f0-9]{40}$/.test(ownedRedisRunId) ||
      !ownedRedisDir || !path.isAbsolute(ownedRedisDir) || path.normalize(ownedRedisDir) !== ownedRedisDir ||
      ['BATSHIT_REDIS_TEST_URL', 'VITEST_REDIS_URL', 'REDIS_URL'].some(key => process.env[key] !== ownedRedisUrl)) {
    throw new Error('The owned Redis packet needs its fresh run/directory and three exact DB15 URLs before admission.')
  }
}
checkOwnedRedisIntent()
beforeAll(() => { if (ownedRedisLane) process.env.VITEST_POOL_ID = '0' })
async function checkOwnedRedisClient(client: any, empty: boolean) {
  checkOwnedRedisIntent()
  expect(client.isOpen && client.isReady).toBe(true)
  const connection = await client.clientInfo()
  expect(connection.db).toBe(15)
  expect(connection.laddr).toBe('127.0.0.1:6393')
  expect(Number.isSafeInteger(connection.id) && connection.id > 0).toBe(true)
  const server: string = await client.info('server')
  const field = (name: string) => {
    const lines = server.split(/\r?\n/).filter(line => line.startsWith(`${name}:`))
    expect(lines).toHaveLength(1)
    return lines[0].slice(name.length + 1)
  }
  expect(field('run_id')).toBe(ownedRedisRunId)
  expect(field('redis_version')).toBe('8.10.1')
  expect(field('tcp_port')).toBe('6393')
  expect((await client.configGet('dir')).dir).toBe(ownedRedisDir)
  expect((await client.configGet('save')).save).toBe('')
  expect((await client.configGet('appendonly')).appendonly).toBe('no')
  const modules: unknown = await client.sendCommand(['MODULE', 'LIST'])
  if (!Array.isArray(modules) || modules.some(row => !Array.isArray(row))) throw new Error('Owned Redis modules are unreadable.')
  expect(modules.map(row => row[row.indexOf('name') + 1])).toEqual(expect.arrayContaining(['ReJSON', 'search']))
  for (const command of ['JSON.GET', 'FT.SEARCH']) {
    expect(await client.sendCommand(['COMMAND', 'INFO', command])).toEqual([expect.any(Array)])
  }
  expect(await client.sendCommand(['JSON.GET', 'cooper:fixture:admission:missing', '$'])).toBeNull()
  const keyspace: string = await client.info('keyspace')
  expect(keyspace.split(/\r?\n/).filter(line => /^db\d+:/.test(line) && !line.startsWith('db15:'))).toEqual([])
  if (empty) expect(await client.dbSize()).toBe(0)
  return connection.id as number
}
async function admitOwnedRedis({ adminClient, resolvedUrl }: { adminClient: any; resolvedUrl: string }) {
  if (!ownedRedisLane) return
  checkOwnedRedisIntent()
  expect(resolvedUrl).toBe(ownedRedisUrl)
  const adminId = await checkOwnedRedisClient(adminClient, true)
  ownedRedisAcquisition = redis.execute(async (client: any) => {
    ownedRedisClient = client
    if (ownedRedisRetired) { if (client.isOpen) await client.disconnect(); throw new Error('Owned Redis acquisition settled after retirement.') }
    const appId = await checkOwnedRedisClient(client, true)
    if (ownedRedisRetired) { if (client.isOpen) await client.disconnect(); throw new Error('Owned Redis admission settled after retirement.') }
    expect(appId).not.toBe(adminId)
  })
  try {
    await ownedRedisAcquisition
    if (ownedRedisRetired) throw new Error('Owned Redis admission was retired.')
    ownedRedisAdmitted = true
  } catch (error) {
    try { await redis.disconnect() } catch (closeError) {
      throw new AggregateError([error, closeError], 'Owned Redis admission and app closure failed.')
    }
    throw error
  }
}
async function retireOwnedRedis() {
  if (!ownedRedisLane) return
  ownedRedisRetired = true
  const errors: unknown[] = []
  try {
    if (ownedRedisAdmitted && ownedRedisAdmission.isAdmitted() && ownedRedisClient) {
      await checkOwnedRedisClient(ownedRedisClient, false)
      await clearRedisTestDatabase(ownedRedisClient)
    }
  } catch (error) { errors.push(error) }
  finally {
    // Public disconnect acquires no new connection and resets this fixture's facade.
    try { await redis.disconnect() } catch (error) { errors.push(error) }
    if (ownedRedisAcquisition) {
      try { await ownedRedisAcquisition } catch (error) { if (!errors.includes(error)) errors.push(error) }
    }
    if (ownedRedisPreviousPool === undefined) delete process.env.VITEST_POOL_ID
    else process.env.VITEST_POOL_ID = ownedRedisPreviousPool
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Owned Redis cleanup and closure failed.')
}

const ownedRedisAdmission = useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
  await admitOwnedRedis({ adminClient, resolvedUrl })
  const database = Number(new URL(resolvedUrl).pathname.slice(1))
  expect(Number.isInteger(database) && database > 0).toBe(true)
  expect((await adminClient.clientInfo()).db).toBe(database)
  if (process.env.SA133_REDIS_RUN_ID) {
    expect(database).toBe(15)
    for (const client of [adminClient, await redis.execute(async (connection) => connection)]) {
      expect((await client.clientInfo()).db).toBe(15)
      expect(await client.info('server')).toContain(`run_id:${process.env.SA133_REDIS_RUN_ID}`)
      expect(await client.sendCommand(['COMMAND', 'INFO', 'JSON.GET'])).toEqual([expect.any(Array)])
    }
  }
} })
afterAll(retireOwnedRedis)

let uploadRoot: string
let previousUploadsDir: string | undefined
let previousPublicServerUrl: string | undefined
let previousContainerized: string | undefined
let previousRuntimeEnv: string | undefined
let previousCodexWorkdir: string | undefined
let previousBackupStagingDir: string | undefined
let backupStagingRoot: string

const EYE_HASH = 'a'.repeat(64)
const SOCKET_HASH = 'b'.repeat(64)
const SEAM_HASH = 'c'.repeat(64)
const ARTWORK_HASH = 'd'.repeat(64)
// SA-139 R2: the removed n8n Workflow Subagent's thread id. A leftover one is neither exported nor
// restored, and an older archive's copy is dropped on restore.
const RETIRED_THREAD_ID_KEY = 'subagent_thread:sess_1:researcher'
const DELEGATION_BACKUP_RECORDS = {
  'batshit:subagent_guidance': 'Ask assigned specialists for bounded research and use fresh threads by default.',
  'batshit:subagent_guidance:last_updated': '2026-09-04T12:00:00.000Z',
  'batshit:worker_prompt': 'Return the requested result from this temporary worker run.',
  'batshit:worker_prompt:last_updated': '2026-09-04T12:00:00.000Z'
}
const TRANSIENT_DELEGATION_KEYS = [
  'subagent_lock:sess_1:researcher',
  'n8n:sse-callback:sess_1:subagent_run_1'
]

function backupEyeDefinition() {
  const runtimeBinding = (side: 'L' | 'R') => ({
    physicalEyeNode: `bs_f1_eye_${side.toLowerCase()}_physical`,
    irisNeutralRadiusMeters: 0.0081,
    pupilNeutralRadiusRatio: 0.49,
    neutralPlacement: {
      horizontalTravelFraction: -0.5,
      verticalTravelFraction: -0.7
    },
    irisHorizontalTravelMeters: 0.002,
    irisVerticalTravelMeters: 0.003,
    edgeSoftnessMeters: 0.0002,
    artworkMappings: {
      sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
      iris: SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
      pupil: SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
      highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
    },
    cornea: { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 }
  })
  const control = (
    id: 'iris_size' | 'pupil_size' | 'iris_horizontal_position' | 'iris_vertical_position'
  ) => ({
    id,
    label:
      id === 'iris_size'
        ? 'Iris Size'
        : id === 'pupil_size'
          ? 'Pupil Size'
          : id === 'iris_horizontal_position'
            ? 'Iris Horizontal Position'
            : 'Iris Vertical Position',
    description: `${id} on the physical eye`,
    minimum: id === 'iris_size' || id === 'pupil_size' ? 0.5 : -1,
    maximum: id === 'iris_size' || id === 'pupil_size' ? 1.5 : 1,
    step: 0.01,
    default: id === 'iris_vertical_position' || id === 'iris_horizontal_position' ? 0 : 1,
    unit:
      id === 'iris_size'
        ? 'neutral-multiplier'
        : id === 'pupil_size'
          ? 'iris-relative-multiplier'
          : 'neutral-travel-fraction',
    linkedBilateral: true,
    bilateralLaw:
      id === 'iris_horizontal_position'
        ? 'mirrored-convergence-divergence'
        : 'linked-same-value',
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: 'Moves artwork coordinates without deforming the sphere.'
  })
  return {
    schemaVersion: 'eye-appearance/v5',
    stateSchemaVersion: 'eye-appearance-state/v5',
    status: 'product-export-approved',
    productExportApproved: true,
    definitionSha256: EYE_HASH,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: 'socket-eye-surface/v2',
        definitionSha256: SOCKET_HASH
      },
      eyeApertureSeam: {
        schemaVersion: 'eye-aperture-seam/v2',
        definitionSha256: SEAM_HASH
      }
    },
    ownership: 'Package-owned calibration.',
    zeroLaw: 'Defaults reproduce authored eyes.',
    symmetryLaw: 'Linked bilateral controls.',
    compositionOrder: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
    solidColorDefaults: {
      iris: [0.035, 0.42, 0.34, 1],
      pupil: [0.008, 0.009, 0.012, 1],
      sclera: [0.92, 0.94, 0.96, 1]
    },
    runtimeBindings: {
      coordinateSpace: 'physical-eye-sphere',
      left: runtimeBinding('L'),
      right: runtimeBinding('R'),
      geometryEvidence: {
        acceptedGlbSha256: 'e'.repeat(64),
        socketSurfaceSha256: 'f'.repeat(64),
        apertureSeamSha256: '1'.repeat(64)
      }
    },
    controls: [
      control('iris_size'),
      control('pupil_size'),
      control('iris_horizontal_position'),
      control('iris_vertical_position')
    ],
    rangeEvidence: {
      schemaVersion: 'eye-appearance-range-evidence/v5',
      sha256: '2'.repeat(64),
      canonicalSha256: '3'.repeat(64)
    }
  }
}

async function backupFacialDefinition() {
  const definition = structuredClone(buildFacialArtworkV6DefinitionFixture())
  definition.definitionSha256 = ARTWORK_HASH
  definition.dependencies = {
    eyeAppearance: { schemaVersion: 'eye-appearance/v5', definitionSha256: EYE_HASH },
    socketEyeSurface: {
      schemaVersion: 'socket-eye-surface/v2',
      definitionSha256: SOCKET_HASH
    },
    eyeApertureSeam: {
      schemaVersion: 'eye-aperture-seam/v2',
      definitionSha256: SEAM_HASH
    }
  }
  return definition
}

async function createBackupRecipeLiveBuildReceipt() {
  const sha = (value: string) => value.repeat(64)
  return createGoonLiveBuildReceipt({
    contract: GOON_LIVE_BUILD_CONTRACT,
    source: {
      revisionId: 'revision-1',
      revision: 1,
      packageSha256: sha('1'),
      modelSha256: sha('2'),
      manifestSha256: sha('3'),
      definitionSha256: sha('4'),
      neutralRecipeSha256: sha('5'),
      basisSha256: sha('6')
    },
    state: { contract: GOON_RECIPE_STATE_CONTRACT, sha256: sha('7') },
    baker: {
      id: 'batshit-live-goon-baker',
      version: 'r4-v1',
      resolverVersion: 'appearance-recipe-physical-evaluation/v1',
      schemaVersion: 'goon-live-manifest/v1'
    },
    inventory: {
      kept: [],
      removed: ['manifest:/appearanceDials'],
      liveMorphTargets: [],
      retainedDynamicMorphs: [],
      retainedCorrectiveMorphs: []
    },
    proofs: {
      neutralPositionSha256: sha('8'),
      skeletonRestSha256: sha('9'),
      followerSha256: sha('a'),
      rootSha256: sha('b'),
      groundingSha256: sha('c'),
      performanceSha256: sha('d'),
      pivotSha256: sha('e'),
      attachmentSha256: sha('f'),
      validationReportSha256: sha('0'),
      liveManifestProvenanceSha256: sha('1')
    },
    output: {
      package: { sha256: sha('2'), bytes: 3 },
      model: { sha256: sha('3'), bytes: 2 },
      manifest: { sha256: sha('4'), bytes: 1 },
      counts: {
        meshes: 0,
        vertices: 0,
        nodes: 0,
        bones: 0,
        morphTargets: 0,
        dynamicMorphTargets: 0,
        correctiveMorphTargets: 0,
        recipeMorphTargets: 0
      }
    },
    cost: {
      inputBytes: 6,
      meshesProcessed: 0,
      verticesProcessed: 0,
      morphTargetsProcessed: 0
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
  })
}

async function seedRepresentativeData(userId: string) {
  await redis.json.set(`user:${userId}:settings`, '$', {
    id: `settings_${userId}`,
    user_id: userId,
    displayName: 'Source User',
    upload_settings: {
      strategy: 'local',
      webhookAuth: 'super-secret',
      preservedCustomMap: {
        laugh: ['ha', 'haha']
      },
      maxOutputTokens: 1200
    }
  })
  await redis.sAdd(`user:${userId}:sessions`, 'sess_1')
  await redis.json.set('session:sess_1', '$', {
    id: 'sess_1',
    user_id: userId,
    title: 'Backup Chat'
  })
  for (const [key, value] of Object.entries(DELEGATION_BACKUP_RECORDS)) {
    await redis.set(key, value)
  }
  await redis.set(RETIRED_THREAD_ID_KEY, 'f8a11390-7654-4321-8765-123456789abc')
  await redis.expire(RETIRED_THREAD_ID_KEY, 604800)
  await redis.set(TRANSIENT_DELEGATION_KEYS[0], 'in-flight-lock-fixture')
  await redis.expire(TRANSIENT_DELEGATION_KEYS[0], 185)
  await redis.json.set(TRANSIENT_DELEGATION_KEYS[1], '$', {
    userId,
    sessionId: 'sess_1',
    messageId: 'subagent_run_1'
  })
  await redis.expire(TRANSIENT_DELEGATION_KEYS[1], 1800)
  await redis.rPush('messages:sess_1', 'msg_1')
  await redis.json.set('message:sess_1:msg_1', '$', {
    id: 'msg_1',
    session_id: 'sess_1',
    user_id: userId,
    role: 'user',
    content: 'hello'
  })
  await redis.sAdd(`user:${userId}:agents`, 'agent_1')
  await redis.json.set('agent:agent_1', '$', {
    id: 'agent_1',
    user_id: userId,
    displayName: 'Helper'
  })
  await redis.json.set(`api_keys:${userId}:openai`, '$', {
    encrypted: 'encrypted-value',
    iv: 'iv-value',
    authTag: 'tag-value',
    updatedAt: '2026-05-22T00:00:00.000Z'
  })
  await redis.sAdd(`user:${userId}:custom_providers`, 'custom_alpha')
  await redis.json.set(`custom_provider:${userId}:custom_alpha`, '$', {
    id: 'custom_alpha',
    label: 'Alpha',
    baseUrl: 'https://example.com',
    apiKeyEncrypted: 'encrypted-custom',
    apiKeyIv: 'iv-custom',
    apiKeyAuthTag: 'tag-custom',
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z'
  })

  await fs.mkdir(path.join(uploadRoot, 'images'), { recursive: true })
  await fs.writeFile(path.join(uploadRoot, 'images', 'photo.png'), 'image-bytes')
  await redis.json.set('upload:images:photo.png', '$', {
    originalName: 'photo.png',
    mimetype: 'image/png',
    size: 11,
    uploadType: 'images',
    storage: 'filesystem',
    relativePath: 'images/photo.png',
    filePath: path.join(uploadRoot, 'images', 'photo.png'),
    uploadedAt: '2026-05-22T00:00:00.000Z'
  })
  await redis.json.set('upload:avatars:agent:legacy-avatar.png', '$', {
    originalName: 'legacy-avatar.png',
    filename: 'legacy-avatar.png',
    mimetype: 'image/png',
    size: 19,
    base64: Buffer.from('legacy-avatar-bytes').toString('base64'),
    uploadType: 'avatars',
    uploadedAt: '2026-05-22T00:00:00.000Z'
  })
  await fs.mkdir(path.join(uploadRoot, 'goon_facial_artwork'), { recursive: true })
  await fs.writeFile(
    path.join(uploadRoot, 'goon_facial_artwork', 'brow-left.png'),
    'facial-artwork-bytes'
  )
  const facialDefinition = parseFacialArtworkDefinition(await backupFacialDefinition())
  const browRole = facialDefinition.roles.find((entry) => entry.id === 'brows')!
  const browTemplate = facialDefinition.templates.find((entry) => entry.id === browRole.template)!
  const browVariant = resolveFacialArtworkTemplateVariant(
    browTemplate,
    browTemplate.canonicalOrientation
  )
  const facialUpload = {
    role: 'brows' as const,
    url: 'http://localhost:5600/uploads/goon_facial_artwork/brow-left.png',
    filename: 'brow-left.png',
    size: 20,
    mimeType: 'image/png' as const,
    sha256: 'b'.repeat(64),
    template: {
      id: browTemplate.id,
      version: browTemplate.version,
      orientation: browTemplate.canonicalOrientation,
      guideSha256: browVariant.guide.sha256,
      maskSha256: browVariant.safePaintMask.sha256
    },
    provenance: {
      sourceKind: 'user-authored' as const,
      author: 'Fixture Artist',
      license: 'User-owned',
      rightsConfirmed: true as const
    }
  }
  await redis.json.set('upload:goon_facial_artwork:brow-left.png', '$', {
    originalName: 'brow-left.png',
    mimetype: 'image/png',
    size: 20,
    uploadType: 'goon_facial_artwork',
    storage: 'filesystem',
    relativePath: 'goon_facial_artwork/brow-left.png',
    filePath: path.join(uploadRoot, 'goon_facial_artwork', 'brow-left.png'),
    facialArtwork: {
      role: facialUpload.role,
      definitionSha256: facialDefinition.definitionSha256,
      sha256: facialUpload.sha256,
      template: facialUpload.template,
      provenance: facialUpload.provenance
    },
    uploadedAt: '2026-05-22T00:00:00.000Z'
  })
  await redis.sAdd(`user:${userId}:goons`, 'goon_facial')
  const facialState = createDefaultFacialArtworkState(facialDefinition)
  if (facialState.roles.brows.mode !== 'shared') throw new Error('fixture expects shared brows')
  facialState.roles.brows.shared = {
    ...facialState.roles.brows.shared,
    visible: true,
    artwork: createFacialArtworkArtworkLayer(facialDefinition, 'brows', facialUpload)
  }
  const eyeDefinition = parseEyeAppearanceDefinition(backupEyeDefinition())
  const eyeState = createDefaultEyeAppearanceState(eyeDefinition)
  eyeState.irisSize = 1.1
  await redis.json.set('goon:goon_facial', '$', {
    id: 'goon_facial',
    user_id: userId,
    name: 'Facial Fixture',
    facialArtwork: facialState,
    eyeAppearance: eyeState,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z'
  })

  // SA-104 agent-memory records: agent-scoped memory + graduated segment plus the
  // instance-level memory config/meta keys, all part of the `memory` backup group.
  await redis.json.set('memory:agent_1:mem_1', '$', {
    id: 'mem_1',
    agent_id: 'agent_1',
    user_id: userId,
    lane: 'ltm',
    content: 'Josh has an Irish Setter named Maggie',
    importance: 7,
    event_at: null,
    event_ts: null,
    saved_at: '2026-08-25T00:00:00.000Z',
    saved_ts: 1787961600000,
    is_superseded: 'n',
    media_mode: 'on_recall',
    media: [
      {
        id: 'media_1',
        filename: 'agent_1/mem_1/media_1.png',
        display_name: 'maggie.png',
        mime_type: 'image/png',
        bytes: 18,
        width: 64,
        height: 64,
        token_estimate: 9,
        sha256: '9'.repeat(64),
        source_clip_id: 'clip_old'
      }
    ],
    provenance: [{ session_id: 'sess_1', message_id: 'msg_1', source: 'agent' }],
    visibility: 'normal',
    embedding: [0.1, 0.2, 0.3, 0.4],
    embedding_model: 'local-ai:test-embedder@4',
    schema_version: 1
  })
  await fs.mkdir(path.join(uploadRoot, 'memory-media', 'agent_1', 'mem_1'), { recursive: true })
  await fs.writeFile(
    path.join(uploadRoot, 'memory-media', 'agent_1', 'mem_1', 'media_1.png'),
    'memory-image-bytes'
  )
  await redis.json.set('upload:memory-media:agent_1/mem_1/media_1.png', '$', {
    filename: 'agent_1/mem_1/media_1.png',
    uploadType: 'memory-media',
    mimetype: 'image/png',
    size: 18,
    storage: 'filesystem',
    relativePath: 'memory-media/agent_1/mem_1/media_1.png',
    filePath: path.join(uploadRoot, 'memory-media', 'agent_1', 'mem_1', 'media_1.png'),
    uploadedAt: '2026-08-25T00:00:00.000Z'
  })
  await redis.json.set('memseg:agent_1:memseg_1', '$', {
    id: 'memseg_1',
    agent_id: 'agent_1',
    user_id: userId,
    session_id: 'sess_1',
    episode_id: null,
    message_ids: ['msg_1'],
    summary: 'Introduced Maggie the Irish Setter',
    first_message_at: '2026-08-25T00:00:00.000Z',
    first_message_ts: 1787961600000,
    last_message_at: '2026-08-25T00:05:00.000Z',
    last_message_ts: 1787961900000,
    token_count: 120,
    graduated_at: '2026-08-25T01:00:00.000Z',
    graduated_by: 'session_close',
    embedding: [0.1, 0.2, 0.3, 0.4],
    embedding_model: 'local-ai:test-embedder@4',
    schema_version: 1
  })
  await redis.json.set('episode:sess_1:ep_1', '$', {
    id: 'ep_1',
    session_id: 'sess_1',
    agent_id: 'agent_1',
    state: 'closed',
    opened_at: '2026-08-25T00:00:00.000Z',
    closed_at: '2026-08-25T01:00:00.000Z',
    boundary_signal: 'agent_mark',
    hold_until: null,
    first_message_id: 'msg_1',
    last_message_id: 'msg_1',
    whiteboard: { content: 'Maggie vet appointment Friday', updated_at: '2026-08-25T00:30:00.000Z' },
    schema_version: 1
  })
  await redis.rPush('session:sess_1:episodes', 'ep_1')
  // SA-104 P7: the dreaming log (agent-scoped JSON run + capped LIST index).
  await redis.json.set('memdream:agent_1:dream_1', '$', {
    id: 'dream_1',
    agent_id: 'agent_1',
    user_id: userId,
    trigger: 'manual',
    started_at: '2026-08-25T02:00:00.000Z',
    finished_at: '2026-08-25T02:00:05.000Z',
    status: 'completed',
    actions: [
      {
        at: '2026-08-25T02:00:01.000Z',
        kind: 'expire_demote',
        status: 'done',
        why: 'expired — demoted awareness → ltm so it stops compiling but stays searchable'
      }
    ],
    counts: { expiriesDemoted: 1, failures: 0, modelCalls: 0 },
    schema_version: 1
  })
  await redis.rPush('memdream_index:agent_1', 'dream_1')
  await redis.json.set('batshit:memory_config', '$', {
    embedding: {
      lane: 'local-ai',
      modelId: 'local-ai:test-embedder',
      localAi: { baseUrl: 'http://127.0.0.1:9/v1', modelName: 'test-embedder', dims: 4 }
    },
    schema_version: 1
  })
  // SA-120: the instance-level Judge Juice config rides the `settings` group.
  await redis.json.set('batshit:typesafe_config', '$', {
    enabled: true,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 2500,
    // SA-120 P10a: the judges ride the same record; none of their fields is a secret (keys live in api_keys).
    providers: [
      { id: 'ollama-pc', kind: 'ollama', label: 'Ollama on the PC', baseUrl: 'http://192.168.1.20:11434', modelId: 'clef-flash' },
      { id: 'cf', kind: 'cloudflare', label: 'Cloudflare', accountId: '0123456789abcdef0123456789abcdef', modelId: 'clef' },
      { id: 'liquid', kind: 'systemone_url', label: 'Liquid AI', baseUrl: 'https://api.liquid.ai/decisions', modelId: 'lfm2-d1', sendsKey: true }
    ],
    defaultProviderId: 'ollama-pc',
    laneProviders: { untrusted_text: 'liquid' },
    updatedAt: '2026-09-16T12:00:00.000Z'
  })
  await redis.json.set('batshit:memory_index_meta', '$', {
    embedding_model: 'local-ai:test-embedder@4',
    dims: 4,
    index_schema_version: 1,
    last_rebuilt_at: '2026-08-25T00:00:00.000Z',
    schema_version: 1
  })

  // SA-113 P2 (DL-113-02): one Agent DM and all three of its indexes, so the `dms` backup
  // group is exercised through the real export/restore path rather than asserted in
  // isolation. A key family that is not registered in all four places silently vanishes.
  await redis.json.set('dm:dm_1', '$', {
    id: 'dm_1',
    messageId: 'dm_1',
    userId: 'source',
    kind: 'assignment',
    priority: 'normal',
    from: { kind: 'agent', agentId: 'agent_2', name: 'Faye' },
    to: 'agent_1',
    subject: 'Verify the package',
    body: 'Run the audit and report what it says.',
    requestedOutcome: 'Pass or fail.',
    scope: 'Mac app only.',
    reportBackTo: 'agent_2',
    deliver: 'wait',
    status: 'new',
    createdAt: '2026-09-07T09:00:00.000Z',
    createdTs: Date.parse('2026-09-07T09:00:00.000Z'),
    expiresAt: '2026-09-21T09:00:00.000Z',
    delivery: { requested: 'wait', actual: 'wait' }
  })
  await redis.execute(async (client) => {
    await client.zAdd('dm_inbox:agent_1', { score: 1e15, value: 'dm_1' })
    await client.zAdd('dm_sent:agent_2', { score: 1e15, value: 'dm_1' })
    await client.zAdd('dm_index:source', { score: 1, value: 'dm_1' })
  })

  // SA-113 P3 (DL-113-09): one wake-up webhook and its index, in the same `dms` group. A
  // hook that did not survive a restore would leave an n8n workflow calling a URL that no
  // longer exists, with nothing in the UI to say why.
  await redis.json.set('wake_hook:whk_1', '$', {
    id: 'whk_1',
    userId: 'source',
    agentId: 'agent_1',
    name: 'Nightly build',
    tokenHash: 'a'.repeat(64),
    tokenPrefix: 'bswh_abcdefg',
    tokenSuffix: 'zyxwvu',
    deliverDefault: 'wake',
    enabled: true,
    createdAt: '2026-09-07T09:00:00.000Z',
    updatedAt: '2026-09-07T09:00:00.000Z',
    lastUsedAt: null,
    useCount: 0,
    expiresAt: null
  })
  await redis.execute(async (client) => {
    await client.sAdd('wake_hooks:source', 'whk_1')
  })

  // SA-115 P3 (DL-115-12): one schedule and its user-scoped index SET, in the same `dms`
  // group. A schedule that did not survive a restore is a routine that silently stops
  // happening — no error, no row, nothing to notice until the agent never wakes again.
  await redis.json.set('schedule:sch_1', '$', {
    id: 'sch_1',
    userId: 'source',
    agentId: 'agent_1',
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: 'America/Chicago',
    message: 'Say good morning.',
    kind: 'info',
    deliver: 'wake',
    enabled: true,
    nextRunAt: '2026-09-09T14:00:00.000Z',
    lastRunAt: null,
    lastOutcome: null,
    lastDmId: null,
    runCount: 0,
    missedRun: null,
    createdBy: 'user',
    createdAt: '2026-09-07T09:00:00.000Z',
    updatedAt: '2026-09-07T09:00:00.000Z'
  })
  await redis.execute(async (client) => {
    await client.sAdd('schedules:source', 'sch_1')
  })
}

/** A Claude plan run as the registry sees it: `stop` ends it and its settlement follows. */
function claudePlanRun(settlement: 'exited' | 'unknown' = 'exited') {
  let settle!: (value: 'exited' | 'unknown') => void
  const run = {
    owner: { userId: 'restore-user', sessionId: 'restore-chat', agentId: 'agent', kind: 'primary' as const },
    settled: new Promise<'exited' | 'unknown'>(resolve => { settle = resolve }),
    exited: new Promise<void>(() => {}),
    isEnded: false,
    stop: vi.fn(() => { run.isEnded = true; settle(settlement) })
  }
  return run
}

describe('SA-139 (D6, D10): a restore and the Claude plan runs', () => {
  afterEach(async () => {
    const { resetClaudePlanRunRegistryForTests } = await import('../claudePlanRunRegistry')
    resetClaudePlanRunRegistryForTests()
  })

  it('ends every run and awaits its exit before the restore goes on, and admits no new run until it is done', async () => {
    const { registerClaudePlanRun } = await import('../claudePlanRunRegistry')
    const live = claudePlanRun()
    registerClaudePlanRun(live as any)
    const end = await beginBackupRestoreMaintenance()
    expect(live.stop).toHaveBeenCalledTimes(1)
    expect(() => registerClaudePlanRun(claudePlanRun() as any)).toThrow(/backup restore is running/)
    end()
    expect(() => registerClaudePlanRun(claudePlanRun() as any)).not.toThrow()
  })

  it('waits for a slow exit, and for a run that already ended but is still exiting, before it goes on', async () => {
    const { registerClaudePlanRun } = await import('../claudePlanRunRegistry')
    const events: string[] = []
    const slow = (label: string, endedAlready: boolean) => {
      let settle!: (value: 'exited') => void
      const run = {
        owner: { userId: 'restore-user', sessionId: `restore-${label}`, agentId: 'agent', kind: 'primary' as const },
        settled: new Promise<'exited' | 'unknown'>(resolve => { settle = resolve }),
        exited: new Promise<void>(() => {}),
        isEnded: endedAlready,
        stop: vi.fn(() => { run.isEnded = true })
      }
      registerClaudePlanRun(run as any)
      setTimeout(() => { events.push(`${label} exited`); settle('exited') }, 60)
      return run
    }
    slow('stopping', false)
    slow('exiting', true)
    const end = await beginBackupRestoreMaintenance()
    events.push('restore goes on')
    expect(events).toEqual(['stopping exited', 'exiting exited', 'restore goes on'])
    end()
  })

  it('refuses the restore (409) while a Claude Code exit cannot be confirmed, and reopens run admission', async () => {
    const { registerClaudePlanRun } = await import('../claudePlanRunRegistry')
    registerClaudePlanRun(claudePlanRun('unknown') as any)
    await expect(beginBackupRestoreMaintenance()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Claude Code run') })
    expect(() => registerClaudePlanRun(claudePlanRun() as any)).not.toThrow()
    // The maintenance flag was released too: the next restore attempt is not "already running".
    await expect(beginBackupRestoreMaintenance()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Claude Code run') })
  })
})

describe('backupRestoreService', () => {
  beforeEach(async () => {
    vi.mocked(initializeSystemSlashCommandsForUser).mockReset().mockResolvedValue(undefined)
    managedHelper.mockReset()
    vi.stubEnv('BATSHIT_TOKEN', 'backup-restore-test-service-token')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/api\/upload\/asset-maintenance\/(begin|end)$/)
      const { token } = JSON.parse(String(init.body))
      return Response.json({ success: true, token, state: url.endsWith('/begin') ? 'created' : 'released', activeOperations: 0 })
    }))
    previousUploadsDir = process.env.UPLOADS_DIR
    previousPublicServerUrl = process.env.PUBLIC_BATSHIT_SERVER_URL
    previousContainerized = process.env.BATSHIT_CONTAINERIZED
    previousRuntimeEnv = process.env.BATSHIT_RUNTIME_ENV
    previousCodexWorkdir = process.env.BATSHIT_CODEX_WORKDIR
    previousBackupStagingDir = process.env.BATSHIT_BACKUP_STAGING_DIR
    uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-backup-test-'))
    backupStagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-restore-stage-test-'))
    process.env.UPLOADS_DIR = uploadRoot
    process.env.BATSHIT_BACKUP_STAGING_DIR = backupStagingRoot
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5614'
    delete process.env.BATSHIT_CONTAINERIZED
    delete process.env.BATSHIT_RUNTIME_ENV
    delete process.env.BATSHIT_CODEX_WORKDIR
  })

  afterEach(async () => {
    __resetPinokioAdmissionForTests()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (previousUploadsDir === undefined) {
      delete process.env.UPLOADS_DIR
    } else {
      process.env.UPLOADS_DIR = previousUploadsDir
    }
    if (previousPublicServerUrl === undefined) {
      delete process.env.PUBLIC_BATSHIT_SERVER_URL
    } else {
      process.env.PUBLIC_BATSHIT_SERVER_URL = previousPublicServerUrl
    }
    if (previousContainerized === undefined) {
      delete process.env.BATSHIT_CONTAINERIZED
    } else {
      process.env.BATSHIT_CONTAINERIZED = previousContainerized
    }
    if (previousRuntimeEnv === undefined) {
      delete process.env.BATSHIT_RUNTIME_ENV
    } else {
      process.env.BATSHIT_RUNTIME_ENV = previousRuntimeEnv
    }
    if (previousCodexWorkdir === undefined) {
      delete process.env.BATSHIT_CODEX_WORKDIR
    } else {
      process.env.BATSHIT_CODEX_WORKDIR = previousCodexWorkdir
    }
    if (previousBackupStagingDir === undefined) {
      delete process.env.BATSHIT_BACKUP_STAGING_DIR
    } else {
      process.env.BATSHIT_BACKUP_STAGING_DIR = previousBackupStagingDir
    }
    await fs.rm(uploadRoot, { recursive: true, force: true })
    await fs.rm(backupStagingRoot, { recursive: true, force: true })
  })

  it('carries grouped plugin access in tools, remaps its user owner and removes replaced target groups', async () => {
    const plugin = { id: 'batshit', user_id: 'source', name: 'Batshit', description: 'Plugin fixture', builtIn: true,
      version: '1', skills: [{ commandId: 'batshit-guide', skillId: 'batshit_guide', name: 'Guide', invocation: '/batshit:batshit-guide' }],
      enabled_for_all_agents: false, enabled_agent_ids: ['exact-A-B'], revision: 'fixture', created_at: 'original', updated_at: 'original' }
    await redis.json.set('agent_plugin:source:batshit', '$', plugin)
    await redis.json.set('agent_plugin:target:removed', '$', { ...plugin, id: 'removed', user_id: 'target' })
    await redis.json.set('agent_plugin:bystander:kept', '$', { ...plugin, user_id: 'bystander' })
    const bundle = await createBackupBundle('source')
    const records = Object.entries(unzipSync(bundle.bytes)).filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
    expect(records.find(record => record.key === 'agent_plugin:source:batshit')).toMatchObject({ groupId: 'tools', type: 'json', value: plugin })
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(await redis.json.get('agent_plugin:target:batshit')).toEqual({ ...plugin, user_id: 'target' })
    expect(await redis.exists('agent_plugin:target:removed')).toBe(false)
    expect(await redis.exists('agent_plugin:bystander:kept')).toBe(true)
  })

  describe('Pinokio connection configuration and restore authority', () => {
    it('fences Pinokio before its first restore-drain await and waits for actual observer settlement', async () => {
      const old = ownPinokioOperation({ admit: async () => {} })
      const maintenance = beginBackupRestoreMaintenance()
      expect(old.signal.aborted).toBe(true)
      expect(() => ownPinokioOperation({ admit: async () => {} })).toThrow(/paused/)
      let admitted = false
      void maintenance.then(() => { admitted = true })
      await Promise.resolve()
      expect(admitted).toBe(false)
      old.close()
      const end = await maintenance
      end(); end()
      await expect(old.assert()).rejects.toMatchObject({ code: 'pinokio_operation_cancelled' })
      const fresh = ownPinokioOperation({ admit: async () => {} })
      await expect(fresh.assert()).resolves.toBeUndefined()
      fresh.close()
    })

    it.each(['buffer', 'staged'])('fences a direct %s restore synchronously and releases on pre-mutation failure', async entrypoint => {
      const old = ownPinokioOperation({ admit: async () => {} })
      const pending = entrypoint === 'buffer'
        ? restoreBackupBundle('source', new Uint8Array([0]), { confirmReplace: true })
        : restoreStagedBackup('source', 'not-a-stage', { confirmReplace: true })
      expect(old.signal.aborted).toBe(true)
      old.close()
      await expect(pending).rejects.toThrow()
      const fresh = ownPinokioOperation({ admit: async () => {} })
      await expect(fresh.assert()).resolves.toBeUndefined()
      fresh.close()
    })

    function archiveRecords(bytes: Uint8Array) {
      return Object.entries(unzipSync(bytes)).filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
        .map(([, entry]) => JSON.parse(Buffer.from(entry).toString('utf8')))
    }

    async function savedMachineAndArtifacts() {
      const machine = await pinokioMachineService.create('source', { label: 'PC', controlHost: '192.168.1.85', controlPort: 42000, controlProtocol: 'https' })
      const local = { id: 'local_art', user_id: 'source', metadata: { runtime_manager: 'pinokio', pinokio_app_id: 'comfy.git', source_type: 'comfyui' } }
      const remote = { id: 'remote_art', user_id: 'source', metadata: { ...local.metadata, pinokio_machine_id: machine.id } }
      await redis.json.set('artifact:local_art', '$', local)
      await redis.json.set('artifact:remote_art', '$', remote)
      await redis.execute(async (client) => client.sAdd('user:source:artifacts', ['local_art', 'remote_art']))
      return { machine, local, remote }
    }

    it.each(['buffer', 'staged'])('exports in settings, remaps user ownership and restores inactive via %s, preserving artifact bindings', async (entrypoint) => {
      const settingsBeforeRestore = captureSettingsLifecycle(['agent:agent_1'])
      const { machine, local, remote } = await savedMachineAndArtifacts()
      await pinokioMachineService.create('other', { label: 'Other', controlHost: '10.0.0.9', controlPort: 42000 })
      const bundle = await createBackupBundle('source')
      const records = archiveRecords(bundle.bytes)
      expect(records.find((entry) => entry.key === pinokioMachinesKey('source'))).toMatchObject({ type: 'json', groupId: 'settings', value: { schemaVersion: 1, machines: [machine] } })
      expect(records.some((entry) => entry.key === pinokioMachinesKey('other'))).toBe(false)
      expect(records.find((entry) => entry.key === 'artifact:remote_art')).toMatchObject({ groupId: 'artifacts', value: remote })
      const prior = await pinokioMachineService.create('target', { label: 'Retired target', controlHost: '10.0.0.2', controlPort: 42000 })
      if (entrypoint === 'buffer') await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
      else {
        const stageId = '11111111-2222-4333-8444-555555555551'
        const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
        const archivePath = path.join(backupStagingRoot, `${storageKey}.zip`)
        await fs.writeFile(archivePath, bundle.bytes)
        await fs.writeFile(path.join(backupStagingRoot, `${storageKey}.json`), JSON.stringify({
          contract: 'batshit-backup-stage/v1', stageId, userId: 'target', filename: 'batshit-backup.zip', bytes: bundle.bytes.byteLength,
          sha256: createHash('sha256').update(bundle.bytes).digest('hex'), stagedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), archivePath
        }))
        await restoreStagedBackup('target', stageId, { confirmReplace: true })
      }
      expect(() => assertSettingsLifecycle(settingsBeforeRestore)).toThrow()
      expect(await redis.json.get(pinokioMachinesKey('target'))).toEqual({ schemaVersion: 1, machines: [{ ...machine, bindingState: 'needs_confirmation' }] })
      await expect(pinokioMachineService.resolve('target', { machineId: prior.id, revision: prior.revision })).rejects.toMatchObject({ code: 'pinokio_machine_missing' })
      await expect(pinokioMachineService.resolve('target', { machineId: machine.id, revision: machine.revision })).rejects.toMatchObject({ code: 'pinokio_machine_confirmation_required' })
      expect(await redis.json.get('artifact:local_art')).toEqual({ ...local, user_id: 'target' })
      expect(await redis.json.get('artifact:remote_art')).toEqual({ ...remote, user_id: 'target' })
    })

    it.each(['settings', 'artifacts'])('keeps a %s-only archive unresolved rather than inventing missing bindings', async (group) => {
      const { machine, remote } = await savedMachineAndArtifacts()
      const bundle = await createBackupBundle('source')
      const entries = unzipSync(bundle.bytes)
      let kept = 0
      for (const name of Object.keys(entries)) {
        if (!name.startsWith('redis/records/') || !name.endsWith('.json')) continue
        const entry = JSON.parse(Buffer.from(entries[name]).toString('utf8'))
        if (entry.groupId === group) kept += 1
        else delete entries[name]
      }
      const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
      manifest.contents.redisRecordCount = kept
      entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
      await pinokioMachineService.create('target', { label: 'Replace me', controlHost: '10.0.0.2', controlPort: 42000 })
      await restoreBackupBundle('target', zipSync(entries), { confirmReplace: true })
      if (group === 'artifacts') {
        expect(await redis.json.get(pinokioMachinesKey('target'))).toBeNull()
        expect(await redis.json.get('artifact:remote_art')).toEqual({ ...remote, user_id: 'target' })
        await expect(pinokioMachineService.resolve('target', { machineId: machine.id, revision: 1 })).rejects.toMatchObject({ code: 'pinokio_machine_missing' })
      } else {
        // A different source user's data in this test DB is preserved. No artifact/index
        // is fabricated for the restoring target merely because a connection was carried.
        expect(await redis.json.get('artifact:remote_art')).toEqual(remote)
        expect(await redis.execute(async (client) => client.sMembers('user:target:artifacts'))).toEqual([])
        await expect(pinokioMachineService.resolve('target', { machineId: machine.id, revision: 1 })).rejects.toMatchObject({ code: 'pinokio_machine_confirmation_required' })
      }
    })

    it('rejects malformed incoming registry values before destructive replacement', async () => {
      await redis.json.set(pinokioMachinesKey('source'), '$', { schemaVersion: 1, machines: [{ id: 'local' }] })
      const bundle = await createBackupBundle('source')
      const target = await pinokioMachineService.create('target', { label: 'Preserved', controlHost: '192.168.1.9', controlPort: 42000 })
      await expect(preflightBackupRestore('target', bundle.bytes)).rejects.toMatchObject({ status: 400 })
      await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toMatchObject({ status: 400 })
      expect((await pinokioMachineService.list('target'))[1]).toEqual(target)
    })
  })

  it.each([false, true])('SA-133 carries latest boards in chats with user remapping and excludes replay snapshots (includeSecrets=%s)', async (includeSecrets) => {
    await seedRepresentativeData('source')
    const board = { schema_version: 1, user_id: 'source', session_id: 'sess_1', agent_id: 'agent_1', content: 'Useful working conclusions.', version: 4, updated_at: '2026-10-15T12:00:00.000Z' }
    await redis.json.set('whiteboard:sess_1:agent_1', '$', board)
    await redis.json.set('message:sess_1:msg_1', '$.metadata', { whiteboardContextSnapshot: { authority: 'transient' },
      liveFileReadSnapshot: { schema_version: 1, pauseId: 'pause-1' }, retained: true })
    const bundle = await createBackupBundle('source', { includeSecrets })
    const entries = unzipSync(bundle.bytes)
    const records = Object.entries(entries).filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
    expect(records.find((record) => record.key === 'whiteboard:sess_1:agent_1')).toMatchObject({ groupId: 'chats', value: board })
    expect(records.find((record) => record.key === 'message:sess_1:msg_1').value.metadata).toEqual({ retained: true })
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(await redis.json.get('whiteboard:sess_1:agent_1')).toEqual({ ...board, user_id: 'target' })
    expect((await redis.json.get('message:sess_1:msg_1'))?.metadata).toEqual({ retained: true })

    // An archive that carries them anyway (an older or edited bundle): the restore strips both.
    const planted = unzipSync(bundle.bytes)
    for (const [name, bytes] of Object.entries(planted)) {
      if (!name.startsWith('redis/records/') || !name.endsWith('.json')) continue
      const record = JSON.parse(Buffer.from(bytes).toString('utf8'))
      if (record.key !== 'message:sess_1:msg_1') continue
      record.value.metadata = { ...record.value.metadata, whiteboardContextSnapshot: { authority: 'planted' },
        liveFileReadSnapshot: { schema_version: 1, pauseId: 'planted' } }
      planted[name] = Buffer.from(JSON.stringify(record))
    }
    await restoreBackupBundle('target', zipSync(planted), { confirmReplace: true })
    expect((await redis.json.get('message:sess_1:msg_1'))?.metadata).toEqual({ retained: true })
  })

  describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('P2 portable authority at actual restore and recovery boundaries', () => {
    async function seedGrant(mode: 'selected' | 'all') {
      const token = await createPortableSkillToken({ userId: 'source', families: ['voice-engines'] })
      const policy = defaultAppActionsPolicy(true)
      policy.enabled = true
      policy.scope = { mode, subjects: mode === 'selected' ? [{ kind: 'primary', id: 'agent_1' }] : [], except: [] }
      await savePortableGrant('source', token.record.id, { expectedAuthorityGeneration: 1,
        grant: { policy, expiresAt: new Date(Date.now() + 60_000).toISOString() } })
      return token
    }
    async function canonicalSource() {
      await seedRepresentativeData('source')
      await redis.createAgent({ id: 'agent_1', user_id: 'source', agentType: 'api', displayName: 'Helper', created_at: '2026-10-04T00:00:00.000Z' })
    }
    it('invalidates selected/all grants while preserving token secrets/families and intentionally backed-up native policy', async () => {
      await canonicalSource()
      const nativeBefore = await nativePolicyResponse('source', 'agent_1')
      await saveNativePolicy('source', 'agent_1', { expectedGeneration: 0, expectedSubjectRevision: nativeBefore.subjectRevision,
        policy: { ...defaultAppActionsPolicy(), enabled: true } })
      const tokens = [await seedGrant('selected'), await seedGrant('all')]
      const hashes = await Promise.all(tokens.map(token => redis.json.get(`portable_skill_token:source:${token.record.id}`)))
      const bundle = await createBackupBundle('source')
      await restoreBackupBundle('source', bundle.bytes, { confirmReplace: true })
      for (const [index, token] of tokens.entries()) {
        const current = await redis.json.get(`portable_skill_token:source:${token.record.id}`)
        expect(current.appActionsGrant).toBeNull()
        expect(current.authorityGeneration).toBe(3)
        expect(current.families).toEqual(hashes[index].families)
        expect(current.tokenHash === hashes[index].tokenHash).toBe(true)
        const authenticated = await validatePortableSkillToken(token.token)
        expect(authenticated.valid).toBe(true)
        if (authenticated.valid) expect(authenticated.allowedControlIds).toContain('sys.voice.engine.health_check')
        expect((await portableGrantResponse('source', token.record.id)).grant).toBeNull()
      }
      expect((await nativePolicyResponse('source', 'agent_1')).policy.enabled).toBe(true)
    })
    it('does not revoke grants on unconfirmed restore and preflights every grant before replacement', async () => {
      await canonicalSource()
      const first = await seedGrant('selected'), second = await seedGrant('all')
      const bundle = await createBackupBundle('source')
      await expect(restoreBackupBundle('source', bundle.bytes)).rejects.toMatchObject({ status: 409 })
      expect((await portableGrantResponse('source', first.record.id)).authorityGeneration).toBe(2)
      await redis.json.set('agent:agent_1', '$.displayName', 'Keep current data')
      await redis.json.set(`portable_skill_token:source:${second.record.id}`, '$.authorityGeneration', false)
      await expect(restoreBackupBundle('source', bundle.bytes, { confirmReplace: true })).rejects.toMatchObject({ status: 409 })
      expect((await redis.json.get('agent:agent_1')).displayName).toBe('Keep current data')
      expect((await portableGrantResponse('source', first.record.id)).grant).not.toBeNull()
      expect((await portableGrantResponse('source', first.record.id)).authorityGeneration).toBe(2)
    })
    it('rollback and actual journal recovery do not restore excluded App Actions grants', async () => {
      await canonicalSource()
      const token = await seedGrant('selected')
      const revisionKey = slashCommandRevisionKey('source')
      await redis.set(revisionKey, newSlashCommandRevision())
      const bundle = await createBackupBundle('source')
      await redis.json.set('agent:agent_1', '$.displayName', 'Original before failed restore')
      const client = await redis.execute(async current => current)
      const actual = client.json.set.bind(client.json)
      let failures = 2
      const spy = vi.spyOn(client.json, 'set').mockImplementation((async (key: string, jsonPath: string, value: any, options: any) => {
        if (key === 'agent:agent_1' && jsonPath === '$' && failures > 0) { failures--; throw new Error('P2 target/rollback fixture failure') }
        return actual(key, jsonPath, value, options)
      }) as never)
      try { await expect(restoreBackupBundle('source', bundle.bytes, { confirmReplace: true })).rejects.toThrow('rollback could not finish') }
      finally { spy.mockRestore() }
      expect(failures).toBe(0)
      expect(await redis.get(revisionKey)).toBeNull()
      expect((await portableGrantResponse('source', token.record.id)).grant).toBeNull()
      await ensureBackupRestoreRecovery()
      expect(await redis.get(revisionKey)).toBeNull()
      expect((await redis.json.get('agent:agent_1')).displayName).toBe('Original before failed restore')
      const current = await portableGrantResponse('source', token.record.id)
      expect(current.grant).toBeNull()
      expect(current.authorityGeneration).toBe(4)
      expect((await validatePortableSkillToken(token.token)).valid).toBe(true)
    })
  })

  it('SA-132: backup and restore preserve scoped reasoning intent without new keys or shared-preset writes', async () => {
    await seedRepresentativeData('source')
    const { reasoningOverrideKey } = await import('$lib/utils/modelReasoningControls')
    const key = reasoningOverrideKey({ presetId: 'my_api_key_model_encrypted', connection: { type: 'direct', id: 'direct:openai', service: 'openai' }, effectiveModelId: 'gpt-6.1-sol' }, 'effort')
    expect(key).toMatch(/^r1:[0-9a-f]+$/)
    const overrides = { [key]: { mode: 'value', value: 'max' } }
    await redis.updateAgent('agent_1', { model_reasoning_overrides: overrides } as any)
    const bundle = await createBackupBundle('source')
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(await redis.json.get('agent:agent_1')).toMatchObject({ user_id: 'target', model_reasoning_overrides: overrides })
  })

  it('materializes restored tool grants from the archive global basis before publication, independently of live target defaults', async () => {
    await seedRepresentativeData('source')
    await redis.json.set('user:source:settings', '$.global_tool_grid_settings', { typed_file_tools: true, other: 'archive' })
    await redis.json.set('agent:agent_1', '$.provider_specific_settings', { batshitNativeTools: { bashEnabled: false, batshitToolsEnabled: false, unknown: 'keep', webSearchProvider: 'exa' } })
    await redis.sAdd('user:source:subagents', 'child_1')
    await redis.sAdd('agent:agent_1:subagents', 'child_1')
    await redis.json.set('subagent:child_1', '$', { id: 'child_1', user_id: 'source', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false, artifactRuntimeEnabled: true } } })
    const bundle = await createBackupBundle('source')
    await redis.json.set('user:target:settings', '$', { user_id: 'target', global_tool_grid_settings: { typed_file_tools: false } })
    expect((await preflightBackupRestore('target', bundle.bytes)).ok).toBe(true)
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(await redis.sMembers('agent:agent_1:subagents')).toEqual(['child_1'])
    expect(await redis.json.get('agent:agent_1')).toMatchObject({ user_id: 'target', provider_specific_settings: {
      nativeTools: { bashEnabled: false, unknown: 'keep', typedFileToolsEnabled: true, artifactRuntimeEnabled: false } } })
    expect(await redis.json.get('subagent:child_1')).toMatchObject({ user_id: 'target', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false, artifactRuntimeEnabled: true } } })
    expect(await redis.json.get('user:target:settings')).toMatchObject({ global_tool_grid_settings: { other: 'archive' } })
    expect(await redis.json.get('user:target:settings')).not.toHaveProperty('global_tool_grid_settings.typed_file_tools')
    const original = Object.entries(unzipSync(bundle.bytes)).filter(([name]) => name.startsWith('redis/records/'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
    expect(original.find(record => record.key === 'user:source:settings').value.global_tool_grid_settings.typed_file_tools).toBe(true)
  })

  it('exports a structured backup that excludes secrets by default', async () => {
    await seedRepresentativeData('source')

    const bundle = await createBackupBundle('source')
    expect(bundle.manifest.schemaVersion).toBe(1)
    expect(bundle.manifest.secrets.included).toBe(false)
    expect(bundle.manifest.secrets.excludedRecordCount).toBe(1)
    expect(bundle.manifest.secrets.redactedFieldCount).toBeGreaterThan(0)
    expect(bundle.manifest.contents.fileAssetCount).toBe(4)

    const preflight = await preflightBackupRestore('target', bundle.bytes)
    expect(preflight.ok).toBe(true)
    expect(preflight.sourceUserId).toBe('source')
    expect(preflight.targetUserId).toBe('target')
    expect(preflight.userRemapRequired).toBe(true)
  })

  it('files the schedule keys under the `dms` group, not the `chats` fall-through (SA-115)', async () => {
    // `groupForKey` is the site a round-trip test cannot see: an unregistered key still
    // exports and still restores, it just lands in whatever group the fall-through picks
    // (`chats`). The manifest then lies about what each group holds, and a user restoring
    // "Agent DMs, wake-up webhooks, and schedules" without "Chats" quietly loses the clock.
    await seedRepresentativeData('source')

    const bundle = await createBackupBundle('source')
    const entries = unzipSync(bundle.bytes)
    const grouped = Object.entries(entries)
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
      .filter((record) => record.key === 'schedule:sch_1' || record.key === 'schedules:source')

    expect(grouped.map((record) => record.key).sort()).toEqual([
      'schedule:sch_1',
      'schedules:source'
    ])
    for (const record of grouped) {
      expect(record.groupId).toBe('dms')
    }
  })

  it('files the Judge Juice config under the `settings` group, not the `chats` fall-through (SA-120)', async () => {
    await seedRepresentativeData('source')

    const bundle = await createBackupBundle('source')
    const entries = unzipSync(bundle.bytes)
    const grouped = Object.entries(entries)
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
      .filter((record) => record.key === 'batshit:typesafe_config')

    expect(grouped).toHaveLength(1)
    expect(grouped[0].groupId).toBe('settings')
    // SA-120 P10a: a normal (secret-free) export keeps every judge field; the secret-field rule nulls none of them.
    const exported = JSON.stringify(grouped[0])
    expect(exported).toContain('"sendsKey":true')
    expect(exported).toContain('"accountId":"0123456789abcdef0123456789abcdef"')
    expect(exported).toContain('"baseUrl":"http://192.168.1.20:11434"')
    expect(exported).toContain('"laneProviders":{"untrusted_text":"liquid"}')
    expect(bundle.manifest.secrets.redactedPaths.filter((entry: string) => entry.includes('batshit:typesafe_config'))).toEqual([])
  })

  it('carries the one-time zip defaults sweep marker in `settings`, and a restore replaces it with the backup\'s own (SA-126 1d)', async () => {
    const marker = { version: 1, completed_at: '2026-10-19T19:00:00.000Z', records: 6, rows: 23, fields: 58 }
    const markerRecords = (bytes: Uint8Array) => Object.entries(unzipSync(bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, value]) => JSON.parse(Buffer.from(value).toString('utf8')))
      .filter((record) => record.key === ZIP_DEFAULTS_SWEEP_KEY)
    await seedRepresentativeData('source')
    // An agent stamped by the old `createAgent` (the Write File row of that stamp).
    await redis.json.set('agent:agent_1', '$.buffer_size_write_file', 2)
    await redis.json.set('agent:agent_1', '$.zip_threshold_write_file', 0)
    await redis.json.set('agent:agent_1', '$.auto_zip_write_file', false)
    const beforeSweep = await createBackupBundle('source')
    expect(markerRecords(beforeSweep.bytes)).toEqual([])
    await redis.set(ZIP_DEFAULTS_SWEEP_KEY, marker)
    const afterSweep = await createBackupBundle('source')
    expect(markerRecords(afterSweep.bytes).map((record) => record.groupId)).toEqual(['settings'])

    // A backup from before the sweep brings no marker, and the restore sweeps its records at once
    // (the app does not restart after a restore). The default lane's Redis fake runs no Lua, so
    // there the restore only drops the current marker.
    await restoreBackupBundle('target', beforeSweep.bytes, { confirmReplace: true })
    if (process.env.VITEST_USE_REAL_REDIS === 'true') {
      expect((await redis.json.get('agent:agent_1') as any).auto_zip_write_file).toBeUndefined()
      expect(await redis.get(ZIP_DEFAULTS_SWEEP_KEY)).toMatchObject({
        version: 1, changed: expect.arrayContaining([{ key: 'agent:agent_1', rows: ['write_file'] }])
      })
    } else {
      expect(await redis.exists(ZIP_DEFAULTS_SWEEP_KEY)).toBeFalsy()
    }
    // One from after it brings its own marker back, so later choices equal to an old default stay.
    await restoreBackupBundle('target', afterSweep.bytes, { confirmReplace: true })
    expect(await redis.get(ZIP_DEFAULTS_SWEEP_KEY)).toMatchObject({ version: 1, rows: 23 })
    expect((await redis.json.get('agent:agent_1') as any).auto_zip_write_file).toBe(false)
  })

  it.each(['missing-field', 'missing-provider'])('keeps old host authority inactive across restore/delete/recreate: %s', async shape => {
    vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
    const servers = await import('../localAiServers')
    const management = await import('../localAiModelManagement')
    const id = '11111111-1111-4111-8111-111111111111'
    const modelId = '22222222-2222-4222-8222-222222222222'
    let generation = '33333333-3333-4333-8333-333333333333'
    let grantGeneration = generation
    let revoked = false
    const setup = () => ({ registrationId: id, generationId: grantGeneration, createdAt: '2026-10-04T14:00:00Z',
      models: [{ id: modelId, nativeRef: 'Qwen.gguf', servedName: 'custom', baseConfig: `batshit-managed/base-${modelId}.kcpps` }] })
    await seedRepresentativeData('source')
    if (shape === 'missing-field') await redis.json.set('local_provider:source:koboldcpp', '$', { id: 'koboldcpp', baseUrl: 'http://localhost:5001', openaiPath: '/v1', enabled: true })
    const bundle = await createBackupBundle('source')
    await servers.saveLocalAiServers('target', [{ id: 'koboldcpp', baseUrl: 'http://localhost:5001', enabled: true }])
    await servers.saveKoboldManagedProfileReference('target', { version: 1, registrationId: id, state: 'active' })
    managedHelper.mockImplementation(async (action, input) => {
      if (action === 'fence-restore') {
        expect(await redis.json.get('local_provider:target:koboldcpp')).toMatchObject({ managedProfile: { registrationId: id } })
        expect(input).toMatchObject({ userId: 'target', operationId: expect.stringMatching(/^[a-f0-9-]{36}$/) })
        generation = input.operationId
        return { generationId: generation, retainedFiles: true }
      }
      if (action === 'revoke-owner') { revoked = true; return { revoked: [id], retainedFiles: true } }
      if (action === 'list') return { registrations: revoked || grantGeneration !== generation ? [] : [setup()], reenrollmentRequired: grantGeneration !== generation }
      if (action === 'validate') {
        if (revoked || grantGeneration !== generation) throw new Error('Host grant inactive; explicit re-enrollment required')
        return setup()
      }
      throw new Error(`Unexpected managed action ${action}`)
    })
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    if (shape === 'missing-field') expect(await redis.json.get('local_provider:target:koboldcpp')).toMatchObject({ managedProfile: { registrationId: null, state: 'reenrollment-required' } })
    const { deleteLocalAiServer } = await import('../localAiServerDeletion')
    await deleteLocalAiServer('target', 'koboldcpp')
    expect(managedHelper).toHaveBeenCalledWith('revoke-owner', { userId: 'target', requireState: shape === 'missing-field' })
    await servers.saveLocalAiServers('target', [{ id: 'koboldcpp', baseUrl: 'http://localhost:5001', enabled: true }])
    const previousFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const route = new URL(String(url)).pathname
      if (route === '/api/extra/version') return Response.json({ admin: 2, router: false, llm: true })
      if (route === '/api/admin/list_options') return Response.json(['Qwen.gguf', `batshit-managed/base-${modelId}.kcpps`, 'initial_model', 'unload_model'])
      if (route === '/v1/models') return Response.json({ data: [{ id: 'koboldcpp/custom' }] })
      if (route === '/api/extra/true_max_context_length') return Response.json({ value: 65536 })
      if (route === '/api/extra/perf') return Response.json({ idle: 1, queue: 0, uptime: 100 })
      return previousFetch(url as string, init as RequestInit)
    }))
    const state = await management.readLocalAiManagement('target', 'koboldcpp')
    expect(state.registeredSetup).toBeUndefined()
    await expect(management.enableKoboldManagedSetup('target', id, state.connectionKey!)).rejects.toThrow('re-enrollment')
    expect(await redis.json.get('local_provider:target:koboldcpp')).not.toHaveProperty('managedProfile')
    // Explicit new host enrollment binds this generation even at an equal clock.
    grantGeneration = generation; revoked = false
    expect((await management.enableKoboldManagedSetup('target', id, state.connectionKey!)).success).toBe(true)
    expect(await redis.json.get('local_provider:target:koboldcpp')).toMatchObject({ managedProfile: { state: 'active' } })
  })

  it('refuses destructive restore when durable host fencing fails', async () => {
    vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
    await seedRepresentativeData('source')
    const bundle = await createBackupBundle('source')
    await redis.json.set('local_provider:target:koboldcpp', '$', { id: 'koboldcpp', baseUrl: 'http://localhost:5001', managedProfile: { version: 1, registrationId: 'old-grant', state: 'active' } })
    managedHelper.mockRejectedValue(new Error('Host generation custody unknown'))
    await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toThrow('custody unknown')
    expect(await redis.json.get('local_provider:target:koboldcpp')).toMatchObject({ managedProfile: { registrationId: 'old-grant' } })
    expect(await redis.json.get('user:target:agents')).toBeNull()
    expect(managedHelper).toHaveBeenCalledOnce()
  })

  it('restores managed context preferences inactive without restoring a host grant', async () => {
    await seedRepresentativeData('source')
    await redis.json.set('local_provider:source:koboldcpp', '$', {
      id: 'koboldcpp', baseUrl: 'http://localhost:5001', openaiPath: '/v1', enabled: true,
      managedProfile: { version: 1, registrationId: '11111111-1111-4111-8111-111111111111', state: 'active', desired: { modelId: 'model', contextTokens: 60000 } }
    })
    const bundle = await createBackupBundle('source')
    const names = Object.keys(unzipSync(bundle.bytes))
    expect(names.some(name => name.includes('koboldcpp-managed-profiles') || name.includes('batshit-managed'))).toBe(false)
    expect((await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).restored).toBe(true)
    expect(await redis.json.get('local_provider:target:koboldcpp')).toMatchObject({
      baseUrl: 'http://localhost:5001', managedProfile: { version: 1, registrationId: null, state: 'reenrollment-required', desired: { contextTokens: 60000 }, restoredAt: expect.any(String) }
    })
  })

  it('carries the Judge Juice after-reply records with their chat, in the `chats` group, and restores them (SA-120 P6)', async () => {
    // A new session-scoped key family owes backup a decision. These annotate a chat's replies
    // (the chip under them), so they travel with the chat: collected per session on the way
    // out, restorable on the way in.
    await seedRepresentativeData('source')
    const item = {
      messageId: 'msg_1',
      sessionId: 'sess_1',
      agentId: 'agent_1',
      at: '2026-09-17T08:00:00.000Z',
      findings: [{ id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.91 }],
      notes: [],
      toldAgent: true
    }
    await redis.sAdd('jev_post_turn:sess_1', 'msg_1')
    await redis.json.set('jev_post_turn_item:sess_1:msg_1', '$', item)

    const bundle = await createBackupBundle('source')
    const records = Object.entries(unzipSync(bundle.bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
      .filter((record) => String(record.key).startsWith('jev_post_turn'))
    expect(records.map((record) => [record.key, record.groupId]).sort()).toEqual([
      ['jev_post_turn:sess_1', 'chats'],
      ['jev_post_turn_item:sess_1:msg_1', 'chats']
    ])

    await redis.del('jev_post_turn:sess_1')
    await redis.del('jev_post_turn_item:sess_1:msg_1')
    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(result.restored).toBe(true)
    expect(await redis.sMembers('jev_post_turn:sess_1')).toEqual(['msg_1'])
    expect(await redis.json.get('jev_post_turn_item:sess_1:msg_1')).toEqual(item)
  })

  // SA-139 R1: nothing writes these since Codex CLI was removed; a leftover one still travels.
  it('carries one leftover Codex cleanup warning with its reply in the chats group', async () => {
    await seedRepresentativeData('source')
    const warning = {
      messageId: 'msg_1',
      kind: 'unconfirmed_command_cleanup'
    }
    await redis.sAdd('codex_cleanup_warnings:sess_1', 'msg_1')
    await redis.json.set('codex_cleanup_warning:sess_1:msg_1', '$', warning)
    const bundle = await createBackupBundle('source')
    const records = Object.entries(unzipSync(bundle.bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
      .filter((record) => String(record.key).startsWith('codex_cleanup_warning'))
    expect(records.map((record) => [record.key, record.groupId]).sort()).toEqual([
      ['codex_cleanup_warning:sess_1:msg_1', 'chats'],
      ['codex_cleanup_warnings:sess_1', 'chats']
    ])
    await redis.del('codex_cleanup_warnings:sess_1')
    await redis.del('codex_cleanup_warning:sess_1:msg_1')
    expect((await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).restored).toBe(true)
    expect(await redis.sMembers('codex_cleanup_warnings:sess_1')).toEqual(['msg_1'])
    expect(await redis.json.get('codex_cleanup_warning:sess_1:msg_1')).toEqual(warning)
  })

  it('carries where a reply\'s pictures came from with its chat, in the chats group (BL-474 step 2)', async () => {
    await seedRepresentativeData('source')
    const decided = {
      messageId: 'msg_1',
      version: 1,
      state: 'decided',
      textHashes: ['e'.repeat(64)],
      lane: 'api',
      complete: true,
      addresses: { 'https://pictures.example.org/a.png': {
        state: 'blocked', rule: 4,
        evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
      } }
    }
    const pending = { messageId: 'msg_2', version: 1790000000000, state: 'pending' }
    const replaySource = { textHash: 'a'.repeat(64), spans: [{ start: 0, end: 12, source: 'agent_note' }] }
    const reply = await redis.json.get('message:sess_1:msg_1') as Record<string, any>
    await redis.json.set('message:sess_1:msg_1', '$', { ...reply, metadata: {
      ...(reply.metadata ?? {}), imageOriginExpected: true, imageOriginExpectedVersion: 1,
      providerUserSources: [replaySource]
    } })
    await redis.sAdd('image_origins:sess_1', 'msg_1')
    await redis.sAdd('image_origins:sess_1', 'msg_2')
    await redis.json.set('image_origin:sess_1:msg_1', '$', decided)
    await redis.json.set('image_origin:sess_1:msg_2', '$', pending)
    const bundle = await createBackupBundle('source')
    const records = Object.entries(unzipSync(bundle.bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
      .filter((record) => String(record.key).startsWith('image_origin'))
    expect(records.map((record) => [record.key, record.groupId]).sort()).toEqual([
      ['image_origin:sess_1:msg_1', 'chats'],
      ['image_origin:sess_1:msg_2', 'chats'],
      ['image_origins:sess_1', 'chats']
    ])
    await redis.del('image_origins:sess_1')
    await redis.del('image_origin:sess_1:msg_1')
    await redis.del('image_origin:sess_1:msg_2')
    expect((await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).restored).toBe(true)
    expect((await redis.sMembers('image_origins:sess_1')).sort()).toEqual(['msg_1', 'msg_2'])
    expect(await redis.json.get('image_origin:sess_1:msg_1')).toEqual(decided)
    expect(await redis.json.get('image_origin:sess_1:msg_2')).toEqual(pending)
    expect((await redis.json.get('message:sess_1:msg_1') as any).metadata).toMatchObject({
      imageOriginExpected: true, imageOriginExpectedVersion: 1, providerUserSources: [replaySource]
    })
  })

  it('backs up and restores a size-guard raw copy and its chat index before the reply is saved', async () => {
    if (process.env.VITEST_USE_REAL_REDIS !== 'true') vi.stubEnv('VITEST_FAKE_RETAINED_OUTPUT_EVAL', 'true')
    await seedRepresentativeData('source')
    const content = 'retained output line\n'.repeat(6_000)
    await guardToolModelText(content, {
      userId: 'source', sessionId: 'sess_1', messageId: 'unfinished-reply', agentId: 'agent_1'
    })
    const [zipId] = await redis.sMembers('session:sess_1:zips')
    const bundle = await createBackupBundle('source')
    const records = Object.entries(unzipSync(bundle.bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
    expect(records.find((record) => record.key === `zip:${zipId}`)?.groupId).toBe('chats')
    expect(records.some((record) => record.key === 'session:sess_1:zips')).toBe(true)

    await redis.del(`zip:${zipId}`)
    await redis.del('session:sess_1:zips')
    expect((await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).restored).toBe(true)
    expect(await redis.getZip(zipId)).toMatchObject({ content, type: 'tool_raw', metadata: {
      userId: 'target', sessionId: 'sess_1', messageId: 'unfinished-reply', agentId: 'agent_1', retainedForSizeGuard: true
    } })
    expect(await redis.sMembers('session:sess_1:zips')).toContain(zipId)
  })

  it("carries an agent's hold with its path and agent id, in the `chats` group, and restores it exactly (SA-129 P2b, BL-359)", async () => {
    // P2 added `path` and `agentId` to `unzipped_item`. There is no shape check to add them to:
    // backup copies the whole record and restore rewrites only user id fields, so both come back
    // exactly. This pins that, since the hold follows the file and releases by these two fields.
    await seedRepresentativeData('source')
    const agentHold = {
      zipId: 'cool_tool_1790700000000_hold1',
      sessionId: 'sess_1',
      permanent: true,
      unzippedAt: 1790700000000,
      source: 'agent',
      path: 'skill:example:SKILL.md',
      skillSession: { skillId: 'example', generation: 1, automatic: true },
      agentId: 'agent_1',
      name: 'read_file',
      tokens: 42
    }
    const userCountdown = {
      zipId: 'cool_tool_1790700000000_hold2',
      sessionId: 'sess_1',
      permanent: false,
      duration: 10,
      messageCount: 3,
      unzippedAt: 1790700000001,
      source: 'user'
    }
    await redis.sAdd('unzipped:sess_1', agentHold.zipId)
    await redis.sAdd('unzipped:sess_1', userCountdown.zipId)
    await redis.set(`unzipped_item:sess_1:${agentHold.zipId}`, agentHold)
    await redis.set(`unzipped_item:sess_1:${userCountdown.zipId}`, userCountdown)

    const skillSessions = { version: 1, userId: 'source', sessionId: 'sess_1', entries: [{
      agentId: 'agent_1', skillId: 'example', name: 'Example', status: 'open', generation: 1, revision: 4,
      openedAt: 1, openedMessageId: 'msg_1', reads: [{ zipId: agentHold.zipId, rawZipId: agentHold.zipId,
        messageId: 'msg_1', path: 'SKILL.md', sourceSha256: 'a'.repeat(64), offset: 0, returnedChars: 12, originalChars: 12 }]
    }] }
    await redis.json.set('skill_sessions:sess_1', '$', skillSessions)
    const bundle = await createBackupBundle('source')
    const records = Object.entries(unzipSync(bundle.bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')))
      .filter((record) => String(record.key).startsWith('unzipped') || record.key === 'skill_sessions:sess_1')
    expect(records.map((record) => [record.key, record.groupId]).sort()).toEqual([
      ['skill_sessions:sess_1', 'chats'],
      ['unzipped:sess_1', 'chats'],
      [`unzipped_item:sess_1:${agentHold.zipId}`, 'chats'],
      [`unzipped_item:sess_1:${userCountdown.zipId}`, 'chats']
    ])

    await redis.del('skill_sessions:sess_1')
    await redis.del('unzipped:sess_1')
    await redis.del(`unzipped_item:sess_1:${agentHold.zipId}`)
    await redis.del(`unzipped_item:sess_1:${userCountdown.zipId}`)
    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(result.restored).toBe(true)
    expect(await redis.json.get('skill_sessions:sess_1')).toEqual({ ...skillSessions, userId: 'target' })
    expect((await redis.sMembers('unzipped:sess_1')).sort()).toEqual([agentHold.zipId, userCountdown.zipId].sort())
    expect(await redis.get(`unzipped_item:sess_1:${agentHold.zipId}`)).toEqual(agentHold)
    expect(await redis.get(`unzipped_item:sess_1:${userCountdown.zipId}`)).toEqual(userCountdown)
  })

  describe('a list with one entry stays a list (BL-128)', () => {
    // The three key families that store a list at the root. With one entry each: a chat
    // after its first run, one artifact in the panel, and a Subagent thread of one message.
    const RUN = {
      id: 'msg_run_1',
      sessionId: 'sess_1',
      userId: 'source',
      agentId: 'agent_1',
      createdAt: '2026-09-22T12:00:00.000Z'
    }
    const THREAD_MESSAGE = { role: 'user', content: 'Find the invoice from March.' }

    async function seedOneEntryLists() {
      await seedRepresentativeData('source')
      await redis.json.set('session:sess_1:execution_log', '$', [RUN])
      await redis.json.set('user:source:artifact_order:panel', '$', ['artifact_1'])
      await redis.json.set('subagent_sessions:sess_1:subagent:researcher', '$', [THREAD_MESSAGE])
    }

    function exportedRecords(bytes: Uint8Array) {
      const entries = unzipSync(bytes)
      return new Map(
        Object.entries(entries)
          .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
          .map(([name, entryBytes]) => {
            const record = JSON.parse(Buffer.from(entryBytes).toString('utf8'))
            return [record.key as string, { name, record }]
          })
      )
    }

    async function expectListsReadable() {
      // The Execution Viewer is the reader that lost the run: it reads nothing but a list.
      const snapshots = await executionViewerService.getSnapshots('sess_1')
      expect(snapshots.map((snapshot) => snapshot.id)).toEqual(['msg_run_1'])
      expect(await redis.json.get('user:target:artifact_order:panel')).toEqual(['artifact_1'])
      expect(await redis.json.get('subagent_sessions:sess_1:subagent:researcher')).toEqual([
        THREAD_MESSAGE
      ])
    }

    it('saves each one as a list and restores it readable', async () => {
      await seedOneEntryLists()

      const bundle = await createBackupBundle('source')
      const records = exportedRecords(bundle.bytes)
      expect(records.get('session:sess_1:execution_log')?.record.value).toEqual([RUN])
      expect(records.get('user:source:artifact_order:panel')?.record.value).toEqual(['artifact_1'])
      expect(records.get('subagent_sessions:sess_1:subagent:researcher')?.record.value).toEqual([
        THREAD_MESSAGE
      ])

      const preflight = await preflightBackupRestore('target', bundle.bytes)
      expect(preflight.warnings.join('\n')).not.toContain('one-item')

      const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
      expect(result.restored).toBe(true)
      await expectListsReadable()
    })

    it('puts one an older backup saved as a single item back in its list, and says so', async () => {
      await seedOneEntryLists()
      const bundle = await createBackupBundle('source')

      // Rebuild the archive the way export wrote it before BL-128: each one-entry list as
      // the entry itself. Nothing else in the archive changes.
      const entries = { ...unzipSync(bundle.bytes) }
      const records = exportedRecords(bundle.bytes)
      for (const key of [
        'session:sess_1:execution_log',
        'user:source:artifact_order:panel',
        'subagent_sessions:sess_1:subagent:researcher'
      ]) {
        const found = records.get(key)
        expect(found, key).toBeDefined()
        const flattened = { ...found!.record, value: found!.record.value[0] }
        entries[found!.name] = new Uint8Array(Buffer.from(JSON.stringify(flattened), 'utf8'))
      }
      const olderBytes = zipSync(entries)

      const preflight = await preflightBackupRestore('target', olderBytes)
      expect(preflight.ok).toBe(true)
      expect(preflight.warnings).toContain(
        "An older Batshit saved 3 one-item lists in this backup as a single item (a chat's Execution Viewer log after one run, an artifact order, or a Subagent thread). Restore puts them back as lists."
      )

      const result = await restoreBackupBundle('target', olderBytes, { confirmReplace: true })
      expect(result.restored).toBe(true)
      await expectListsReadable()
      // A record whose value is an object is restored as saved, never put in a list.
      expect(await redis.json.get('session:sess_1')).toMatchObject({ id: 'sess_1', title: 'Backup Chat' })
    })
  })

  it("throws the restored user's saved tool lists away, because gateways and keys were replaced around the gateway service", async () => {
    await seedRepresentativeData('source')
    const bundle = await createBackupBundle('source')
    const target = { userId: 'target', gatewayId: 'gw-docker', inputs: { probe: 'bundle' } }
    const otherUser = { ...target, userId: 'someone-else' }
    await mcpToolListCache.read(target, async () => ({ ok: true, tools: [] }))
    await mcpToolListCache.read(otherUser, async () => ({ ok: true, tools: [] }))

    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(result.restored).toBe(true)

    const askAgain = vi.fn(async () => ({ ok: true as const, tools: [] }))
    await mcpToolListCache.read(target, askAgain)
    expect(askAgain).toHaveBeenCalledTimes(1)
    await mcpToolListCache.read(otherUser, askAgain)
    expect(askAgain).toHaveBeenCalledTimes(1)
  })

  it('leaves managed CLI run credentials out of the backup on BOTH sides (SA-117 DL-117-09)', async () => {
    // Transient run state, like `subagent_lock:`. A wake hook's `tokenHash` IS exported,
    // because a hook is a durable thing the user made and a restore without the hash leaves it
    // permanently unauthenticatable. A run credential is the opposite: it names one managed
    // CLI turn that has already ended, so a restored one could only ever authenticate as an
    // agent for a run nobody is taking — which is a live credential handed back for free.
    await seedRepresentativeData('source')
    const credentialId = 'arc_retired_backup_fixture'
    const recordKey = agentRunCredentialKey(credentialId)
    const indexKey = agentRunCredentialsIndexKey('agent_1')
    await redis.json.set(recordKey, '$', { id: credentialId, agentId: 'agent_1' } as never)
    await redis.execute(client => client.sAdd(indexKey, [credentialId]))
    expect(await redis.exists(recordKey)).toBeTruthy()

    // Half one: never collected, so never exported. Includes the agent-scoped index SET,
    // which `collectCandidateKeys` reads for the wake-hook and schedule families.
    const bundle = await createBackupBundle('source')
    const exportedKeys = Object.entries(unzipSync(bundle.bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')).key as string)
    expect(exportedKeys).not.toContain(recordKey)
    expect(exportedKeys).not.toContain(indexKey)

    // Half two: `isRestorableKeyForUser` refuses it, so a hand-built or future archive
    // carrying one is rejected outright rather than quietly writing a credential.
    const entries = unzipSync(bundle.bytes)
    const records = Object.entries(entries)
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([name, value]) => {
        delete entries[name]
        return JSON.parse(Buffer.from(value).toString('utf8')) as Record<string, any>
      })
    records.push({
      key: recordKey,
      type: 'json',
      groupId: 'chats',
      value: (await redis.json.get(recordKey)) as Record<string, any>
    })
    records.forEach((record, index) => {
      entries[`redis/records/${String(index + 1).padStart(8, '0')}.json`] = Buffer.from(
        JSON.stringify(record)
      )
    })
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
    manifest.contents.redisRecordCount = records.length
    entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))

    await expect(
      restoreBackupBundle('target', zipSync(entries), { confirmReplace: true })
    ).rejects.toThrow(/will not restore/i)
  })

  it('never exports a live file read receipt, and a restore deletes the replaced chats\' receipts (SA-137 P4)', async () => {
    await seedRepresentativeData('source')
    await redis.json.set('live_file_reads:sess_1', '$', { v: 1, userId: 'source', sessionId: 'sess_1', boot: 'b', pending: null, delivered: null })
    const bundle = await createBackupBundle('source')
    const exportedKeys = Object.entries(unzipSync(bundle.bytes))
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')).key as string)
    expect(exportedKeys).toContain('session:sess_1')
    expect(exportedKeys).not.toContain('live_file_reads:sess_1')
    await restoreBackupBundle('source', bundle.bytes, { confirmReplace: true })
    expect(await redis.exists('session:sess_1')).toBeTruthy()
    expect(await redis.exists('live_file_reads:sess_1')).toBeFalsy()
  })

  it('excludes the skill access catalogue nonce from export/import and clears only the target marker at confirmed restore', async () => {
    await seedRepresentativeData('source')
    const sourceKey = slashCommandRevisionKey('source'), targetKey = slashCommandRevisionKey('target')
    const sourceNonce = newSlashCommandRevision(), targetNonce = newSlashCommandRevision()
    await redis.set(sourceKey, sourceNonce)
    await redis.set(targetKey, targetNonce)
    const bundle = await createBackupBundle('source')
    const entries = unzipSync(bundle.bytes)
    const records = Object.entries(entries).filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, value]) => JSON.parse(Buffer.from(value).toString('utf8')))
    expect(records.some(record => record.key === sourceKey)).toBe(false)
    await expect(restoreBackupBundle('target', bundle.bytes)).rejects.toMatchObject({ status: 409 })
    expect(await redis.get(targetKey)).toBe(targetNonce)
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(await redis.get(targetKey)).toBeNull()
    expect(await redis.get(sourceKey)).toBe(sourceNonce)

    records.push({ key: sourceKey, type: 'string', groupId: 'tools', value: sourceNonce })
    records.forEach((record, index) => { entries[`redis/records/${String(index + 1).padStart(8, '0')}.json`] = Buffer.from(JSON.stringify(record)) })
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
    manifest.contents.redisRecordCount = records.length
    entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
    await expect(restoreBackupBundle('target', zipSync(entries), { confirmReplace: true })).rejects.toThrow(/will not restore/i)
  })

  it('never carries the Dev switch "Use paused plans on this copy" into another copy (plan pause)', async () => {
    // A setting of ONE copy: Josh's own Dev copy may switch the plan pause off,
    // and a backup restored on any other copy must not bring that switch along.
    await seedRepresentativeData('source')
    const switchKey = 'batshit:dev:paused_plans'
    await redis.json.set(switchKey, '$', { usePausedPlans: true, updatedAt: 'zcpause' } as never)

    const bundle = await createBackupBundle('source')
    const entries = unzipSync(bundle.bytes)
    const records = Object.entries(entries)
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([name, value]) => {
        delete entries[name]
        return JSON.parse(Buffer.from(value).toString('utf8')) as Record<string, any>
      })
    expect(records.map((record) => record.key)).not.toContain(switchKey)

    records.push({ key: switchKey, type: 'json', groupId: 'settings', value: { usePausedPlans: true } })
    records.forEach((record, index) => {
      entries[`redis/records/${String(index + 1).padStart(8, '0')}.json`] = Buffer.from(
        JSON.stringify(record)
      )
    })
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
    manifest.contents.redisRecordCount = records.length
    entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
    await redis.del(switchKey)

    await expect(
      restoreBackupBundle('target', zipSync(entries), { confirmReplace: true })
    ).rejects.toThrow(/will not restore/i)
    expect(await redis.exists(switchKey)).toBeFalsy()
  })

  it('excludes Goon file-operation authority from export and refuses it in a hand-built import', async () => {
    await seedRepresentativeData('source')
    const authorityKeys = [
      `goon_asset_delete:goon_custom_models:${'a'.repeat(64)}.glb`,
      'goon_asset_restore',
      'goon_asset_restore_done:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ]
    for (const key of authorityKeys) await redis.set(key, 'local-operation-authority')
    const bundle = await createBackupBundle('source')
    const originalEntries = unzipSync(bundle.bytes)
    const exportedKeys = Object.entries(originalEntries)
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')).key as string)
    for (const key of authorityKeys) {
      expect(exportedKeys).not.toContain(key)
      await redis.del(key)
    }
    for (const key of authorityKeys) {
      const entries = { ...originalEntries }
      const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
      const count = manifest.contents.redisRecordCount + 1
      entries[`redis/records/${String(count).padStart(8, '0')}.json`] = Buffer.from(JSON.stringify({
        key, type: 'string', value: 'forged-operation-authority', ttlSeconds: null, groupId: 'goons'
      }))
      manifest.contents.redisRecordCount = count
      entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
      await expect(restoreBackupBundle('target', zipSync(entries), { confirmReplace: true }))
        .rejects.toThrow(/will not restore/i)
      expect(await redis.exists(key)).toBe(false)
    }
  })

  it('can include encrypted secret records only when requested', async () => {
    await seedRepresentativeData('source')

    const bundle = await createBackupBundle('source', { includeSecrets: true })

    expect(bundle.manifest.secrets.included).toBe(true)
    expect(bundle.manifest.secrets.excludedRecordCount).toBe(0)
    expect(bundle.manifest.contents.groups.find((group) => group.id === 'api-keys')?.recordCount).toBe(1)
    const entries = unzipSync(bundle.bytes)
    const recordKeys = Object.entries(entries)
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')).key)
    for (const key of TRANSIENT_DELEGATION_KEYS) {
      expect(recordKeys).not.toContain(key)
    }
  })

  it('streams filesystem assets into a readable zip backup', async () => {
    await seedRepresentativeData('source')

    const bundle = await createBackupBundleStream('source')
    const bytes = new Uint8Array(await new Response(bundle.stream).arrayBuffer())
    const entries = unzipSync(bytes)

    expect(bundle.manifest.contents.fileAssetCount).toBe(4)
    expect(Object.keys(entries)).toContain('manifest.json')
    expect(Object.keys(entries)).toContain('files/uploads/images/photo.png')
    expect(Object.keys(entries)).toContain('files/uploads/avatars/agent/legacy-avatar.png')
    expect(Object.keys(entries)).toContain('files/uploads/goon_facial_artwork/brow-left.png')
    expect(Object.keys(entries)).toContain('files/uploads/memory-media/agent_1/mem_1/media_1.png')
    expect(Buffer.from(entries['files/uploads/images/photo.png']).toString('utf8')).toBe('image-bytes')
    expect(Buffer.from(entries['files/uploads/avatars/agent/legacy-avatar.png']).toString('utf8')).toBe(
      'legacy-avatar-bytes'
    )
    expect(
      Buffer.from(entries['files/uploads/goon_facial_artwork/brow-left.png']).toString('utf8')
    ).toBe('facial-artwork-bytes')
    expect(
      Buffer.from(entries['files/uploads/memory-media/agent_1/mem_1/media_1.png']).toString('utf8')
    ).toBe('memory-image-bytes')
    expect(
      Object.keys(entries).filter((name) => name.startsWith('redis/records/') && name.endsWith('.json'))
        .length
    ).toBeGreaterThan(0)
  })

  it('rejects corrupt bundles before mutating data', async () => {
    await expect(preflightBackupRestore('target', new TextEncoder().encode('not-a-zip'))).rejects.toMatchObject({
      status: 400
    } satisfies Partial<BackupRestoreError>)
  })

  it('restores representative data into the current user without merging', async () => {
    await seedRepresentativeData('source')
    const bundle = await createBackupBundle('source')
    await redis.json.set('user:target:settings', '$', {
      id: 'settings_target',
      user_id: 'target',
      displayName: 'Old Target'
    })
    expect(Object.keys(unzipSync(bundle.bytes))).toContain('manifest.json')
    const entries = unzipSync(bundle.bytes)
    expect(Object.keys(entries)).not.toContain('redis/records.json')
    const recordEntryNames = Object.keys(entries)
      .filter((name) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right))
    expect(recordEntryNames.length).toBeGreaterThan(0)
    const records = recordEntryNames.map((name) =>
      JSON.parse(Buffer.from(entries[name]).toString('utf8'))
    ) as Array<Record<string, any>>
    expect(records.find((record) => record.key === 'upload:images:photo.png')?.value).toMatchObject({
      storage: 'filesystem',
      relativePath: 'images/photo.png'
    })
    for (const [key, value] of Object.entries(DELEGATION_BACKUP_RECORDS)) {
      expect(records.find((record) => record.key === key)).toMatchObject({
        type: 'string',
        value,
        groupId: 'prompts'
      })
    }
    for (const key of [...TRANSIENT_DELEGATION_KEYS, RETIRED_THREAD_ID_KEY]) {
      expect(records.some((record) => record.key === key)).toBe(false)
    }
    // Remove the source copies so the following assertions prove restore hydrated the
    // saved thread and editable prompts, without recreating live locks or credentials.
    for (const key of [...Object.keys(DELEGATION_BACKUP_RECORDS), ...TRANSIENT_DELEGATION_KEYS, RETIRED_THREAD_ID_KEY]) {
      await redis.del(key)
    }

    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    expect(result.restored).toBe(true)
    expect(result.targetUserId).toBe('target')
    expect(result.fileAssetCount).toBe(4)

    const settings = (await redis.json.get('user:target:settings')) as Record<string, any>
    expect(settings.user_id).toBe('target')
    expect(settings.id).toBe('settings_target')
    expect(settings.upload_settings.webhookAuth).toBeNull()
    expect(settings.upload_settings.preservedCustomMap).toEqual({ laugh: ['ha', 'haha'] })
    expect(settings.upload_settings.maxOutputTokens).toBe(1200)

    const sessions = await redis.sMembers('user:target:sessions')
    expect(sessions).toEqual(['sess_1'])
    const session = (await redis.json.get('session:sess_1')) as Record<string, any>
    expect(session.user_id).toBe('target')
    const message = (await redis.json.get('message:sess_1:msg_1')) as Record<string, any>
    expect(message.user_id).toBe('target')
    expect(await redis.exists('api_keys:target:openai')).toBe(false)
    for (const [key, value] of Object.entries(DELEGATION_BACKUP_RECORDS)) {
      expect(await redis.get(key)).toBe(value)
    }
    for (const key of [...TRANSIENT_DELEGATION_KEYS, RETIRED_THREAD_ID_KEY]) {
      expect(await redis.exists(key)).toBe(false)
    }

    const customProvider = (await redis.json.get('custom_provider:target:custom_alpha')) as Record<string, any>
    expect(customProvider.apiKeyEncrypted).toBeNull()

    const uploadRecord = (await redis.json.get('upload:images:photo.png')) as Record<string, any>
    expect(uploadRecord.filePath).toBe(path.join(uploadRoot, 'images', 'photo.png'))
    await expect(fs.readFile(path.join(uploadRoot, 'images', 'photo.png'), 'utf8')).resolves.toBe(
      'image-bytes'
    )
    const legacyUploadRecord = (await redis.json.get('upload:avatars:agent:legacy-avatar.png')) as Record<
      string,
      any
    >
    expect(legacyUploadRecord.base64).toBeUndefined()
    expect(legacyUploadRecord.storage).toBe('filesystem')
    expect(legacyUploadRecord.relativePath).toBe('avatars/agent/legacy-avatar.png')
    await expect(
      fs.readFile(path.join(uploadRoot, 'avatars', 'agent', 'legacy-avatar.png'), 'utf8')
    ).resolves.toBe('legacy-avatar-bytes')
    const restoredArtwork = (await redis.json.get(
      'upload:goon_facial_artwork:brow-left.png'
    )) as Record<string, any>
    expect(restoredArtwork.filePath).toBe(
      path.join(uploadRoot, 'goon_facial_artwork', 'brow-left.png')
    )
    await expect(
      fs.readFile(path.join(uploadRoot, 'goon_facial_artwork', 'brow-left.png'), 'utf8')
    ).resolves.toBe('facial-artwork-bytes')
    const restoredGoon = (await redis.json.get('goon:goon_facial')) as Record<string, any>
    expect(restoredGoon.user_id).toBe('target')
    expect(restoredGoon.facialArtwork.roles.brows.shared.artwork.upload.url).toBe(
      '/uploads/goon_facial_artwork/brow-left.png'
    )
    expect(restoredGoon.eyeAppearance).toMatchObject({
      schemaVersion: 'eye-appearance-state/v5',
      irisSize: 1.1
    })

    const restoredMemory = (await redis.json.get('memory:agent_1:mem_1')) as Record<string, any>
    expect(restoredMemory.user_id).toBe('target')
    expect(restoredMemory.content).toContain('Maggie')
    expect(restoredMemory.embedding).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(restoredMemory.media).toHaveLength(1)
    expect(await redis.json.get('upload:memory-media:agent_1/mem_1/media_1.png')).toMatchObject({
      storage: 'filesystem',
      relativePath: 'memory-media/agent_1/mem_1/media_1.png'
    })
    await expect(
      fs.readFile(path.join(uploadRoot, 'memory-media', 'agent_1', 'mem_1', 'media_1.png'), 'utf8')
    ).resolves.toBe('memory-image-bytes')
    const restoredSegment = (await redis.json.get('memseg:agent_1:memseg_1')) as Record<string, any>
    expect(restoredSegment.user_id).toBe('target')
    expect(restoredSegment.session_id).toBe('sess_1')
    const restoredMemoryConfig = (await redis.json.get('batshit:memory_config')) as Record<string, any>
    expect(restoredMemoryConfig.embedding.lane).toBe('local-ai')
    const restoredTypesafeConfig = (await redis.json.get('batshit:typesafe_config')) as Record<string, any>
    expect(restoredTypesafeConfig).toMatchObject({ enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 2500 })
    // SA-120 P10a: the judges, the default, and the per-feature choices come back exactly.
    expect(restoredTypesafeConfig.providers).toHaveLength(3)
    expect(restoredTypesafeConfig.providers[2]).toEqual({
      id: 'liquid',
      kind: 'systemone_url',
      label: 'Liquid AI',
      baseUrl: 'https://api.liquid.ai/decisions',
      modelId: 'lfm2-d1',
      sendsKey: true
    })
    expect(restoredTypesafeConfig).toMatchObject({ defaultProviderId: 'ollama-pc', laneProviders: { untrusted_text: 'liquid' } })
    const restoredMemoryMeta = (await redis.json.get('batshit:memory_index_meta')) as Record<string, any>
    expect(restoredMemoryMeta.dims).toBe(4)
    const restoredEpisode = (await redis.json.get('episode:sess_1:ep_1')) as Record<string, any>
    expect(restoredEpisode.state).toBe('closed')
    expect(restoredEpisode.whiteboard.content).toContain('vet appointment')
    expect(await redis.lRange('session:sess_1:episodes', 0, -1)).toEqual(['ep_1'])
    const restoredDream = (await redis.json.get('memdream:agent_1:dream_1')) as Record<string, any>
    expect(restoredDream.user_id).toBe('target')
    expect(restoredDream.actions[0].why).toContain('demoted')
    expect(await redis.lRange('memdream_index:agent_1', 0, -1)).toEqual(['dream_1'])

    // SA-113 P2: the `dms` group — record plus all three indexes.
    const restoredDm = (await redis.json.get('dm:dm_1')) as Record<string, any>
    expect(restoredDm).toMatchObject({
      to: 'agent_1',
      kind: 'assignment',
      subject: 'Verify the package',
      status: 'new'
    })
    expect(restoredDm.userId).toBe('target')
    const restoredIndexes = await redis.execute(async (client) => ({
      inbox: await client.zRange('dm_inbox:agent_1', 0, -1),
      sent: await client.zRange('dm_sent:agent_2', 0, -1),
      all: await client.zRange('dm_index:target', 0, -1)
    }))
    expect(restoredIndexes.inbox).toEqual(['dm_1'])
    expect(restoredIndexes.sent).toEqual(['dm_1'])
    expect(restoredIndexes.all).toEqual(['dm_1'])

    // SA-113 P3: the wake-up webhook travels with it, remapped to the target user, with its
    // token fingerprint intact so the existing token still works after a restore.
    const restoredHook = (await redis.json.get('wake_hook:whk_1')) as Record<string, any>
    expect(restoredHook).toMatchObject({
      id: 'whk_1',
      agentId: 'agent_1',
      name: 'Nightly build',
      deliverDefault: 'wake',
      enabled: true
    })
    expect(restoredHook.userId).toBe('target')
    expect(restoredHook.tokenHash).toBe('a'.repeat(64))
    const restoredHookIndex = await redis.execute(async (client) =>
      client.sMembers('wake_hooks:target')
    )
    expect(restoredHookIndex).toEqual(['whk_1'])

    // SA-115 P3: the schedule travels too, with its next run and its cadence intact, and
    // the user-scoped index SET remapped to the target user — without that remap the
    // record survives and nothing can ever find it.
    const restoredSchedule = (await redis.json.get('schedule:sch_1')) as Record<string, any>
    expect(restoredSchedule).toMatchObject({
      id: 'sch_1',
      agentId: 'agent_1',
      name: 'Morning check',
      cadence: { type: 'daily', at: '09:00' },
      timeZone: 'America/Chicago',
      deliver: 'wake',
      enabled: true,
      nextRunAt: '2026-09-09T14:00:00.000Z'
    })
    expect(restoredSchedule.userId).toBe('target')
    const restoredScheduleIndex = await redis.execute(async (client) =>
      client.sMembers('schedules:target')
    )
    expect(restoredScheduleIndex).toEqual(['sch_1'])
  })

  it('preflights and restores a disk-staged archive without buffering upload assets', async () => {
    await seedRepresentativeData('source')
    const bundle = await createBackupBundle('source')
    const stageId = '11111111-2222-4333-8444-555555555555'
    const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
    const archivePath = path.join(backupStagingRoot, `${storageKey}.zip`)
    await fs.writeFile(archivePath, bundle.bytes)
    await fs.writeFile(
      path.join(backupStagingRoot, `${storageKey}.json`),
      `${JSON.stringify({
        contract: 'batshit-backup-stage/v1',
        stageId,
        userId: 'target',
        filename: 'batshit-backup.zip',
        bytes: bundle.bytes.byteLength,
        sha256: createHash('sha256').update(bundle.bytes).digest('hex'),
        stagedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        archivePath
      })}\n`
    )
    await redis.json.set('user:target:settings', '$', {
      id: 'settings_target',
      user_id: 'target',
      displayName: 'Old Target'
    })
    await fs.writeFile(path.join(uploadRoot, 'old-target-only.txt'), 'old target')

    const preflight = await preflightStagedBackupRestore('target', stageId)
    expect(preflight.stage).toMatchObject({ id: stageId, archiveBytes: bundle.bytes.byteLength })
    expect(preflight.disk?.sufficient).toBe(true)
    expect(preflight.fileAssetCount).toBe(4)

    const tamperedBytes = new Uint8Array(bundle.bytes)
    tamperedBytes[Math.floor(tamperedBytes.byteLength / 2)] ^= 0xff
    await fs.writeFile(archivePath, tamperedBytes)
    await expect(
      restoreStagedBackup('target', stageId, { confirmReplace: true })
    ).rejects.toThrow(/verified SHA-256 identity/)
    await fs.writeFile(archivePath, bundle.bytes)
    const savedToolList = { userId: 'target', gatewayId: 'gw-docker', inputs: { probe: 'staged' } }
    await mcpToolListCache.read(savedToolList, async () => ({ ok: true, tools: [] }))

    const recipeEpoch = captureRecipeVerificationEpoch()
    const result = await restoreStagedBackup('target', stageId, { confirmReplace: true })
    expect(isRecipeVerificationEpochCurrent(recipeEpoch)).toBe(false)
    expect(captureRecipeVerificationEpoch()).not.toBeNull()
    expect(result).toMatchObject({ restored: true, fileAssetCount: 4, targetUserId: 'target' })
    // The restore replaced the gateways and API keys around the gateway service, so the
    // next send asks every tool server again.
    const askAgain = vi.fn(async () => ({ ok: true as const, tools: [] }))
    await mcpToolListCache.read(savedToolList, askAgain)
    expect(askAgain).toHaveBeenCalledTimes(1)
    await expect(fs.readFile(path.join(uploadRoot, 'images', 'photo.png'), 'utf8')).resolves.toBe(
      'image-bytes'
    )
    await expect(fs.stat(path.join(uploadRoot, 'old-target-only.txt'))).rejects.toThrow()
    await expect(fs.stat(archivePath)).rejects.toThrow()
    await expect(redis.json.get('user:target:settings')).resolves.toMatchObject({
      user_id: 'target',
      displayName: 'Source User'
    })
  })

  it('recovers Redis and uploaded files from an interrupted restore journal', async () => {
    const stageId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
    const originalRecord = {
      key: 'user:target:settings',
      type: 'json' as const,
      value: { id: 'settings_target', user_id: 'target', displayName: 'Before Restore' },
      ttlSeconds: null,
      groupId: 'settings' as const
    }
    const targetRecord = {
      ...originalRecord,
      value: { id: 'settings_target', user_id: 'target', displayName: 'Interrupted Target' }
    }
    await redis.json.set(originalRecord.key, '$', targetRecord.value)

    const oldRoot = path.join(uploadRoot, `.restore-old-${storageKey}`)
    await fs.mkdir(oldRoot, { recursive: true })
    await fs.writeFile(path.join(oldRoot, 'before.txt'), 'before restore')
    await fs.writeFile(path.join(uploadRoot, 'after.txt'), 'partial restore')
    await fs.writeFile(
      path.join(backupStagingRoot, `${storageKey}.plan.ndjson`),
      `${JSON.stringify(targetRecord)}\n`
    )
    await fs.writeFile(
      path.join(backupStagingRoot, `${storageKey}.rollback.ndjson`),
      `${JSON.stringify(originalRecord)}\n`
    )
    const originalStat = await fs.lstat(path.join(oldRoot, 'before.txt'), { bigint: true })
    const identifyRecord = (record: unknown) => {
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
      return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    await fs.writeFile(
      path.join(backupStagingRoot, `${storageKey}.restore-journal.json`),
      `${JSON.stringify({
        contract: 'batshit-backup-restore-journal/v2',
        stageId,
        userId: 'target',
        phase: 'redis-replacing',
        hadOriginalUploads: true,
        originalUploadEntries: [{ name: 'before.txt', device: String(originalStat.dev), inode: String(originalStat.ino) }],
        redisRecoveryFiles: { plan: identifyRecord(targetRecord), rollback: identifyRecord(originalRecord) },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })}\n`
    )

    const recipeEpoch = captureRecipeVerificationEpoch()
    await ensureBackupRestoreRecovery()
    expect(isRecipeVerificationEpochCurrent(recipeEpoch)).toBe(false)
    expect(captureRecipeVerificationEpoch()).not.toBeNull()

    await expect(redis.json.get(originalRecord.key)).resolves.toMatchObject({
      displayName: 'Before Restore'
    })
    await expect(fs.readFile(path.join(uploadRoot, 'before.txt'), 'utf8')).resolves.toBe(
      'before restore'
    )
    await expect(fs.stat(path.join(uploadRoot, 'after.txt'))).rejects.toThrow()
    await expect(
      fs.stat(path.join(backupStagingRoot, `${storageKey}.restore-journal.json`))
    ).rejects.toThrow()
  })

  it.each(['redis-complete', 'rollback-complete'] as const)('retains journal and barrier when %s cleanup fails', async (phase) => {
    const stageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const storageKey = createHash('sha256').update(stageId).digest('hex')
    const journalPath = path.join(backupStagingRoot, `${storageKey}.restore-journal.json`)
    const rollbackPath = path.join(backupStagingRoot, `${storageKey}.rollback.ndjson`)
    await fs.writeFile(journalPath, JSON.stringify({
      contract: 'batshit-backup-restore-journal/v1', stageId, userId: 'target',
      phase, hadOriginalUploads: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }))
    await fs.writeFile(path.join(uploadRoot, 'settled.txt'), 'settled files must survive cleanup retry')
    const originalRm = fs.rm.bind(fs)
    const remove = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === rollbackPath) throw new Error('injected cleanup failure')
      return originalRm(target, options)
    })
    try {
      await expect(ensureBackupRestoreRecovery()).rejects.toThrow('injected cleanup failure')
      expect(await fs.readFile(journalPath, 'utf8')).toContain(phase)
      expect(await fs.readFile(path.join(backupStagingRoot, 'goon-asset-restore.json'), 'utf8')).toContain('goon-asset-restore/v1')
      expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['begin'])
    } finally {
      remove.mockRestore()
    }
    await ensureBackupRestoreRecovery()
    await expect(fs.stat(journalPath)).rejects.toThrow()
    expect(await fs.readFile(path.join(uploadRoot, 'settled.txt'), 'utf8')).toBe('settled files must survive cleanup retry')
    await expect(fs.stat(path.join(backupStagingRoot, 'goon-asset-restore.json'))).rejects.toThrow()
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['begin', 'begin', 'end'])
  })

  it('drains active HTTP work and blocks new requests during restore maintenance', async () => {
    const releaseRestoreRequest = enterBackupRestoreHttpRequest()
    const releaseOtherRequest = enterBackupRestoreHttpRequest()
    expect(releaseRestoreRequest).toBeTypeOf('function')
    expect(releaseOtherRequest).toBeTypeOf('function')

    let maintenanceStarted = false
    const maintenancePromise = beginBackupRestoreMaintenance().then((endMaintenance) => {
      maintenanceStarted = true
      return endMaintenance
    })
    await Promise.resolve()
    expect(maintenanceStarted).toBe(false)
    expect(enterBackupRestoreHttpRequest()).toBeNull()

    releaseOtherRequest?.()
    const endMaintenance = await maintenancePromise
    expect(maintenanceStarted).toBe(true)
    expect(enterBackupRestoreHttpRequest()).toBeNull()

    endMaintenance()
    const releaseAfterMaintenance = enterBackupRestoreHttpRequest()
    expect(releaseAfterMaintenance).toBeTypeOf('function')
    releaseAfterMaintenance?.()
    releaseRestoreRequest?.()
  })

  it('never waits for a chat’s line that holds for an approval card: its sends are kept like a shutdown’s (BL-713)', async () => {
    __resetStreamAbortRegistryForTests()
    const chat = 'bl713-restore-chat'
    const reply = registerSessionTurn(chat, 'single', 'msg-card')
    if (!reply.ok) throw new Error('expected the reply to register')
    // A send waiting in the line holds the restore gate for its request (respond-async).
    const releaseWaitingSend = enterBackupRestoreHttpRequest()
    const waiting = queueSessionTurn(chat, { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    // Its request: a kept send moves its words and lets go at once; a send that runs holds the gate.
    void waiting.outcome.then((handover) => {
      if (handover.kind !== 'keep') return
      releaseSessionTurn(chat, handover.entry.turnId)
      releaseWaitingSend?.()
    })
    // The reply stops at a card: the line holds for the user's answer.
    releaseSessionTurn(chat, reply.entry.turnId, { approvalCardMessageId: 'msg-card' })

    const endMaintenance = await beginBackupRestoreMaintenance()
    expect(await waiting.outcome).toMatchObject({ kind: 'keep', reason: 'shutdown' })
    endMaintenance()
    __resetStreamAbortRegistryForTests()
  }, 10_000)

  it('keeps a line whose hold forms while the restore drains (BL-713 review)', async () => {
    __resetStreamAbortRegistryForTests()
    const chat = 'bl713-restore-drain-chat'
    // The restore's own request, the reply's request, and the waiting send's request all hold the gate.
    const releaseRestoreRequest = enterBackupRestoreHttpRequest()
    const reply = registerSessionTurn(chat, 'single', 'msg-card')
    if (!reply.ok) throw new Error('expected the reply to register')
    const releaseReplyRequest = enterBackupRestoreHttpRequest()
    const releaseWaitingSend = enterBackupRestoreHttpRequest()
    const waiting = queueSessionTurn(chat, { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    void waiting.outcome.then((handover) => {
      if (handover.kind !== 'keep') return
      releaseSessionTurn(chat, handover.entry.turnId)
      releaseWaitingSend?.()
    })

    const maintenance = beginBackupRestoreMaintenance()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Only now does the reply stop at a card and let go: the hold forms during the drain.
    releaseSessionTurn(chat, reply.entry.turnId, { approvalCardMessageId: 'msg-card' })
    releaseReplyRequest?.()

    const endMaintenance = await maintenance
    expect(await waiting.outcome).toMatchObject({ kind: 'keep', reason: 'shutdown' })
    endMaintenance()
    releaseRestoreRequest?.()
    __resetStreamAbortRegistryForTests()
  }, 10_000)

  it('keeps user-owned seeded agents and models restorable', async () => {
    const sourceUserId = 'seed-user'
    await redis.sAdd(`user:${sourceUserId}:agents`, 'seed_api_primary')
    await redis.json.set('agent:seed_api_primary', '$', {
      id: 'seed_api_primary',
      user_id: sourceUserId,
      name: 'Seed API Primary'
    })
    await redis.sAdd(`user:${sourceUserId}:models`, 'seed_openai_direct')
    await redis.json.set('model:seed_openai_direct', '$', {
      id: 'seed_openai_direct',
      modelName: 'Seed OpenAI Direct',
      provider: 'openai',
      settings: {}
    })

    const bundle = await createBackupBundle(sourceUserId)
    const entries = unzipSync(bundle.bytes)
    const recordEntryNames = Object.keys(entries)
      .filter((name) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right))
    const exportedKeys = new Set(
      recordEntryNames.map((name) => JSON.parse(Buffer.from(entries[name]).toString('utf8')).key)
    )

    expect(exportedKeys).toContain(`user:${sourceUserId}:agents`)
    expect(exportedKeys).toContain('agent:seed_api_primary')
    expect(exportedKeys).toContain(`user:${sourceUserId}:models`)
    expect(exportedKeys).toContain('model:seed_openai_direct')

    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    expect(result.restored).toBe(true)
    await expect(redis.sMembers('user:target:agents')).resolves.toEqual(['seed_api_primary'])
    await expect(redis.sMembers('user:target:models')).resolves.toEqual(['seed_openai_direct'])

    const restoredAgent = (await redis.json.get('agent:seed_api_primary')) as Record<string, any>
    expect(restoredAgent.user_id).toBe('target')
  })

  it('backs up and remaps the Hair Asset library index, immutable metadata, and owned files', async () => {
    const relativePath = 'goon_hair_assets/imported-hair.glb'
    const refitRelativePath = 'goon_hair_assets/imported-hair-refit-source.glb'
    const sourcePath = path.join(uploadRoot, relativePath)
    const refitSourcePath = path.join(uploadRoot, refitRelativePath)
    await fs.mkdir(path.dirname(sourcePath), { recursive: true })
    await fs.writeFile(sourcePath, 'immutable-hair-bytes')
    await fs.writeFile(refitSourcePath, 'reusable-refit-bytes')
    await redis.sAdd('user:source:hair_assets', 'imported-style@imported-style-r1')
    await redis.json.set('hair_asset:source:imported-style:imported-style-r1', '$', {
      schemaVersion: 'hair-assets/v1',
      assetId: 'imported-style',
      revisionId: 'imported-style-r1',
      revisionSha256: 'a'.repeat(64),
      geometry: {
        main: {
          ref: '/uploads/goon_hair_assets/imported-hair.glb',
          sha256: 'b'.repeat(64),
          bytes: 20,
          mimeType: 'model/gltf-binary'
        }
      }
    })
    await redis.json.set('hair_refit_source:source:imported-style:imported-style-r1', '$', {
      contract: 'hair-refit-source/v1',
      assetId: 'imported-style',
      revisionId: 'imported-style-r1',
      source: {
        ref: '/uploads/goon_hair_assets/imported-hair-refit-source.glb',
        sha256: 'c'.repeat(64),
        bytes: 20,
        mimeType: 'model/gltf-binary'
      },
      startingTransform: {
        move: { x: 0, y: 0, z: 0 },
        rotate: { x: 0, y: 0, z: 0 },
        uniformScale: 1,
        axisScale: { x: 1, y: 1, z: 1 }
      },
      savedTransform: {
        move: { x: 0, y: 17, z: 0 },
        rotate: { x: 0, y: -90, z: 0 },
        uniformScale: 0.27,
        axisScale: { x: 1.15, y: 1.15, z: 1.01 }
      }
    })
    await redis.json.set('upload:goon_hair_assets:imported-hair.glb', '$', {
      originalName: 'imported-hair.glb',
      filename: 'imported-hair.glb',
      mimetype: 'model/gltf-binary',
      size: 20,
      uploadType: 'goon_hair_assets',
      storage: 'filesystem',
      relativePath,
      filePath: sourcePath,
      sha256: 'b'.repeat(64),
      uploadedAt: '2026-08-08T00:00:00.000Z'
    })
    await redis.json.set('upload:goon_hair_assets:imported-hair-refit-source.glb', '$', {
      originalName: 'imported-hair-refit-source.glb',
      filename: 'imported-hair-refit-source.glb',
      mimetype: 'model/gltf-binary',
      size: 20,
      uploadType: 'goon_hair_assets',
      storage: 'filesystem',
      relativePath: refitRelativePath,
      filePath: refitSourcePath,
      sha256: 'c'.repeat(64),
      uploadedAt: '2026-08-08T00:00:00.000Z'
    })

    const bundle = await createBackupBundle('source')
    const preflight = await preflightBackupRestore('target', bundle.bytes)
    expect(preflight.ok).toBe(true)
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    await expect(redis.sMembers('user:target:hair_assets')).resolves.toEqual([
      'imported-style@imported-style-r1'
    ])
    await expect(
      redis.json.get('hair_asset:target:imported-style:imported-style-r1')
    ).resolves.toMatchObject({
      schemaVersion: 'hair-assets/v1',
      assetId: 'imported-style',
      revisionId: 'imported-style-r1'
    })
    await expect(
      redis.json.get('hair_refit_source:target:imported-style:imported-style-r1')
    ).resolves.toMatchObject({
      contract: 'hair-refit-source/v1',
      assetId: 'imported-style',
      revisionId: 'imported-style-r1'
    })
    await expect(fs.readFile(sourcePath, 'utf8')).resolves.toBe('immutable-hair-bytes')
    await expect(fs.readFile(refitSourcePath, 'utf8')).resolves.toBe('reusable-refit-bytes')
  })

  it('backs up and remaps the supported durable Recipe graph', async () => {
    const sha = (value: string) => value.repeat(64)
    const source = {
      package: { ref: '/uploads/goon_custom_packages/source.bgoon', sha256: sha('1') },
      model: { ref: '/uploads/goon_custom_models/source.glb', sha256: sha('2') },
      manifest: { ref: '/uploads/goon_custom_manifests/source.json', sha256: sha('3') },
      identities: {
        contract: RECIPE_SOURCE_CONTRACT,
        schemaVersion: 1 as const,
        baseId: 'base-1',
        fitFamily: 'fit-1',
        modelSha256: sha('2'),
        manifestSemanticSha256: sha('4'),
        definitionSha256: sha('5'),
        neutralId: 'neutral-1',
        neutralRecipeSha256: sha('6'),
        physicalBasisSha256: sha('7'),
        behaviorSha256: sha('8'),
        componentGraphSha256: sha('9'),
        topologySha256: sha('a'),
        skeletonHierarchySha256: sha('b')
      }
    }
    const previewState = {
      schemaVersion: 'backup-preview-state/v1',
      definitionSha256: sha('5'),
      displayUrl: 'http://localhost:5606/uploads/goons/recipe-preview.png'
    }
    const state = {
      contract: GOON_RECIPE_STATE_CONTRACT,
      stateSha256: sha('0'),
      appearanceDials: {
        contract: 'appearance-dial-values/v2' as const,
        definitionSha256: sha('5'),
        neutralId: 'neutral-1',
        neutralRecipeSha256: sha('6'),
        values: { body_height: 0 },
        unlockedDialIds: []
      },
      siblings: [{
        id: 'backupPreview',
        contract: previewState.schemaVersion,
        definitionSha256: sha('5'),
        stateSha256: await recipeSiblingStateSha256(previewState),
        state: previewState
      }]
    }
    state.stateSha256 = await recipeStateSnapshotSha256(state)
    const receiptDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'goon_recipe',
      content: { contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT }
    })
    const liveDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'goon_recipe',
      content: await createBackupRecipeLiveBuildReceipt()
    })
    const plan = await createRecipeMigrationPlan({
      contract: RECIPE_MIGRATION_PLAN_CONTRACT,
      schemaVersion: 1,
      planId: 'migration.backup-restore-fixture',
      directEdgeKey: 'recipe.backup.v1-to-v2',
      edgeSha256: sha('c'),
      fromSource: source,
      toSource: source,
      fromRecipeRevision: 1,
      toRecipeRevision: 2,
      fromStateSha256: state.stateSha256,
      toleranceProfile: 'recipe-strict/v1',
      componentMapBundleSha256: null,
      outcome: {
        kind: 'unsupported',
        readiness: 'blocked',
        preservationClaim: 'none',
        rejectionCodes: ['COMPONENT_PROOF_FAILED'],
        cleanResetEligibility: 'eligible',
        basedOnUnsupportedPlanSha256: null
      },
      controlRows: [],
      siblingRows: [
        'eyeAppearance',
        'facialArtwork',
        'oralAppearance'
      ].map((surface) => ({
        surface: surface as 'eyeAppearance' | 'facialArtwork' | 'oralAppearance',
        sourceState: null,
        targetDefinition: null,
        action: 'not-present' as const,
        resolution: 'not-present' as const,
        proposedState: null,
        proofStatus: 'not-required' as const,
        proofSha256: sha('d'),
        reasonCode: 'SIBLING_NOT_PRESENT' as const,
        message: 'This sibling surface is not present.',
        requiresPreview: false,
        requiresConfirmation: false
      })),
      componentProofs: [],
      wholeRecipeProof: {
        status: 'failed',
        sourcePhysicalOutputSha256: sha('e'),
        targetPhysicalOutputSha256: null,
        sourceAbsoluteOutputSha256: null,
        targetAbsoluteOutputSha256: null,
        sourceMaterialSha256: sha('f'),
        targetMaterialSha256: sha('0'),
        materialMatches: false,
        errors: {
          scalarMaximum: 0,
          positionMaximumMeters: 0,
          positionRmsMeters: 0,
          scaleMaximum: 0,
          quaternionMaximumRadians: 0,
          matrixMaximum: 0,
          bakedPositionMaximumMeters: 0,
          bakedPositionRmsMeters: 0
        },
        mismatchDomains: [],
        permitsAppearancePreservedClaim: false,
        proofSha256: sha('0')
      },
      warnings: [],
      proposedState: null
    })
    const planDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'goon_recipe',
      content: plan as unknown as Record<string, unknown>
    })
    const reportDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'goon_recipe',
      content: { contract: 'recipe-migration-report/v1' }
    })
    const reviewedStateDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'goon_recipe',
      content: await verifyRecipeReviewedState({
        contract: 'recipe-reviewed-state/v1',
        reviewId: 'review-backup-fixture',
        operation: 'package-update',
        analysisId: 'analysis-backup-fixture',
        planSha256: plan.planSha256,
        containmentReceiptSha256: receiptDocument.sha256,
        state,
        adjustedControlIds: [],
        confirmedControlIds: [],
        cleanResetConfirmed: false
      })
    })
    const receiptKey = `goon_recipe_document:source:goon_recipe:${receiptDocument.sha256}`
    const liveKey = `goon_recipe_document:source:goon_recipe:${liveDocument.sha256}`
    const planKey = `goon_recipe_document:source:goon_recipe:${planDocument.sha256}`
    const reportKey = `goon_recipe_document:source:goon_recipe:${reportDocument.sha256}`
    const reviewedStateKey =
      `goon_recipe_document:source:goon_recipe:${reviewedStateDocument.sha256}`
    const receiptRef = {
      contract: receiptDocument.documentContract,
      ref: receiptKey,
      sha256: receiptDocument.sha256
    }
    const liveRef = {
      contract: liveDocument.documentContract,
      ref: liveKey,
      sha256: liveDocument.sha256
    }
    const planRef = {
      contract: planDocument.documentContract,
      ref: planKey,
      sha256: planDocument.sha256
    }
    const reportRef = {
      contract: reportDocument.documentContract,
      ref: reportKey,
      sha256: reportDocument.sha256
    }
    const reviewedStateRef = {
      contract: reviewedStateDocument.documentContract,
      ref: reviewedStateKey,
      sha256: reviewedStateDocument.sha256
    }
    const revision = {
      contract: GOON_RECIPE_REVISION_CONTRACT,
      recipeRevision: 1,
      revisionId: 'revision-1',
      revisionSha256: sha('0'),
      source,
      state,
      liveBuildReceipt: liveRef,
      updateReport: null
    }
    revision.revisionSha256 = await recipeRevisionBundleSha256(revision)
    const envelope = await createRecipeRevisionEnvelope({
      contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      revision,
      sourceContainmentReceipt: receiptRef,
      live: {
        package: { ref: '/uploads/goon_custom_packages/live.bgoon', sha256: sha('c'), bytes: 30 },
        model: { ref: '/uploads/goon_custom_models/live.glb', sha256: sha('d'), bytes: 20 },
        manifest: { ref: '/uploads/goon_custom_manifests/live.json', sha256: sha('e'), bytes: 10 }
      }
    })
    const revisionKey = 'goon_recipe_revision:source:goon_recipe:revision-1'
    const revisionRef = {
      contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      ref: revisionKey,
      sha256: envelope.envelopeSha256
    }
    const jobKey = 'goon_recipe_job:source:goon_recipe:job-1'
    const authoringRevision = {
      contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
      recipeRevision: 1,
      revisionId: 'revision-1',
      revisionSha256: sha('0'),
      source,
      state,
      updateReport: null
    }
    authoringRevision.revisionSha256 = await recipeAuthoringRevisionSha256(authoringRevision)
    const sourceRevisionIdentity = recipeRevisionIdentity(revision)

    await redis.sAdd('user:source:goons', 'goon_recipe')
    await redis.json.set('goon:goon_recipe', '$', {
      id: 'goon_recipe',
      user_id: 'source',
      name: 'Recipe Fixture',
      files: {},
      recipe: {
        contract: GOON_RECIPE_OWNER_V2_CONTRACT,
        writeVersion: 4,
        nextRecipeRevision: 2,
        liveStatus: 'building',
        authoringRevision,
        authoringSourceContainmentReceipt: receiptRef,
        activeRevision: revisionRef,
        previousRevision: null,
        pendingAnalysis: null,
        pendingJob: {
          jobId: 'job-1',
          jobRef: jobKey,
          status: 'baking',
          operation: 'package-update',
          targetWriteVersion: 4,
          targetRecipeRevision: 2,
          targetRevisionId: 'revision-2'
        },
        latestUpdateReport: null,
        lastFailure: null,
        maintenanceFailure: null
      },
      recipeFitReceipts: [{
        contract: GOON_RECIPE_FIT_RECEIPT_CONTRACT,
        receiptId: 'fit-hair-1',
        surface: 'hair',
        assetId: 'hair-1',
        fitSha256: sha('f'),
        boundRevision: sourceRevisionIdentity,
        evaluatedRevision: sourceRevisionIdentity,
        status: 'current',
        staleReason: null
      }],
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })
    await redis.json.set(revisionKey, '$', envelope)
    await redis.json.set(receiptKey, '$', receiptDocument)
    await redis.json.set(liveKey, '$', liveDocument)
    await redis.json.set(planKey, '$', planDocument)
    await redis.json.set(reportKey, '$', reportDocument)
    await redis.json.set(reviewedStateKey, '$', reviewedStateDocument)
    await redis.json.set(jobKey, '$', {
      contract: GOON_RECIPE_JOB_CONTRACT,
      userId: 'source',
      goonId: 'goon_recipe',
      jobId: 'job-1',
      idempotencyKey: 'update-1',
      operation: 'package-update',
      status: 'baking',
      stateVersion: 1,
      attempt: 1,
      targetWriteVersion: 4,
      targetRecipeRevision: 2,
      targetRevisionId: 'revision-2',
      sourceRevision: revisionRef,
      stagedSource: {
        source,
        containmentReceipt: receiptRef
      },
      plan: planRef,
      migrationReport: reportRef,
      reviewedState: reviewedStateRef,
      stagedLive: null,
      candidateRevision: null,
      lease: { ownerId: 'worker-1', expiresAt: '2026-07-17T00:05:00.000Z' },
      failure: null,
      cleanupAssets: [],
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z'
    })

    const bundle = await createBackupBundle('source')
    const entries = unzipSync(bundle.bytes)
    const exportedRecords = Object.entries(entries)
      .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, any>)
    expect(exportedRecords.map((record) => record.key)).toEqual(
      expect.arrayContaining([revisionKey, receiptKey, jobKey])
    )

    const editBundleRecords = (
      bytes: Uint8Array,
      edit: (records: Record<string, any>[]) => void
    ) => {
      const editedEntries = unzipSync(bytes)
      const records = Object.entries(editedEntries)
        .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
        .map(([name, value]) => {
          delete editedEntries[name]
          return JSON.parse(Buffer.from(value).toString('utf8')) as Record<string, any>
        })
      edit(records)
      records.forEach((record, index) => {
        editedEntries[`redis/records/${String(index + 1).padStart(8, '0')}.json`] =
          Buffer.from(JSON.stringify(record))
      })
      const manifest = JSON.parse(Buffer.from(editedEntries['manifest.json']).toString('utf8'))
      manifest.contents.redisRecordCount = records.length
      editedEntries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
      return zipSync(editedEntries)
    }
    const unsupportedProjection = editBundleRecords(bundle.bytes, records => {
      records.find(record => record.key === revisionKey)!.value.localReviewEyeStateProjection = {
        contract: 'recipe-local-review-eye-state-projection/v1'
      }
    })
    const protectedTarget = { id: 'target', marker: 'preserve-before-refusal' }
    await redis.json.set('user:target', '$', protectedTarget)
    await expect(preflightBackupRestore('target', unsupportedProjection)).rejects.toThrow(/revision envelope/i)
    await expect(restoreBackupBundle('target', unsupportedProjection, { confirmReplace: true })).rejects.toThrow(/revision envelope/i)
    expect(await redis.json.get('user:target')).toEqual(protectedTarget)
    for (const held of [
      { anatomyPresence: null }, { clothingState: null }, { clothingCloset: null }, { sphericalEyelid: null },
      { closet: { clothingPresets: {} } }, { requiredMotionPreparation: {} }
    ]) {
      const unsupportedGoon = editBundleRecords(bundle.bytes, records => {
        const value = records.find(record => record.key === 'goon:goon_recipe')!.value
        if (Object.hasOwn(held, 'requiredMotionPreparation')) Object.assign(value.recipe, held)
        else Object.assign(value, held)
      })
      await expect(preflightBackupRestore('target', unsupportedGoon)).rejects.toThrow(/fields this release does not support/i)
      await expect(restoreBackupBundle('target', unsupportedGoon, { confirmReplace: true })).rejects.toThrow(/fields this release does not support/i)
      expect(await redis.json.get('user:target')).toEqual(protectedTarget)
    }

    for (const [field, documentKey] of [
      ['reviewedState', reviewedStateKey],
      ['migrationReport', reportKey]
    ] as const) {
      const missingDocument = editBundleRecords(bundle.bytes, records => {
        records.splice(records.findIndex(record => record.key === documentKey), 1)
      })
      await expect(preflightBackupRestore('target', missingDocument)).rejects.toThrow(
        /references missing JSON record/
      )
      const wrongHash = editBundleRecords(bundle.bytes, records => {
        records.find(record => record.key === jobKey)!.value[field].sha256 = sha('0')
      })
      await expect(preflightBackupRestore('target', wrongHash)).rejects.toThrow(
        /document contract, and hash/
      )
    }
    // A valid outer content hash must not authorize repairing corrupt source
    // state during target URL normalization.
    for (const staleHash of ['sibling', 'snapshot'] as const) {
      const content = structuredClone(reviewedStateDocument.content) as Record<string, any>
      if (staleHash === 'sibling') content.state.siblings[0].stateSha256 = sha('0')
      else content.state.stateSha256 = sha('0')
      const corruptDocument = await createGoonRecipeDocument({
        userId: 'source', goonId: 'goon_recipe', content
      })
      const corruptKey = `goon_recipe_document:source:goon_recipe:${corruptDocument.sha256}`
      const corruptBundle = editBundleRecords(bundle.bytes, records => {
        const document = records.find(record => record.key === reviewedStateKey)!
        document.key = corruptKey
        document.value = corruptDocument
        records.find(record => record.key === jobKey)!.value.reviewedState = {
          contract: corruptDocument.documentContract, ref: corruptKey, sha256: corruptDocument.sha256
        }
      })
      await expect(preflightBackupRestore('target', corruptBundle)).rejects.toThrow(
        /state hash mismatch|sibling .* hash mismatch/
      )
    }

    const analysisDocument = await createGoonRecipeDocument({
      userId: 'source', goonId: 'goon_recipe',
      content: {
        contract: 'recipe-update-analysis-context/v3',
        analysisId: 'analysis-backup-fixture',
        sourceRevision: revisionRef,
        containmentReceipt: receiptRef,
        basePlan: planRef,
        siblingInputs: Object.fromEntries(['eyeAppearance', 'facialArtwork', 'oralAppearance'].map(id => [
          id, { sourceStateId: null, targetStateId: null, targetDefinition: null, message: null }
        ])),
        externalSiblingInputs: [],
        componentMapBundle: null
      }
    })
    const analysisKey = `goon_recipe_document:source:goon_recipe:${analysisDocument.sha256}`
    // This source-validation check does not claim that a restored migration
    // analysis can resume: its source-state/proof bindings need separate coverage.
    const missingPendingReview = editBundleRecords(bundle.bytes, records => {
      records.splice(records.findIndex(record => record.key === jobKey), 1)
      records.splice(records.findIndex(record => record.key === reviewedStateKey), 1)
      records.push({
        ...records.find(record => record.key === planKey)!,
        key: analysisKey, value: analysisDocument
      })
      const owner = records.find(record => record.key === 'goon:goon_recipe')!.value.recipe
      owner.liveStatus = 'up_to_date'
      owner.pendingJob = null
      owner.pendingAnalysis = {
        analysisId: 'analysis-backup-fixture',
        analysisRef: { contract: analysisDocument.documentContract, ref: analysisKey, sha256: analysisDocument.sha256 },
        basePlan: planRef, selectedPlan: planRef, migrationReport: reportRef,
        containmentReceipt: receiptRef, reviewedState: reviewedStateRef, targetWriteVersion: owner.writeVersion
      }
    })
    await expect(preflightBackupRestore('target', missingPendingReview)).rejects.toThrow(
      /pending analysis reviewedState references missing JSON record/
    )

    const tamperedEntries = { ...entries }
    const revisionEntry = Object.entries(tamperedEntries).find(([, bytes]) => {
      try {
        return JSON.parse(Buffer.from(bytes).toString('utf8')).key === revisionKey
      } catch {
        return false
      }
    })
    expect(revisionEntry).toBeDefined()
    const tamperedRevisionRecord = JSON.parse(
      Buffer.from(revisionEntry![1]).toString('utf8')
    ) as Record<string, any>
    tamperedRevisionRecord.value.live.model.bytes += 1
    tamperedEntries[revisionEntry![0]] = Buffer.from(JSON.stringify(tamperedRevisionRecord))
    await expect(preflightBackupRestore('target', zipSync(tamperedEntries))).rejects.toBeInstanceOf(
      BackupRestoreError
    )

    const otherReceiptDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'other_recipe',
      content: receiptDocument.content
    })
    const otherLiveDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'other_recipe',
      content: liveDocument.content
    })
    const otherReceiptKey = `goon_recipe_document:source:other_recipe:${otherReceiptDocument.sha256}`
    const otherLiveKey = `goon_recipe_document:source:other_recipe:${otherLiveDocument.sha256}`
    const otherRevision = {
      ...revision,
      revisionId: 'other-revision-1',
      revisionSha256: sha('0'),
      liveBuildReceipt: {
        contract: otherLiveDocument.documentContract,
        ref: otherLiveKey,
        sha256: otherLiveDocument.sha256
      }
    }
    otherRevision.revisionSha256 = await recipeRevisionBundleSha256(otherRevision)
    const otherEnvelope = await createRecipeRevisionEnvelope({
      contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      revision: otherRevision,
      sourceContainmentReceipt: {
        contract: otherReceiptDocument.documentContract,
        ref: otherReceiptKey,
        sha256: otherReceiptDocument.sha256
      },
      live: envelope.live
    })
    const otherRevisionKey =
      'goon_recipe_revision:source:other_recipe:other-revision-1'
    const otherRevisionRef = {
      contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      ref: otherRevisionKey,
      sha256: otherEnvelope.envelopeSha256
    }
    const otherAuthoring = {
      contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
      recipeRevision: 1,
      revisionId: otherRevision.revisionId,
      revisionSha256: sha('0'),
      source,
      state,
      updateReport: null
    }
    otherAuthoring.revisionSha256 = await recipeAuthoringRevisionSha256(otherAuthoring)
    await redis.sAdd('user:source:goons', 'other_recipe')
    await redis.json.set(otherReceiptKey, '$', otherReceiptDocument)
    await redis.json.set(otherLiveKey, '$', otherLiveDocument)
    await redis.json.set(otherRevisionKey, '$', otherEnvelope)
    await redis.json.set('goon:other_recipe', '$', {
      id: 'other_recipe',
      user_id: 'source',
      name: 'Other Recipe Fixture',
      files: {},
      recipe: {
        contract: GOON_RECIPE_OWNER_V2_CONTRACT,
        writeVersion: 1,
        nextRecipeRevision: 2,
        liveStatus: 'up_to_date',
        authoringRevision: otherAuthoring,
        authoringSourceContainmentReceipt: {
          contract: otherReceiptDocument.documentContract,
          ref: otherReceiptKey,
          sha256: otherReceiptDocument.sha256
        },
        activeRevision: otherRevisionRef,
        previousRevision: null,
        pendingAnalysis: null,
        pendingJob: null,
        latestUpdateReport: null,
        lastFailure: null,
        maintenanceFailure: null
      },
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })
    for (const [field, document] of [
      ['reviewedState', reviewedStateDocument],
      ['migrationReport', reportDocument]
    ] as const) {
      const otherDocument = await createGoonRecipeDocument({
        userId: 'source', goonId: 'other_recipe', content: document.content
      })
      const otherKey = `goon_recipe_document:source:other_recipe:${otherDocument.sha256}`
      await redis.json.set(otherKey, '$', otherDocument)
      const otherBundle = await createBackupBundle('source')
      const crossLinkedDocument = editBundleRecords(otherBundle.bytes, records => {
        records.find(record => record.key === jobKey)!.value[field] = {
          contract: otherDocument.documentContract, ref: otherKey, sha256: otherDocument.sha256
        }
      })
      await expect(preflightBackupRestore('target', crossLinkedDocument)).rejects.toThrow(
        /Goon namespace/
      )
    }
    const crossLinkedGoon = (await redis.json.get('goon:goon_recipe')) as Record<string, any>
    crossLinkedGoon.recipe.activeRevision = otherRevisionRef
    await redis.json.set('goon:goon_recipe', '$', crossLinkedGoon)
    const crossLinkedBundle = await createBackupBundle('source')
    await expect(preflightBackupRestore('target', crossLinkedBundle.bytes)).rejects.toThrow(
      /Goon namespace/
    )

    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    const targetRevisionKey = revisionKey.replace(':source:', ':target:')
    const targetReceiptKey = receiptKey.replace(':source:', ':target:')
    const targetJobKey = jobKey.replace(':source:', ':target:')
    const restoredGoon = (await redis.json.get('goon:goon_recipe')) as Record<string, any>
    expect(restoredGoon.user_id).toBe('target')
    expect(restoredGoon.recipe.activeRevision.ref).toBe(targetRevisionKey)
    expect(restoredGoon.recipe.activeRevision.sha256).not.toBe(envelope.envelopeSha256)
    expect(restoredGoon.recipe.pendingJob.jobRef).toBe(targetJobKey)
    expect(restoredGoon.recipe.authoringRevision.state.siblings[0]).toMatchObject({
      stateSha256: await recipeSiblingStateSha256({
        ...previewState,
        displayUrl: '/uploads/goons/recipe-preview.png'
      }),
      state: {
        displayUrl: '/uploads/goons/recipe-preview.png'
      }
    })

    const restoredRevision = (await redis.json.get(targetRevisionKey)) as Record<string, any>
    expect(restoredRevision.sourceContainmentReceipt.ref).toBe(targetReceiptKey)
    expect(restoredRevision.envelopeSha256).toBe(restoredGoon.recipe.activeRevision.sha256)
    expect(restoredGoon.recipeFitReceipts[0]).toMatchObject({
      boundRevision: {
        recipeRevision: restoredRevision.revision.recipeRevision,
        revisionId: restoredRevision.revision.revisionId,
        revisionSha256: restoredRevision.revision.revisionSha256,
        stateSha256: restoredRevision.revision.state.stateSha256
      },
      evaluatedRevision: {
        revisionSha256: restoredRevision.revision.revisionSha256
      },
      status: 'current',
      staleReason: null
    })

    const restoredJob = (await redis.json.get(targetJobKey)) as Record<string, any>
    expect(restoredJob.userId).toBe('target')
    expect(restoredJob.sourceRevision.ref).toBe(targetRevisionKey)
    expect(restoredJob.stagedSource.containmentReceipt.ref).toBe(targetReceiptKey)
    const restoredReviewedDocument = await verifyGoonRecipeDocument(
      await redis.json.get(restoredJob.reviewedState.ref)
    )
    const restoredReview = await verifyRecipeReviewedState(restoredReviewedDocument.content)
    expect(restoredJob.reviewedState).toEqual({
      contract: restoredReviewedDocument.documentContract,
      ref: `goon_recipe_document:target:goon_recipe:${restoredReviewedDocument.sha256}`,
      sha256: restoredReviewedDocument.sha256
    })
    expect(restoredReviewedDocument.sha256).not.toBe(reviewedStateDocument.sha256)
    expect(restoredReview.state.stateSha256).not.toBe(state.stateSha256)
    expect(restoredReview.state.siblings[0].stateSha256).not.toBe(state.siblings[0].stateSha256)
    expect(restoredReview.state.siblings[0].state).toMatchObject({
      displayUrl: '/uploads/goons/recipe-preview.png'
    })
    expect(restoredReview.state).toEqual(restoredGoon.recipe.authoringRevision.state)
    expect(await redis.json.get(reviewedStateKey.replace(':source:', ':target:'))).toBeNull()
    expect(restoredJob.migrationReport).toEqual({ ...reportRef, ref: reportKey.replace(':source:', ':target:') })

    // A same-user restore can reproduce every owner/job field exactly. Record
    // equality must still not preserve process-local numerical verification.
    const sameUserBundle = await createBackupBundle('target')
    const admissionKey = JSON.stringify({ owner: restoredGoon.recipe, job: restoredJob })
    const admissionCache = createRecipeStageAdmissionCache()
    const recipeEpoch = captureRecipeVerificationEpoch()
    admissionCache.remember(admissionKey, 'a'.repeat(64), recipeEpoch)
    await restoreBackupBundle('target', sameUserBundle.bytes, { confirmReplace: true })
    const sameOwner = (await redis.json.get('goon:goon_recipe') as Record<string, any>).recipe
    const sameJob = await redis.json.get(targetJobKey)
    expect(sameOwner).toEqual(restoredGoon.recipe)
    expect(sameJob).toEqual(restoredJob)
    expect(admissionCache.take(JSON.stringify({ owner: sameOwner, job: sameJob }))).toBeNull()
    expect(isRecipeVerificationEpochCurrent(recipeEpoch)).toBe(false)
    expect(captureRecipeVerificationEpoch()).not.toBeNull()
  })

  it('rewrites imported project paths to the Docker workspace during containerized restore', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_CODEX_WORKDIR = '/workspace'

    await redis.json.set('project_prefs:source', '$', {
      user_id: 'source',
      default_workspace_path: '/Users/example/native-workspace'
    })
    await redis.json.set('project:source:project_native', '$', {
      id: 'project_native',
      user_id: 'source',
      name: 'Native Project',
      root_path: '/Users/example/native-workspace',
      full_path: '/Users/example/native-workspace',
      rules_json: {
        allowedRoots: [
          '/Users/example/native-workspace',
          '/Users/example/native-workspace/packages/app'
        ]
      }
    })

    const bundle = await createBackupBundle('source')
    const preflight = await preflightBackupRestore('target', bundle.bytes)

    expect(preflight.warnings.some((warning) => warning.includes('imported Project paths at /workspace'))).toBe(
      true
    )

    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    const prefs = (await redis.json.get('project_prefs:target')) as Record<string, any>
    expect(prefs.default_workspace_path).toBe('/workspace')

    const project = (await redis.json.get('project:target:project_native')) as Record<string, any>
    expect(project.user_id).toBe('target')
    expect(project.root_path).toBe('/workspace')
    expect(project.full_path).toBe('/workspace')
    expect(project.rules_json.allowedRoots).toEqual(['/workspace', '/workspace/packages/app'])
  })

  it('backs up local-mode upload records as filesystem assets', async () => {
    await fs.mkdir(path.join(uploadRoot, 'images'), { recursive: true })
    await fs.writeFile(path.join(uploadRoot, 'images', 'local-mode.png'), 'local-mode-bytes')
    await redis.sAdd('user:source:agents', 'agent_local_avatar')
    await redis.json.set('agent:agent_local_avatar', '$', {
      id: 'agent_local_avatar',
      user_id: 'source',
      displayName: 'Local Avatar Agent',
      avatar: 'http://localhost:5606/uploads/images/local-mode.png'
    })
    await redis.json.set('upload:images:local-mode.png', '$', {
      filename: 'local-mode.png',
      mimetype: 'image/png',
      size: 16,
      uploadType: 'images',
      relativePath: 'images/local-mode.png',
      filePath: '/source/uploads/images/local-mode.png',
      storageMode: 'local',
      uploadStrategy: 'local',
      url: 'http://localhost:5606/uploads/images/local-mode.png',
      displayUrl: 'http://localhost:5606/uploads/images/local-mode.png'
    })

    const bundle = await createBackupBundle('source')
    const entries = unzipSync(bundle.bytes)

    expect(Object.keys(entries)).toContain('files/uploads/images/local-mode.png')

    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(result.fileAssetCount).toBe(1)

    const uploadRecord = (await redis.json.get('upload:images:local-mode.png')) as Record<string, any>
    expect(uploadRecord.storage).toBe('filesystem')
    expect(uploadRecord.relativePath).toBe('images/local-mode.png')
    expect(uploadRecord.filePath).toBe(path.join(uploadRoot, 'images', 'local-mode.png'))
    expect(uploadRecord.url).toBe('/uploads/images/local-mode.png')
    expect(uploadRecord.displayUrl).toBe('/uploads/images/local-mode.png')

    const agentRecord = (await redis.json.get('agent:agent_local_avatar')) as Record<string, any>
    expect(agentRecord.user_id).toBe('target')
    expect(agentRecord.avatar).toBe('/uploads/images/local-mode.png')

    await expect(fs.readFile(path.join(uploadRoot, 'images', 'local-mode.png'), 'utf8')).resolves.toBe(
      'local-mode-bytes'
    )
  })

  it('rewrites nested Goon upload URLs during restore', async () => {
    const uploadedAssets = [
      ['goons/source-avatar.vrm', 'vrm-bytes', 'model/vrm'],
      ['goon_guided_packages/source-package.bgoon', 'package-bytes', 'application/zip'],
      ['goon_guided_manifests/source-avatar.json', '{"ok":true}', 'application/json'],
      ['goon-closet/source-shirt.png', 'shirt-bytes', 'image/png'],
      ['goon-scenes/source-preview.mp4', 'preview-bytes', 'video/mp4']
    ] as const

    for (const [relativePath, contents, mimetype] of uploadedAssets) {
      await fs.mkdir(path.join(uploadRoot, path.dirname(relativePath)), { recursive: true })
      await fs.writeFile(path.join(uploadRoot, relativePath), contents)
      const uploadType = path.posix.dirname(relativePath)
      const filename = path.posix.basename(relativePath)
      await redis.json.set(`upload:${uploadType}:${filename}`, '$', {
        filename,
        mimetype,
        size: Buffer.byteLength(contents),
        uploadType,
        relativePath,
        filePath: `/source/uploads/${relativePath}`,
        storageMode: 'local',
        uploadStrategy: 'local',
        url: `http://batshit-server:5600/uploads/${relativePath}`,
        displayUrl: `http://localhost:5606/uploads/${relativePath}`
      })
    }

    await redis.sAdd('user:source:goons', 'goon_nested_uploads')
    await redis.json.set('goon:goon_nested_uploads', '$', {
      id: 'goon_nested_uploads',
      user_id: 'source',
      name: 'Nested Uploads',
      kind: 'vrm',
      sourceProfile: 'guided-custom-vrm',
      files: {
        vrm: {
          url: 'http://batshit-server:5600/uploads/goons/source-avatar.vrm',
          filename: 'source-avatar.vrm'
        },
        animations: [
          {
            url: 'http://localhost:5606/uploads/goon-scenes/source-preview.mp4',
            filename: 'source-preview.mp4',
            previewVideo: {
              url: 'http://old-host.example/uploads/goon-scenes/source-preview.mp4',
              filename: 'source-preview.mp4'
            }
          }
        ]
      },
      guidedAvatar: {
        package: {
          url: 'http://localhost:5606/uploads/goon_guided_packages/source-package.bgoon',
          filename: 'source-package.bgoon'
        },
        manifest: {
          url: 'http://localhost:5606/uploads/goon_guided_manifests/source-avatar.json',
          filename: 'source-avatar.json'
        }
      },
      closet: {
        items: {
          shirt: {
            id: 'shirt',
            name: 'Shirt',
            category: 'tops',
            texture: {
              url: 'http://localhost:5606/uploads/goon-closet/source-shirt.png',
              filename: 'source-shirt.png'
            }
          }
        }
      },
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z'
    })

    const bundle = await createBackupBundle('source')
    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    const goonRecord = (await redis.json.get('goon:goon_nested_uploads')) as Record<string, any>
    expect(goonRecord.user_id).toBe('target')
    expect(goonRecord.files.vrm.url).toBe('/uploads/goons/source-avatar.vrm')
    expect(goonRecord.files.animations[0].url).toBe('/uploads/goon-scenes/source-preview.mp4')
    expect(goonRecord.files.animations[0].previewVideo.url).toBe(
      '/uploads/goon-scenes/source-preview.mp4'
    )
    expect(goonRecord.guidedAvatar.package.url).toBe(
      '/uploads/goon_guided_packages/source-package.bgoon'
    )
    expect(goonRecord.guidedAvatar.manifest.url).toBe(
      '/uploads/goon_guided_manifests/source-avatar.json'
    )
    expect(goonRecord.closet.items.shirt.texture.url).toBe('/uploads/goon-closet/source-shirt.png')
  })

  it('preflights legacy single-file Redis record bundles', async () => {
    await seedRepresentativeData('source')
    const bundle = await createBackupBundle('source')
    const entries = { ...unzipSync(bundle.bytes) }
    const recordEntryNames = Object.keys(entries)
      .filter((name) => name.startsWith('redis/records/') && name.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right))
    const records = recordEntryNames.map((name) =>
      JSON.parse(Buffer.from(entries[name]).toString('utf8'))
    )

    for (const name of recordEntryNames) {
      delete entries[name]
    }
    entries['redis/records.json'] = new Uint8Array(Buffer.from(JSON.stringify(records), 'utf8'))

    const legacyBytes = zipSync(entries)
    expect(Object.keys(unzipSync(legacyBytes))).toContain('redis/records.json')

    const preflight = await preflightBackupRestore('target', legacyBytes)

    expect(preflight.ok).toBe(true)
    expect(preflight.redisRecordCount).toBe(records.length)
  })

  describe('bug batch 2026-09-27 (BL-370, BL-371, BL-372)', () => {
    function exportedRecords(bytes: Uint8Array) {
      const entries = unzipSync(bytes)
      return Object.entries(entries)
        .filter(([name]) => name.startsWith('redis/records/') && name.endsWith('.json'))
        .map(([, entryBytes]) => JSON.parse(Buffer.from(entryBytes).toString('utf8'))) as Array<{
        key: string
        type: string
        value: any
        groupId: string
      }>
    }

    /** Rebuild an archive without some records, as a backup from an older Batshit would be. */
    function withoutRecords(bytes: Uint8Array, drop: (key: string) => boolean) {
      const entries = { ...unzipSync(bytes) }
      let removed = 0
      for (const name of Object.keys(entries)) {
        if (!name.startsWith('redis/records/') || !name.endsWith('.json')) continue
        const record = JSON.parse(Buffer.from(entries[name]).toString('utf8'))
        if (!drop(record.key)) continue
        delete entries[name]
        removed += 1
      }
      const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
      manifest.contents.redisRecordCount -= removed
      entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest), 'utf8'))
      return { bytes: zipSync(entries), removed }
    }

    it('carries the Motion Vault list in the `goons` group, restores it for the new user, and keeps its files referenced (BL-370)', async () => {
      await fs.mkdir(path.join(uploadRoot, 'goon_animations'), { recursive: true })
      await fs.writeFile(path.join(uploadRoot, 'goon_animations', 'wave.vrma'), 'vrma-bytes')
      await redis.json.set('upload:goon_animations:wave.vrma', '$', {
        filename: 'wave.vrma',
        mimetype: 'application/octet-stream',
        size: 10,
        uploadType: 'goon_animations',
        storage: 'filesystem',
        relativePath: 'goon_animations/wave.vrma',
        filePath: path.join(uploadRoot, 'goon_animations', 'wave.vrma')
      })
      await redis.json.set('user:source:goons_animation_library', '$', {
        vrma: [
          {
            url: 'http://localhost:5606/uploads/goon_animations/wave.vrma',
            filename: 'wave.vrma',
            displayName: 'Wave'
          }
        ]
      })

      const bundle = await createBackupBundle('source')
      const library = exportedRecords(bundle.bytes).find(
        (record) => record.key === 'user:source:goons_animation_library'
      )
      expect(library, 'the Motion Vault list is in the backup').toBeDefined()
      expect(library!.groupId).toBe('goons')

      await redis.del('user:source:goons_animation_library')
      await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

      const restored = (await redis.json.get('user:target:goons_animation_library')) as Record<string, any>
      expect(restored?.vrma?.[0]).toMatchObject({
        url: '/uploads/goon_animations/wave.vrma',
        filename: 'wave.vrma',
        displayName: 'Wave'
      })
      // Admin Goon Asset Cleanup finds Motion Vault files only through this key: without it
      // the restored animation would be offered for deletion as an orphan.
      const references = await redis.execute((client) =>
        collectGoonUploadReferencesForClient(client as any, 'target')
      )
      expect(hasGoonUploadReference(references, 'goon_animations', 'wave.vrma')).toBe(true)
    })

    describe("a custom provider's Extra Headers (BL-371)", () => {
      const SECRET_HEADER_VALUES = {
        Authorization: 'Bearer zcbackup-gateway-bearer',
        'cf-aig-authorization': 'Bearer zcbackup-cf-gateway',
        'Ocp-Apim-Subscription-Key': 'zcbackup-apim-key',
        'X-Custom-Tenant': 'zcbackup-tenant-value'
      }

      async function seedProviderWithHeaders(userId: string) {
        await redis.sAdd(`user:${userId}:custom_providers`, 'custom_gateway')
        await redis.json.set(`custom_provider:${userId}:custom_gateway`, '$', {
          id: 'custom_gateway',
          label: 'Gateway',
          baseUrl: 'https://gateway.example.com/v1',
          headers: {
            ...SECRET_HEADER_VALUES,
            'HTTP-Referer': 'https://batshit.ai',
            'X-Title': 'Batshit'
          },
          apiKeyEncrypted: 'encrypted-custom',
          apiKeyIv: 'iv-custom',
          apiKeyAuthTag: 'tag-custom',
          createdAt: '2026-09-27T00:00:00.000Z',
          updatedAt: '2026-09-27T00:00:00.000Z'
        })
      }

      it('leaves every header value out of a normal backup unless the header is on the reviewed allow-list', async () => {
        await seedProviderWithHeaders('source')

        const bundle = await createBackupBundle('source')
        const provider = exportedRecords(bundle.bytes).find(
          (record) => record.key === 'custom_provider:source:custom_gateway'
        )
        expect(provider!.value.headers).toEqual({
          Authorization: null,
          'cf-aig-authorization': null,
          'Ocp-Apim-Subscription-Key': null,
          'X-Custom-Tenant': null,
          'HTTP-Referer': 'https://batshit.ai',
          'X-Title': 'Batshit'
        })
        for (const name of Object.keys(SECRET_HEADER_VALUES)) {
          expect(bundle.manifest.secrets.redactedPaths).toContain(
            `custom_provider:source:custom_gateway.headers.${name}`
          )
        }
        // No entry anywhere in the archive carries a header value.
        const archiveText = Object.values(unzipSync(bundle.bytes))
          .map((entryBytes) => Buffer.from(entryBytes).toString('utf8'))
          .join('\n')
        for (const secret of Object.values(SECRET_HEADER_VALUES)) {
          expect(archiveText).not.toContain(secret)
        }
      })

      it('keeps the header values in a With Secrets backup', async () => {
        await seedProviderWithHeaders('source')

        const bundle = await createBackupBundle('source', { includeSecrets: true })
        const provider = exportedRecords(bundle.bytes).find(
          (record) => record.key === 'custom_provider:source:custom_gateway'
        )
        expect(provider!.value.headers).toMatchObject(SECRET_HEADER_VALUES)
      })

      it('names the headers to enter again in the restore summary, and restores their names with no value', async () => {
        await seedProviderWithHeaders('source')
        const bundle = await createBackupBundle('source')

        const preflight = await preflightBackupRestore('target', bundle.bytes)
        const warning = preflight.warnings.find((entry) => entry.includes('"Gateway"'))
        expect(warning).toBeDefined()
        for (const name of Object.keys(SECRET_HEADER_VALUES)) {
          expect(warning).toContain(name)
        }
        expect(warning).not.toContain('HTTP-Referer')

        await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
        const restored = (await redis.json.get('custom_provider:target:custom_gateway')) as Record<string, any>
        expect(restored.headers).toMatchObject({ Authorization: null, 'X-Title': 'Batshit' })
      })
    })

    describe('core prompt metadata (BL-372)', () => {
      let promptDefaultsDir: string

      async function writeDefaults(version: string, keep: string[] = []) {
        for (const definition of listCoreSystemPromptDefinitions()) {
          const text = keep.includes(definition.id)
            ? `${definition.id} default, unchanged across versions\n`
            : `${definition.id} default ${version}\n`
          await fs.writeFile(path.join(promptDefaultsDir, definition.defaultFile), text)
        }
      }

      beforeEach(async () => {
        promptDefaultsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-prompt-defaults-'))
        vi.stubEnv('BATSHIT_SYSTEM_PROMPTS_DIR', promptDefaultsDir)
      })

      afterEach(async () => {
        await fs.rm(promptDefaultsDir, { recursive: true, force: true })
      })

      function summaryOf(summaries: Awaited<ReturnType<typeof listCoreSystemPrompts>>, id: string) {
        return summaries.find((summary) => summary.id === id)!
      }

      it('carries the metadata beside each prompt, so an older default is refreshed after the restore', async () => {
        await writeDefaults('v1')
        await listCoreSystemPrompts()
        const bundle = await createBackupBundle('source')
        const meta = exportedRecords(bundle.bytes).find(
          (record) => record.key === 'batshit:system_prompt_meta:api_primary'
        )
        expect(meta, 'the prompt metadata is in the backup').toBeDefined()
        expect(meta!.groupId).toBe('prompts')

        // The app is updated: new defaults, and this instance refreshes to them.
        await writeDefaults('v2')
        await listCoreSystemPrompts()

        await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

        // Right away, not at the next start: agents compile from the stored text.
        expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe('api_primary default v2\n')
        const summary = summaryOf(await listCoreSystemPrompts(), 'api_primary')
        expect(summary).toMatchObject({ matchesDefault: true, customized: false, newDefaultAvailable: false })
      })

      it("keeps the user's own edit and says a new default is available", async () => {
        await writeDefaults('v1')
        await listCoreSystemPrompts()
        await saveCoreSystemPrompt('api_primary', 'my own API prompt\n')
        const bundle = await createBackupBundle('source')

        await writeDefaults('v2')
        await listCoreSystemPrompts()
        await resetCoreSystemPrompt('api_primary')

        await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

        expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe('my own API prompt\n')
        const summary = summaryOf(await listCoreSystemPrompts(), 'api_primary')
        expect(summary).toMatchObject({ customized: true, newDefaultAvailable: true })
      })

      it('drops the instance\'s own metadata when an older backup has none, and says which prompts it cannot place', async () => {
        await writeDefaults('v1', ['dynamic_mcp'])
        await listCoreSystemPrompts()
        const original = await createBackupBundle('source')
        const older = withoutRecords(original.bytes, (key) => key.startsWith('batshit:system_prompt_meta:'))
        expect(older.removed).toBe(listCoreSystemPromptDefinitions().length)

        await writeDefaults('v2', ['dynamic_mcp'])
        await listCoreSystemPrompts()

        const preflight = await preflightBackupRestore('target', older.bytes)
        const warning = preflight.warnings.find((entry) => entry.includes('Primary Agent System Prompt'))
        expect(warning).toBeDefined()
        expect(warning).not.toContain('Dynamic Tool Search Prompt')

        await restoreBackupBundle('target', older.bytes, { confirmReplace: true })

        // The instance's own v2 metadata is gone right after the restore: it described the old text.
        expect(await redis.get('batshit:system_prompt_meta:api_primary')).toBeNull()
        // Never overwritten on a guess: the restored text may be an edit.
        expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe('api_primary default v1\n')
        const summaries = await listCoreSystemPrompts()
        // The instance's own v2 metadata did not survive to claim the old text is the new default.
        expect(summaryOf(summaries, 'api_primary')).toMatchObject({ matchesDefault: false, customized: true })
        // A prompt whose text is today's default is recorded as the default, so the next update refreshes it.
        expect(summaryOf(summaries, 'dynamic_mcp')).toMatchObject({ matchesDefault: true, customized: false })
        const dynamicMeta = (await redis.get('batshit:system_prompt_meta:dynamic_mcp')) as Record<string, any>
        expect(dynamicMeta).toMatchObject({ promptId: 'dynamic_mcp', customized: false })
        expect(typeof dynamicMeta.defaultHash).toBe('string')
      })

      it('restores a backup carrying metadata for a prompt this Batshit no longer lists, and leaves that metadata out', async () => {
        await writeDefaults('v1')
        await listCoreSystemPrompts()
        const original = await createBackupBundle('source')
        // A core prompt retired after the backup was made: its metadata is in the backup.
        const entries = { ...unzipSync(original.bytes) }
        entries['redis/records/99999999.json'] = new Uint8Array(
          Buffer.from(
            JSON.stringify({
              key: 'batshit:system_prompt_meta:zcbackup_retired',
              type: 'json',
              value: { promptId: 'zcbackup_retired', defaultHash: 'f'.repeat(64), customized: false, updatedAt: '2026-09-27T00:00:00.000Z' },
              ttlSeconds: null,
              groupId: 'prompts'
            }),
            'utf8'
          )
        )
        const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
        manifest.contents.redisRecordCount += 1
        entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest), 'utf8'))
        const withRetired = zipSync(entries)

        const preflight = await preflightBackupRestore('target', withRetired)
        expect(preflight.warnings.find((entry) => entry.includes('zcbackup_retired'))).toBeDefined()
        await restoreBackupBundle('target', withRetired, { confirmReplace: true })
        expect(await redis.exists('batshit:system_prompt_meta:zcbackup_retired')).toBe(false)
        expect(await redis.get('batshit:system_prompt_meta:api_primary')).toMatchObject({ promptId: 'api_primary' })
      })

      it('SA-139 R2: an older backup with n8n Workflow Subagent thread ids restores without them and says so', async () => {
        await redis.json.set('user:source:settings', '$', { user_id: 'source', theme: 'incoming' })
        const entries = { ...unzipSync((await createBackupBundle('source')).bytes) }
        const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
        for (const slug of ['flow', 'other_flow']) {
          entries[`redis/records/${String(++manifest.contents.redisRecordCount).padStart(8, '0')}.json`] = Buffer.from(JSON.stringify({
            key: `subagent_thread:sess_old:${slug}`, type: 'string', value: `thread_${slug}`, ttlSeconds: null, groupId: 'chats'
          }))
        }
        entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
        const older = zipSync(entries)

        const preflight = await preflightBackupRestore('target', older)
        expect(preflight.warnings).toContain('This backup carries 2 n8n Workflow Subagent thread ids. n8n Workflow Subagents were removed, so Batshit leaves them out.')
        await expect(restoreBackupBundle('target', older, { confirmReplace: true })).resolves.toMatchObject({ restored: true })
        expect(await redis.json.get('user:target:settings')).toMatchObject({ theme: 'incoming' })
        for (const slug of ['flow', 'other_flow']) expect(await redis.exists(`subagent_thread:sess_old:${slug}`)).toBe(false)
      })

      describe('BL-671 exact retired Subagent instruction records', () => {
        const retired = ['batshit:subagent_instructions', 'batshit:subagent_instructions:last_updated']
        const stageId = '11111111-2222-4333-8444-555555555558'

        function archiveWith(bytes: Uint8Array, keys: string[]) {
          const entries = { ...unzipSync(bytes) }
          const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
          for (const key of keys) {
            entries[`redis/records/${String(++manifest.contents.redisRecordCount).padStart(8, '0')}.json`] = Buffer.from(JSON.stringify({
              key, type: 'string', value: key.endsWith(':last_updated') ? '2026-08-01T00:00:00.000Z' : 'Retired text must never become current delegation guidance.',
              ttlSeconds: null, groupId: 'prompts'
            }))
          }
          entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
          return zipSync(entries)
        }
        async function stage(bytes: Uint8Array) {
          const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
          const archivePath = path.join(backupStagingRoot, `${storageKey}.zip`)
          await fs.writeFile(archivePath, bytes, { mode: 0o400 })
          await fs.writeFile(path.join(backupStagingRoot, `${storageKey}.json`), JSON.stringify({
            contract: 'batshit-backup-stage/v1', stageId, userId: 'target', filename: 'older-backup.zip',
            bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
            stagedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), archivePath
          }), { mode: 0o600 })
        }
        const preflight = (entry: 'buffer' | 'staged', bytes: Uint8Array) => entry === 'buffer'
          ? preflightBackupRestore('target', bytes) : preflightStagedBackupRestore('target', stageId)
        const restore = (entry: 'buffer' | 'staged', bytes: Uint8Array) => entry === 'buffer'
          ? restoreBackupBundle('target', bytes, { confirmReplace: true }) : restoreStagedBackup('target', stageId, { confirmReplace: true })
        async function originalArchive(customized = false) {
          await writeDefaults('v1')
          await listCoreSystemPrompts()
          if (customized) await saveCoreSystemPrompt('subagent_guidance', 'Current customized delegation guidance.\n')
          await redis.json.set('user:source:settings', '$', { user_id: 'source', theme: 'incoming' })
          const original = await createBackupBundle('source')
          await writeDefaults('v2')
          await listCoreSystemPrompts()
          await redis.json.set('user:target:settings', '$', { user_id: 'target', theme: 'original' })
          await redis.set('user:target:data', 'current auth account')
          await fs.writeFile(path.join(uploadRoot, 'original.txt'), 'original user file')
          return original.bytes
        }
        for (const entry of ['buffer', 'staged'] as const) {
          it.each(['both', 'text-only', 'timestamp-only', 'absent', 'current'] as const)(`${entry}: restores %s keys with live data and current prompt authority`, async variant => {
            const customized = variant === 'current'
            const keys = variant === 'both' ? retired : variant === 'text-only' ? retired.slice(0, 1) : variant === 'timestamp-only' ? retired.slice(1) : []
            const bytes = archiveWith(await originalArchive(customized), keys)
            if (entry === 'staged') await stage(bytes)
            const preview = await preflight(entry, bytes)
            const warnings = preview.warnings.filter(warning => warning.includes('retired Subagent instruction'))
            expect(warnings).toHaveLength(keys.length ? 1 : 0)
            for (const key of keys) expect(warnings[0]).toContain(key)
            expect(await redis.json.get('user:target:settings')).toEqual({ user_id: 'target', theme: 'original' })
            await expect(restore(entry, bytes)).resolves.toMatchObject({ restored: true })
            expect(await redis.json.get('user:target:settings')).toEqual({ user_id: 'target', theme: 'incoming' })
            expect(await redis.get('user:target:data')).toBe('current auth account')
            for (const key of retired) expect(await redis.exists(key), key).toBe(false)
            expect(await redis.get('batshit:subagent_guidance')).toBe(customized ? 'Current customized delegation guidance.\n' : 'subagent_guidance default v2\n')
            expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe('api_primary default v2\n')
            expect(await redis.get('batshit:system_prompt_meta:api_primary')).toMatchObject({ promptId: 'api_primary', customized: false })
            expect(summaryOf(await listCoreSystemPrompts(), 'subagent_guidance')).toMatchObject({ customized })
          })

          it.each([
            ['near-name', 'batshit:subagent_instructions_extra'],
            ['suffix', 'batshit:subagent_instructions:extra'],
            ['timestamp suffix', 'batshit:subagent_instructions:last_updated:extra'],
            ['case', 'batshit:Subagent_instructions'],
            ['auth', 'user_session:bl671-forged'],
            ['credential', agentRunCredentialKey('bl671-forged')],
            ['malformed JSON', ''], ['unsupported retired type', ''], ['future schema', '']
          ])(`${entry}: %s still refuses before original writes`, async (kind, key) => {
            const entries = { ...unzipSync(archiveWith(await originalArchive(), [...retired, ...(key ? [key] : [])])) }
            const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
            const firstRetired = Object.keys(entries).find(name => name.startsWith('redis/records/') && Buffer.from(entries[name]).toString().includes(`"key":"${retired[0]}"`))!
            if (kind === 'malformed JSON') entries[firstRetired] = Buffer.from('{')
            if (kind === 'unsupported retired type') {
              const record = JSON.parse(Buffer.from(entries[firstRetired]).toString()); record.type = 'stream'
              entries[firstRetired] = Buffer.from(JSON.stringify(record))
            }
            if (kind === 'future schema') manifest.schemaVersion = 3
            entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
            const bytes = zipSync(entries)
            if (entry === 'staged') await stage(bytes)
            // Reuse sourceInventory's execute-view pattern: the fake constructs
            // a fresh raw client per operation, so one captured client is insufficient.
            let redisWrites = 0
            const execute = redis.execute
            const mutators = new Set(['set', 'del', 'unlink', 'sAdd', 'sRem', 'zAdd', 'rPush', 'hSet', 'expire', 'persist', 'eval'])
            const view = (client: any, json = false): any => new Proxy(Object.create(null), {
              get(_target, property) {
                const value = Reflect.get(client, property, client)
                if (!json && property === 'json') return view(value, true)
                if (typeof value !== 'function') return value
                return (...args: any[]) => {
                  if (json ? property !== 'get' : mutators.has(String(property))) redisWrites++
                  return value.apply(client, args)
                }
              }
            })
            ;(redis as any).execute = async (operation: (client: any) => Promise<any>) => execute.call(redis, client => operation(view(client)))
            const rename = fs.rename.bind(fs), originalMoves: string[] = []
            const moved = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
              if (path.dirname(String(from)) === uploadRoot && !path.basename(String(from)).startsWith('.restore-')) originalMoves.push(String(from))
              return rename(from, to)
            })
            try {
              // A separate supplied client must be visible to this observer.
              await redis.execute(async client => { await client.json.set('user:target:settings', '$', { user_id: 'target', theme: 'original' }) })
              expect(redisWrites).toBe(1)
              redisWrites = 0
              for (const run of [() => preflight(entry, bytes), () => restore(entry, bytes)]) {
                const error = await run().then(() => undefined, reason => reason)
                expect(error).toBeDefined()
                expect(error.status).toBe(kind === 'future schema' ? 409 : 400)
                if (key) expect(error.message).toContain(key)
              }
              expect(redisWrites).toBe(0)
              expect(originalMoves).toEqual([])
              expect(await redis.json.get('user:target:settings')).toEqual({ user_id: 'target', theme: 'original' })
              expect(await redis.get('user:target:data')).toBe('current auth account')
              expect(await fs.readFile(path.join(uploadRoot, 'original.txt'), 'utf8')).toBe('original user file')
              for (const retiredKey of retired) expect(await redis.exists(retiredKey)).toBe(false)
            } finally { (redis as any).execute = execute; moved.mockRestore() }
          })
        }
      })

      // BL-1777: a backup made before the two zip tool prompts became one ("Tool Prompt: Zips")
      // carries the two old records. They restore (an unknown key would fail the whole restore),
      // and the restore's prompt check folds them at once: the Disabled record's edit is carried,
      // an old default goes.
      it('restores a backup made before the zip tool prompts were one record, and carries its edit', async () => {
        await writeDefaults('v1')
        await listCoreSystemPrompts()
        const original = await createBackupBundle('source')
        const older = withoutRecords(original.bytes, (key) =>
          key.startsWith('batshit:tool_guidance_zip_prompt') || key === 'batshit:system_prompt_meta:tool_guidance_zip'
        )
        expect(older.removed).toBe(3)
        const entries = { ...unzipSync(older.bytes) }
        const oldRecords = [
          { key: 'batshit:tool_guidance_zip_disabled_prompt', type: 'string', value: 'my zip guidance edit\n' },
          { key: 'batshit:tool_guidance_zip_disabled_prompt:last_updated', type: 'string', value: '2026-10-01T00:00:00.000Z' },
          {
            key: 'batshit:system_prompt_meta:tool_guidance_zip_disabled',
            type: 'json',
            value: { promptId: 'tool_guidance_zip_disabled', defaultHash: 'e'.repeat(64), customized: true, updatedAt: '2026-10-01T00:00:00.000Z' }
          },
          { key: 'batshit:tool_guidance_zip_enabled_prompt', type: 'string', value: 'an older packaged default\n' },
          {
            key: 'batshit:system_prompt_meta:tool_guidance_zip_enabled',
            type: 'json',
            value: {
              promptId: 'tool_guidance_zip_enabled',
              defaultHash: createHash('sha256').update('an older packaged default\n', 'utf8').digest('hex'),
              customized: false,
              updatedAt: '2026-10-01T00:00:00.000Z'
            }
          }
        ]
        oldRecords.forEach((record, index) => {
          entries[`redis/records/9999990${index}.json`] = new Uint8Array(
            Buffer.from(JSON.stringify({ ...record, ttlSeconds: null, groupId: 'prompts' }), 'utf8')
          )
        })
        const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
        manifest.contents.redisRecordCount += oldRecords.length
        entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest), 'utf8'))
        const beforeMerge = zipSync(entries)

        const preflight = await preflightBackupRestore('target', beforeMerge)
        expect(preflight.warnings.find((entry) => entry.includes('Tool Prompt: Zips'))).toBeDefined()
        await restoreBackupBundle('target', beforeMerge, { confirmReplace: true })

        expect(await redis.get('batshit:tool_guidance_zip_prompt')).toBe('my zip guidance edit\n')
        for (const key of [
          'batshit:tool_guidance_zip_disabled_prompt',
          'batshit:tool_guidance_zip_disabled_prompt:last_updated',
          'batshit:system_prompt_meta:tool_guidance_zip_disabled',
          'batshit:tool_guidance_zip_enabled_prompt',
          'batshit:system_prompt_meta:tool_guidance_zip_enabled'
        ]) {
          expect(await redis.exists(key), key).toBe(false)
        }
        const summary = summaryOf(await listCoreSystemPrompts(), 'tool_guidance_zip')
        expect(summary).toMatchObject({ customized: true, newDefaultAvailable: true })

        // A backup made now carries the one record and its metadata, in the prompts group.
        const exported = exportedRecords((await createBackupBundle('target')).bytes)
        for (const key of ['batshit:tool_guidance_zip_prompt', 'batshit:system_prompt_meta:tool_guidance_zip']) {
          expect(exported.find((record) => record.key === key)?.groupId, key).toBe('prompts')
        }
      })

      // SA-139 R4 (D14): a backup made while the CLI Primary Agent System Prompt existed carries its
      // text, time and metadata. It still restores; the restore leaves the three keys out and says
      // so. The exception is exact: a similarly named key still refuses the archive.
      describe('an older backup with the retired CLI Primary Agent System Prompt', () => {
        const CLI_RECORDS = [
          { key: 'batshit:batshit_mode4_system_prompt', type: 'string', value: 'my old CLI Primary prompt\n' },
          { key: 'batshit:batshit_mode4_system_prompt:last_updated', type: 'string', value: '2026-10-01T00:00:00.000Z' },
          { key: 'batshit:system_prompt_meta:cli_primary', type: 'json',
            value: { promptId: 'cli_primary', defaultHash: 'c'.repeat(64), customized: true, updatedAt: '2026-10-01T00:00:00.000Z' } }
        ]
        const WARNING = 'This backup carries the CLI Primary Agent System Prompt. The Claude Code CLI lane was removed, so Batshit leaves it out.'

        function withRecords(bytes: Uint8Array, records: Array<{ key: string; type: string; value: unknown }>) {
          const entries = { ...unzipSync(bytes) }
          records.forEach((record, index) => {
            entries[`redis/records/9999980${index}.json`] = new Uint8Array(
              Buffer.from(JSON.stringify({ ...record, ttlSeconds: null, groupId: 'prompts' }), 'utf8')
            )
          })
          const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
          manifest.contents.redisRecordCount += records.length
          entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest), 'utf8'))
          return zipSync(entries)
        }

        it('restores, leaves its three keys out, and says so in the preflight', async () => {
          await writeDefaults('v1')
          await listCoreSystemPrompts()
          await redis.json.set('user:source:settings', '$', { user_id: 'source', theme: 'incoming' })
          const older = withRecords((await createBackupBundle('source')).bytes, CLI_RECORDS)

          const preflight = await preflightBackupRestore('target', older)
          expect(preflight.warnings).toContain(WARNING)
          await expect(restoreBackupBundle('target', older, { confirmReplace: true })).resolves.toMatchObject({ restored: true })

          for (const { key } of CLI_RECORDS) expect(await redis.exists(key), key).toBe(false)
          expect(await redis.json.get('user:target:settings')).toMatchObject({ theme: 'incoming' })
          expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe('api_primary default v1\n')
        })

        it('a backup without them gives no such warning', async () => {
          await writeDefaults('v1')
          await listCoreSystemPrompts()
          const current = (await createBackupBundle('source')).bytes
          expect((await preflightBackupRestore('target', current)).warnings).not.toContain(WARNING)
        })

        // (Any unknown `batshit:system_prompt_meta:` key is retired-prompt metadata and is left out
        // by the older BL-372 rule, so the near names here are the text and time keys.)
        it.each(['batshit:batshit_mode4_system_prompt_extra', 'batshit:batshit_mode4_system_prompt:last_updated:extra'])(
          'a similarly named key (%s) still refuses the archive before any write', async (near) => {
            await writeDefaults('v1')
            await listCoreSystemPrompts()
            await redis.json.set('user:target:settings', '$', { user_id: 'target', theme: 'original' })
            const older = withRecords((await createBackupBundle('source')).bytes, [...CLI_RECORDS, { key: near, type: 'string', value: 'x' }])
            await expect(restoreBackupBundle('target', older, { confirmReplace: true })).rejects.toMatchObject({ status: 400 })
            expect(await redis.exists(near)).toBe(false)
            expect(await redis.json.get('user:target:settings')).toEqual({ user_id: 'target', theme: 'original' })
          })
      })

      it('a prompt text read that fails leaves the stored text alone and still checks the other prompts', async () => {
        await writeDefaults('v1')
        await listCoreSystemPrompts()
        await saveCoreSystemPrompt('api_primary', 'my own API prompt\n')
        await writeDefaults('v2')

        // The facade answers null for a failed read (BL-230); the raw client throws. The default
        // test lane's facade methods are already mocks, so call their own implementations.
        const failingKey = 'batshit:batshit_mode3_system_prompt'
        const originalOf = (method: (...args: any[]) => any) =>
          vi.isMockFunction(method) ? method.getMockImplementation()! : method.bind(redis)
        const facadeGet = originalOf(redis.get)
        const execute = originalOf(redis.execute)
        const getSpy = vi.spyOn(redis, 'get').mockImplementation(async (key: string) =>
          key === failingKey ? null : facadeGet(key)
        )
        const executeSpy = vi.spyOn(redis, 'execute').mockImplementation(async (operation: any) =>
          execute((client: any) =>
            operation(
              new Proxy(client, {
                get(target, property) {
                  if (property === 'get') {
                    return async (key: string) => {
                      if (key === failingKey) throw new Error('injected read failure')
                      return target.get(key)
                    }
                  }
                  const value = Reflect.get(target, property)
                  return typeof value === 'function' ? value.bind(target) : value
                }
              })
            )
          )
        )
        try {
          await reconcileCoreSystemPromptsAfterRestore()
        } finally {
          getSpy.mockRestore()
          executeSpy.mockRestore()
        }

        expect(await redis.get(failingKey)).toBe('my own API prompt\n')
        // The next prompt in the list was still checked: its older uncustomized default is refreshed.
        // (SA-139 R4: that was `cli_primary`, which left with the CLI Primary; read the list.)
        const definitions = listCoreSystemPromptDefinitions()
        const next = definitions[definitions.findIndex((definition) => definition.id === 'api_primary') + 1]
        expect(await redis.get(next.redisKey)).toBe(`${next.id} default v2\n`)
      })

      it('one unreadable default file skips that prompt and checks the rest', async () => {
        await writeDefaults('v1')
        await listCoreSystemPrompts()
        await writeDefaults('v2')
        const apiDefinition = listCoreSystemPromptDefinitions().find((definition) => definition.id === 'api_primary')!
        await fs.rm(path.join(promptDefaultsDir, apiDefinition.defaultFile))

        await expect(reconcileCoreSystemPromptsAfterRestore()).resolves.toBeUndefined()

        expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe('api_primary default v1\n')
        // The rest were checked: every other prompt's older uncustomized default is refreshed.
        for (const definition of listCoreSystemPromptDefinitions().filter((entry) => entry.id !== 'api_primary')) {
          expect(await redis.get(definition.redisKey), definition.id).toBe(`${definition.id} default v2\n`)
        }
      })
    })
  })

  describe('BL-1878 restored user Settings reach the actual compiler cache consumer immediately', () => {
    const database = new DatabaseService()
    const users = { source: 'cache-source', target: 'cache-target', other: 'cache-other' }
    function settings(userId: string, label: string, enabled: boolean) {
      return { id: `settings_${userId}`, user_id: userId,
        global_custom_system_prompt: `${label} prompt`, global_zip_settings: { live_file_reads: enabled },
        global_tool_grid_settings: { typed_file_tools: enabled }, default_workspace_path: `/${label}` }
    }
    function projection(label: string, enabled: boolean) {
      // The actual Settings reader retires the legacy global grant on every read,
      // before either a cold compiler load or its warm-cache path (redis.getUserSettings).
      return { globalCustomPrompt: `${label} prompt`, globalZipSettings: { live_file_reads: enabled },
        globalTypedFileTools: null, defaultWorkspacePath: `/${label}` }
    }
    // The actual helper used by buildFormattedChatInput owns the five-second map.
    // Calling it avoids unrelated provider/tool/Clip machinery; the cache/read is real.
    async function compilerSettings(userId: string) {
      return (database as any).loadSystemPrompts({ id: 'cache-probe', agentType: 'api', user_id: userId }, userId)
    }
    let settingsReadSpy: { mockRestore(): void } | undefined
    beforeEach(async () => {
      invalidateUserSettingsCache()
      if (process.env.VITEST_USE_REAL_REDIS !== 'true') {
        // Keep the real read projection on the same fake JSON store; the actual method
        // uses only this.json.get, so it never acquires the actual module's lazy client.
        const { RedisService } = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
        settingsReadSpy = vi.spyOn(redis, 'getUserSettings').mockImplementation(userId => RedisService.prototype.getUserSettings.call(redis as never, userId))
      }
      vi.useFakeTimers({ now: new Date(), toFake: ['Date'] })
    })
    afterEach(() => {
      try { invalidateUserSettingsCache(); vi.useRealTimers() }
      finally { settingsReadSpy?.mockRestore(); settingsReadSpy = undefined }
    })

    async function restore(entry: 'buffer' | 'staged', bytes: Uint8Array, confirmReplace: boolean) {
      if (entry === 'buffer') return restoreBackupBundle(users.target, bytes, { confirmReplace })
      const stageId = '11111111-2222-4333-8444-555555555557'
      const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
      const archivePath = path.join(backupStagingRoot, `${storageKey}.zip`)
      await fs.writeFile(archivePath, bytes)
      await fs.writeFile(path.join(backupStagingRoot, `${storageKey}.json`), JSON.stringify({
        contract: 'batshit-backup-stage/v1', stageId, userId: users.target, filename: 'batshit-backup.zip',
        bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
        stagedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), archivePath
      }))
      return restoreStagedBackup(users.target, stageId, { confirmReplace })
    }
    for (const entry of ['buffer', 'staged'] as const) {
      it(`${entry}: evicts only the restored user's warm cache before five seconds pass`, async () => {
        await redis.json.set(`user:${users.source}:settings`, '$', settings(users.source, 'restored', true))
        // The legacy global typed-tools choice is converted to each archived actor.
        // It is deliberately retired from restored global settings, never reintroduced
        // just to make the compiler-cache fixture resemble its old archive.
        const actorId = 'cache-restored-agent'
        await redis.json.set(`agent:${actorId}`, '$', { id: actorId, user_id: users.source,
          name: 'Cache restored agent', agentType: 'api', provider_specific_settings: { nativeTools: { bashEnabled: true } } })
        await redis.sAdd(`user:${users.source}:agents`, actorId)
        const bundle = await createBackupBundle(users.source)
        await redis.json.set(`user:${users.target}:settings`, '$', settings(users.target, 'old-target', false))
        await redis.json.set(`user:${users.other}:settings`, '$', settings(users.other, 'old-other', false))
        expect(await compilerSettings(users.target)).toMatchObject(projection('old-target', false))
        expect(await compilerSettings(users.other)).toMatchObject(projection('old-other', false))
        await redis.json.set(`user:${users.other}:settings`, '$', settings(users.other, 'changed-other', true))
        const primedAt = Date.now()

        await expect(restore(entry, bundle.bytes, true)).resolves.toMatchObject({ restored: true, targetUserId: users.target })

        expect(Date.now()).toBe(primedAt)
        expect(await redis.json.get(`user:${users.target}:settings`)).toEqual({ ...settings(users.target, 'restored', true), global_tool_grid_settings: {} })
        expect(await redis.json.get(`agent:${actorId}`)).toMatchObject({ user_id: users.target,
          provider_specific_settings: { nativeTools: { bashEnabled: true, typedFileToolsEnabled: true } } })
        expect(await compilerSettings(users.target)).toMatchObject({ ...projection('restored', true), globalTypedFileTools: null })
        expect(await redis.json.get(`user:${users.other}:settings`)).toMatchObject(settings(users.other, 'changed-other', true))
        expect(await compilerSettings(users.other)).toMatchObject(projection('old-other', false))
      })
      it(`${entry}: confirmation refusal keeps original records and the original warm cache`, async () => {
        await redis.json.set(`user:${users.source}:settings`, '$', settings(users.source, 'must-not-install', true))
        const bundle = await createBackupBundle(users.source)
        await redis.json.set(`user:${users.target}:settings`, '$', settings(users.target, 'old-target', false))
        expect(await compilerSettings(users.target)).toMatchObject(projection('old-target', false))
        const live = settings(users.target, 'still-live', true)
        await redis.json.set(`user:${users.target}:settings`, '$', live)

        await expect(restore(entry, bundle.bytes, false)).rejects.toMatchObject({ status: 409 })

        expect(await redis.json.get(`user:${users.target}:settings`)).toEqual(live)
        expect(await compilerSettings(users.target)).toMatchObject(projection('old-target', false))
        expect(initializeSystemSlashCommandsForUser).not.toHaveBeenCalled()
      })

      it(`${entry}: a post-commit initialization refusal preserves restored data and reports a warning without replay`, async () => {
        await redis.json.set(`user:${users.source}:settings`, '$', settings(users.source, 'committed-restored', false))
        const bundle = await createBackupBundle(users.source)
        await redis.json.set(`user:${users.target}:settings`, '$', settings(users.target, 'original-target', false))
        vi.mocked(initializeSystemSlashCommandsForUser).mockImplementationOnce(async userId => {
          expect(userId).toBe(users.target)
          // Normal mutation admission is available only after the restore fence closes.
          expect(() => captureSettingsLifecycle([`user:${users.target}:settings`])).not.toThrow()
          expect(await redis.json.get(`user:${users.target}:settings`)).toMatchObject({
            user_id: users.target, global_custom_system_prompt: 'committed-restored prompt'
          })
          throw new Error('synthetic-private-initialization-detail')
        })

        const result = await restore(entry, bundle.bytes, true)
        expect(result).toMatchObject({ restored: true, targetUserId: users.target,
          warnings: [expect.stringContaining('Your restored data was kept')] })
        expect(JSON.stringify(result)).not.toContain('synthetic-private-initialization-detail')
        expect(initializeSystemSlashCommandsForUser).toHaveBeenCalledTimes(1)
        expect(await redis.json.get(`user:${users.target}:settings`)).toMatchObject({
          user_id: users.target, global_custom_system_prompt: 'committed-restored prompt'
        })
      })
    }
  })

  describe('the schedule due cache survives nothing (F-8, DL-118-01)', () => {
    /** The seeded `sch_1` is due at this instant; see `seedRepresentativeData`. */
    const DUE_AT = new Date('2026-09-09T14:00:00.000Z')

    /**
     * Clear the schedule keyspace, then take one ticker-style sweep of it.
     *
     * The bundle is already built by this point, so removing the source schedule leaves
     * the instance with none at all — which is what the cache then remembers, for five
     * minutes. `listDueSchedules` is instance-wide (it walks `schedules:*`), so this has
     * to be the whole keyspace and not just the target user's half.
     */
    async function primeWithNoSchedulesAnywhere() {
      await redis.del('schedule:sch_1')
      await redis.execute(async (client) => client.del('schedules:source'))
      await redis.execute(async (client) => client.del('schedules:target'))
      __resetScheduleDueCacheForTests()
      await expect(listDueSchedules(DUE_AT)).resolves.toEqual([])
    }

    it('after restoreBackupBundle', async () => {
      await seedRepresentativeData('source')
      const bundle = await createBackupBundle('source')
      await primeWithNoSchedulesAnywhere()

      await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

      // No `{ walk: true }`: this is the ticker's call, and it must see the restored schedule.
      const due = await listDueSchedules(DUE_AT)
      expect(due.map((record) => record.id)).toEqual(['sch_1'])
    })

    it('after restoreStagedBackup', async () => {
      await seedRepresentativeData('source')
      const bundle = await createBackupBundle('source')

      // Staged the same way the disk-staged restore test above stages: the archive plus its
      // sidecar manifest under the staging root, keyed by the hash of the stage id.
      const stageId = '11111111-2222-4333-8444-555555555556'
      const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
      const archivePath = path.join(backupStagingRoot, `${storageKey}.zip`)
      await fs.writeFile(archivePath, bundle.bytes)
      await fs.writeFile(
        path.join(backupStagingRoot, `${storageKey}.json`),
        `${JSON.stringify({
          contract: 'batshit-backup-stage/v1',
          stageId,
          userId: 'target',
          filename: 'batshit-backup.zip',
          bytes: bundle.bytes.byteLength,
          sha256: createHash('sha256').update(bundle.bytes).digest('hex'),
          stagedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          archivePath
        })}\n`
      )
      await primeWithNoSchedulesAnywhere()

      await restoreStagedBackup('target', stageId, { confirmReplace: true })

      const due = await listDueSchedules(DUE_AT)
      expect(due.map((record) => record.id)).toEqual(['sch_1'])
    })
  })
  // Last: the actual failed issued fence deliberately holds this process until worker exit.
  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('holds actual catalogue-reset uncertainty before restore replacement and never certifies it from readback', async () => {
    await seedRepresentativeData('source')
    const bundle = await createBackupBundle('source')
    const key = slashCommandRevisionKey('target')
    const sentinel = { id: 'target-settings', user_id: 'target', ui_settings: { keep: 'Exact current target' } }
    await redis.json.set('user:target:settings', '$', sentinel)
    await redis.set(key, newSlashCommandRevision())
    const client = await redis.execute(async current => current), actual = client.del.bind(client)
    let issued = 0
    const spy = vi.spyOn(client, 'del').mockImplementation((async (...keys: any[]) => {
      if (keys.length === 1 && keys[0] === key) { issued++; await actual(key); throw new Error('Fixture lost catalogue fence reply') }
      return actual(...keys as Parameters<typeof actual>)
    }) as never)
    try { await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toMatchObject({ status: 503 }) }
    finally { spy.mockRestore() }
    expect(issued).toBe(1)
    expect(await redis.json.get('user:target:settings')).toEqual(sentinel)
    expect(await redis.get(key)).toBeNull()
    await expect(withSettingsRestoreFence(async () => 'must not run')).rejects.toThrow('unknown')
    expect(issued).toBe(1)
  })

})

/**
 * PR #106 review F-8 (DL-118-01) — a restore throws away the schedule due cache.
 *
 * `listDueSchedules` keeps one in-process fact, "no enabled schedule is due before T", so
 * the 60-second ticker does not walk the keyspace when nothing can be due. A restore
 * writes `schedules:{userId}` and the records under it **directly**, around the schedule
 * store — so nothing in the store knows the keyspace changed. Without the invalidation a
 * restored schedule is invisible to the clock until the five-minute bound expires, which
 * is the quiet half of "a schedule that did not survive a restore is a routine that
 * silently stops happening".
 */
