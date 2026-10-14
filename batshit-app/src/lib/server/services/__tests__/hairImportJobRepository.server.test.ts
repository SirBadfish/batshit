import { beforeEach, describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'

import {
  HairImportJobError,
  HAIR_IMPORT_JOB_CONTRACT,
  createHairImportJob,
  deleteHairImportJobRecord,
  getHairImportJob,
  listDiscardableHairImportJobs,
  replaceHairImportJob,
  retireHairImportJob,
  retireDiscardableHairImportJob,
  hairImportCleanupContext
} from '../hairImportJobRepository.server'

const source = {
  uploadType: 'goon_hair_imports' as const,
  filename: 'source.obj',
  originalName: 'finished.obj',
  ref: '/uploads/goon_hair_imports/source.obj',
  sha256: 'a'.repeat(64),
  bytes: 128,
  mimeType: 'text/plain'
}

const inspectionPreview = {
  uploadType: 'goon_hair_imports' as const,
  filename: 'inspection-preview.glb',
  ref: '/uploads/goon_hair_imports/inspection-preview.glb',
  sha256: 'b'.repeat(64),
  bytes: 512,
  mimeType: 'model/gltf-binary'
}

describe('Hair import job repository', () => {
  useRedisTestServer()
  beforeEach(async () => {
    if (process.env.VITEST_USE_REAL_REDIS !== 'true') return
    // Actual acquisition now guards both owned staging tuples. The admitted
    // source harness cleans this fixture DB before these synthetic records.
    for (const file of [source, inspectionPreview]) {
      await redis.json.set(`upload:${file.uploadType}:${file.filename}`, '$', {
        uploadType: file.uploadType, filename: file.filename, size: file.bytes,
        sha256: file.sha256, mimetype: file.mimeType
      })
    }
  })

  it('creates an owner-bound expiring job and replaces it with optimistic state', async () => {
    const now = new Date('2026-08-09T18:00:00.000Z')
    const job = await createHairImportJob({
      userId: 'user-1',
      goonId: 'goon-1',
      source,
      cleanupFiles: [inspectionPreview, inspectionPreview, source],
      inspection: { sourceMode: 'generic-obj' },
      now,
      jobId: 'job-1'
    })
    expect(job).toMatchObject({
      contract: HAIR_IMPORT_JOB_CONTRACT,
      status: 'inspected',
      stateVersion: 1,
      target: { kind: 'new' },
      startingTransform: {
        move: { x: 0, y: 0, z: 0 },
        rotate: { x: 0, y: 0, z: 0 },
        uniformScale: 1,
        axisScale: { x: 1, y: 1, z: 1 }
      },
      initialTransform: {
        move: { x: 0, y: 0, z: 0 },
        rotate: { x: 0, y: 0, z: 0 },
        uniformScale: 1,
        axisScale: { x: 1, y: 1, z: 1 }
      },
      cleanupFiles: [source, inspectionPreview]
    })
    expect(await getHairImportJob('user-1', 'job-1', now)).toEqual(job)

    const reviewable = await replaceHairImportJob(
      job,
      { ...job, status: 'reviewable', proposal: { clumps: 2 } },
      new Date('2026-08-09T18:01:00.000Z')
    )
    expect(reviewable).toMatchObject({ status: 'reviewable', stateVersion: 2 })
    await expect(
      replaceHairImportJob(job, { ...job, status: 'failed' }, now)
    ).rejects.toMatchObject({
      code: 'WRITE_CONFLICT'
    })
  })

  it('rejects expired or deleted jobs', async () => {
    const now = new Date('2026-08-09T18:00:00.000Z')
    const job = await createHairImportJob({
      userId: 'user-2',
      goonId: 'goon-2',
      source,
      inspection: {},
      now,
      jobId: 'job-2'
    })
    expect(
      (
        await listDiscardableHairImportJobs(
          'user-2',
          new Date('2026-08-11T18:00:00.000Z')
        )
      ).map((entry) => entry.jobId)
    ).toEqual(['job-2'])
    await expect(
      getHairImportJob('user-2', 'job-2', new Date('2026-08-11T18:00:00.000Z'))
    ).rejects.toBeInstanceOf(HairImportJobError)
    await deleteHairImportJobRecord('user-2', 'job-2', hairImportCleanupContext(job, job.cleanupFiles))
    await expect(getHairImportJob('user-2', 'job-2', now)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('retires the observed generation and refuses a late failure or final delete from an older callback', async () => {
    const job = await createHairImportJob({ userId: 'owner', goonId: 'goon', source, inspection: {}, jobId: 'same-job' })
    const retired = await retireHairImportJob(job)
    expect(retired).toMatchObject({ status: 'cancelled', stateVersion: job.stateVersion + 1 })
    await expect(replaceHairImportJob(job, { ...job, status: 'failed' })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    await expect(replaceHairImportJob(retired, { ...retired, status: 'reviewable' })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    await expect(deleteHairImportJobRecord('owner', 'same-job', hairImportCleanupContext(job, job.cleanupFiles)))
      .rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    expect(await getHairImportJob('owner', 'same-job')).toEqual(retired)
  })

  it('does not turn a stale expiry listing into authority over a renewed job', async () => {
    const oldTime = new Date('2026-08-09T18:00:00Z')
    const job = await createHairImportJob({ userId: 'owner', goonId: 'goon', source, inspection: {}, now: oldTime, jobId: 'renewed' })
    const [listed] = await listDiscardableHairImportJobs('owner', new Date('2026-08-11T18:00:00Z'))
    const renewed = await replaceHairImportJob(job, { ...job, status: 'preparing' })
    await expect(retireDiscardableHairImportJob(listed)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    expect(await getHairImportJob('owner', 'renewed')).toEqual(renewed)
  })
})
