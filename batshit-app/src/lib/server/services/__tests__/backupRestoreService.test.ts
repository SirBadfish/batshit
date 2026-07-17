import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { unzipSync, zipSync } from 'fflate/node'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
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
import {
  GOON_LIVE_BUILD_CONTRACT,
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_JOB_CONTRACT,
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  GOON_RECIPE_STATE_CONTRACT,
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  RECIPE_MIGRATION_PLAN_CONTRACT,
  RECIPE_SOURCE_CONTRACT,
  createGoonRecipeDocument,
  createRecipeRevisionEnvelope,
  recipeAuthoringRevisionSha256,
  recipeRevisionBundleSha256,
  recipeStateSnapshotSha256
} from '$lib/goons/recipe'
import {
  BackupRestoreError,
  createBackupBundle,
  createBackupBundleStream,
  preflightBackupRestore,
  restoreBackupBundle
} from '../backupRestoreService'

useRedisTestServer()

let uploadRoot: string
let previousUploadsDir: string | undefined
let previousPublicServerUrl: string | undefined
let previousContainerized: string | undefined
let previousRuntimeEnv: string | undefined
let previousCodexWorkdir: string | undefined

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
  const facialDefinition = parseFacialArtworkDefinition(
    JSON.parse(
      await fs.readFile(
        path.resolve(process.cwd(), 'static/goons/facial-artwork/v3/facial-artwork-v3.json'),
        'utf8'
      )
    )
  )
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
  const eyeDefinition = parseEyeAppearanceDefinition(
    JSON.parse(
      await fs.readFile(
        path.resolve(process.cwd(), 'static/goons/eye-appearance/v1/eye-appearance-v1.json'),
        'utf8'
      )
    )
  )
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
}

describe('backupRestoreService', () => {
  beforeEach(async () => {
    previousUploadsDir = process.env.UPLOADS_DIR
    previousPublicServerUrl = process.env.PUBLIC_BATSHIT_SERVER_URL
    previousContainerized = process.env.BATSHIT_CONTAINERIZED
    previousRuntimeEnv = process.env.BATSHIT_RUNTIME_ENV
    previousCodexWorkdir = process.env.BATSHIT_CODEX_WORKDIR
    uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-backup-test-'))
    process.env.UPLOADS_DIR = uploadRoot
    process.env.PUBLIC_BATSHIT_SERVER_URL = 'http://localhost:5614'
    delete process.env.BATSHIT_CONTAINERIZED
    delete process.env.BATSHIT_RUNTIME_ENV
    delete process.env.BATSHIT_CODEX_WORKDIR
  })

  afterEach(async () => {
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
    await fs.rm(uploadRoot, { recursive: true, force: true })
  })

  it('exports a structured backup that excludes secrets by default', async () => {
    await seedRepresentativeData('source')

    const bundle = await createBackupBundle('source')
    expect(bundle.manifest.schemaVersion).toBe(1)
    expect(bundle.manifest.secrets.included).toBe(false)
    expect(bundle.manifest.secrets.excludedRecordCount).toBe(1)
    expect(bundle.manifest.secrets.redactedFieldCount).toBeGreaterThan(0)
    expect(bundle.manifest.contents.fileAssetCount).toBe(3)

    const preflight = await preflightBackupRestore('target', bundle.bytes)
    expect(preflight.ok).toBe(true)
    expect(preflight.sourceUserId).toBe('source')
    expect(preflight.targetUserId).toBe('target')
    expect(preflight.userRemapRequired).toBe(true)
  })

  it('can include encrypted secret records only when requested', async () => {
    await seedRepresentativeData('source')

    const bundle = await createBackupBundle('source', { includeSecrets: true })

    expect(bundle.manifest.secrets.included).toBe(true)
    expect(bundle.manifest.secrets.excludedRecordCount).toBe(0)
    expect(bundle.manifest.contents.groups.find((group) => group.id === 'api-keys')?.recordCount).toBe(1)
  })

  it('streams filesystem assets into a readable zip backup', async () => {
    await seedRepresentativeData('source')

    const bundle = await createBackupBundleStream('source')
    const bytes = new Uint8Array(await new Response(bundle.stream).arrayBuffer())
    const entries = unzipSync(bytes)

    expect(bundle.manifest.contents.fileAssetCount).toBe(3)
    expect(Object.keys(entries)).toContain('manifest.json')
    expect(Object.keys(entries)).toContain('files/uploads/images/photo.png')
    expect(Object.keys(entries)).toContain('files/uploads/avatars/agent/legacy-avatar.png')
    expect(Object.keys(entries)).toContain('files/uploads/goon_facial_artwork/brow-left.png')
    expect(Buffer.from(entries['files/uploads/images/photo.png']).toString('utf8')).toBe('image-bytes')
    expect(Buffer.from(entries['files/uploads/avatars/agent/legacy-avatar.png']).toString('utf8')).toBe(
      'legacy-avatar-bytes'
    )
    expect(
      Buffer.from(entries['files/uploads/goon_facial_artwork/brow-left.png']).toString('utf8')
    ).toBe('facial-artwork-bytes')
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

    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    expect(result.restored).toBe(true)
    expect(result.targetUserId).toBe('target')
    expect(result.fileAssetCount).toBe(3)

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
      schemaVersion: 'eye-appearance-state/v1',
      irisSize: 1.1
    })
  })

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

  it('backs up and remaps durable Recipe revisions, documents, and jobs', async () => {
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
      siblings: []
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
      content: { contract: GOON_LIVE_BUILD_CONTRACT }
    })
    const planDocument = await createGoonRecipeDocument({
      userId: 'source',
      goonId: 'goon_recipe',
      content: { contract: RECIPE_MIGRATION_PLAN_CONTRACT }
    })
    const receiptKey = `goon_recipe_document:source:goon_recipe:${receiptDocument.sha256}`
    const liveKey = `goon_recipe_document:source:goon_recipe:${liveDocument.sha256}`
    const planKey = `goon_recipe_document:source:goon_recipe:${planDocument.sha256}`
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
        activeRevision: revisionRef,
        previousRevision: null,
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
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })
    await redis.json.set(revisionKey, '$', envelope)
    await redis.json.set(receiptKey, '$', receiptDocument)
    await redis.json.set(liveKey, '$', liveDocument)
    await redis.json.set(planKey, '$', planDocument)
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
        activeRevision: otherRevisionRef,
        previousRevision: null,
        pendingJob: null,
        latestUpdateReport: null,
        lastFailure: null,
        maintenanceFailure: null
      },
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z'
    })
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

    const restoredRevision = (await redis.json.get(targetRevisionKey)) as Record<string, any>
    expect(restoredRevision.sourceContainmentReceipt.ref).toBe(targetReceiptKey)
    expect(restoredRevision.envelopeSha256).toBe(restoredGoon.recipe.activeRevision.sha256)

    const restoredJob = (await redis.json.get(targetJobKey)) as Record<string, any>
    expect(restoredJob.userId).toBe('target')
    expect(restoredJob.sourceRevision.ref).toBe(targetRevisionKey)
    expect(restoredJob.stagedSource.containmentReceipt.ref).toBe(targetReceiptKey)
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
})
