import { describe, expect, it } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'

import {
  HairImportJobError,
  HAIR_IMPORT_JOB_CONTRACT,
  createHairImportJob,
  deleteHairImportJobRecord,
  getHairImportJob,
  listDiscardableHairImportJobs,
  replaceHairImportJob
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
    await deleteHairImportJobRecord('user-2', 'job-2')
    await expect(getHairImportJob('user-2', 'job-2', now)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })
})
