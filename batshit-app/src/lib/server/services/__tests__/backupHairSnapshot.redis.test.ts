// @vitest-environment node
// HELD until Ashe releases an owned Redis8+JSON controller (DB14), never normal/shared Redis.
// Raw values, read-only bounds and publication/read ordering need the actual Redis boundary.
import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { HAIR_BACKUP_SNAPSHOT_SCRIPT, parseHairBackupSnapshot, readHairBackupSnapshot, stagedHairUploadKeys } from '../backupHairSnapshot'
import { uploadRecordFingerprint } from '../backupUploadInspection'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'bl1374_real_user'
const INDEX = `user:${USER}:hair_assets`
const JOB = `hair_import_job:${USER}:job`
const REVISION = `hair_asset:${USER}:imported-hair-job:imported-hair-job-r1`
const SIDECAR = `hair_refit_source:${USER}:imported-hair-job:imported-hair-job-r1`
const SHA = 'a'.repeat(64)
const filename = `imported-hair-job_imported-hair-job-r1_geometry_${SHA}.glb`
const UPLOAD = `upload:goon_hair_assets:${filename}`
const upload = { storage: 'filesystem', uploadType: 'goon_hair_assets', filename,
  relativePath: `goon_hair_assets/${filename}`, sha256: SHA, size: 3, mimetype: 'model/gltf-binary',
  hairAssetArtifact: { assetId: 'imported-hair-job', revisionId: 'imported-hair-job-r1', role: 'geometry', sha256: SHA },
  hairImportUpload: { contract: 'hair-import-upload/v1', userId: USER, jobId: 'job', assetId: 'imported-hair-job',
    revisionId: 'imported-hair-job-r1', role: 'geometry', sha256: SHA, filename, bytes: 3 } }
const job = { contract: 'hair-import-job/v4', userId: USER, jobId: 'job', goonId: 'goon', status: 'preparing', stateVersion: 2,
  startingTransform: {}, initialTransform: {}, calibration: null, target: { kind: 'new' }, candidate: null, cleanupFiles: [] }

// Synthetic fixture models only the already-existing atomic pair/index/job transfer. The
// production finalization script stays unchanged and retains its owning qualification.
const TRANSFER = `
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
redis.call('JSON.SET', KEYS[2], '$', ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('DEL', KEYS[4])
return 'OK'
`

describe.runIf(REAL_REDIS_LANE)('Hair backup read cut (actual RedisJSON)', () => {
  useRedisTestServer()
  it('returns the original JSON numbers/one-entry arrays and leaves raw records byte-identical', async () => {
    await redis.execute(async (client) => {
      const raw = '{"matrix":[0.12345678901234568],"revisionSha256":"unchanged"}'
      await client.sendCommand(['JSON.SET', REVISION, '$', raw])
      const before = await client.sendCommand(['JSON.GET', REVISION])
      const cut = await readHairBackupSnapshot(client)
      expect(cut.get(REVISION)?.value).toEqual(JSON.parse(String(before)))
      expect(await client.sendCommand(['JSON.GET', REVISION])).toBe(before)
      expect(cut.get(REVISION)?.value).toMatchObject({ matrix: [0.12345678901234568] })
    })
  })

  it('captures either pre-transfer or completed index/revision/sidecar, never a fractured graph', async () => {
    await redis.execute(async (client) => {
      for (const publicationFirst of [false, true]) {
        await client.del([REVISION, SIDECAR, JOB, INDEX, UPLOAD])
        await client.json.set(JOB, '$', job)
        await client.json.set(UPLOAD, '$', upload)
        await client.json.set(`hair_asset:${USER}:prior:prior-r1`, '$', { assetId: 'prior', revisionId: 'prior-r1', geometry: { ref: '/uploads/goon_hair_assets/prior.glb' } })
        await client.sAdd(INDEX, 'prior@prior-r1')
        const publish = () => client.eval(TRANSFER, { keys: [REVISION, SIDECAR, INDEX, JOB], arguments: [
          JSON.stringify({ assetId: 'imported-hair-job', revisionId: 'imported-hair-job-r1', matrix: [0.12345678901234568] }),
          JSON.stringify({ source: { ref: `/uploads/goon_hair_assets/${filename}` } }), 'imported-hair-job@imported-hair-job-r1'
        ] })
        const [first, second] = publicationFirst
          ? await Promise.all([publish(), readHairBackupSnapshot(client)])
          : await Promise.all([readHairBackupSnapshot(client), publish()])
        const cut = (publicationFirst ? second : first) as Awaited<ReturnType<typeof readHairBackupSnapshot>>
        const finished = (cut.get(INDEX)?.value as string[]).includes('imported-hair-job@imported-hair-job-r1')
        expect(cut.has(REVISION)).toBe(finished); expect(cut.has(SIDECAR)).toBe(finished); expect(cut.has(JOB)).toBe(!finished)
        expect(stagedHairUploadKeys(cut).has(UPLOAD)).toBe(!finished)
        expect(uploadRecordFingerprint(UPLOAD, cut.get(UPLOAD)?.value)).toBe(uploadRecordFingerprint(UPLOAD, upload))
      }
    })
  })

  it('preserves supported legacy Redis types/TTLs instead of turning a corrupt owner into omission authority', async () => {
    await redis.execute(async (client) => {
      await client.set(REVISION, 'legacy Hair metadata')
      await client.expire(REVISION, 60)
      const expiry = await client.sendCommand(['PEXPIRETIME', REVISION])
      const hashKey = `hair_refit_source:${USER}:legacy-hash:r1`
      const listKey = `hair_asset:${USER}:legacy-list:r1`
      const zsetKey = `hair_asset:${USER}:legacy-zset:r1`
      await client.hSet(hashKey, { one: 'first', two: 'second' })
      await client.rPush(listKey, ['first', 'second'])
      await client.zAdd(zsetKey, [{ value: 'a', score: 0.12345678901234568 }, { value: 'b', score: 2 }])
      await client.sAdd(INDEX, 'legacy@r1')
      const cut = await readHairBackupSnapshot(client)
      expect(cut.get(REVISION)).toMatchObject({ type: 'string', value: 'legacy Hair metadata' })
      expect(cut.get(REVISION)?.ttlSeconds).toBeGreaterThan(0)
      expect(cut.get(INDEX)?.value).toEqual(['legacy@r1'])
      expect(cut.get(hashKey)).toMatchObject({ type: 'hash', value: { one: 'first', two: 'second' } })
      expect(cut.get(listKey)).toMatchObject({ type: 'list', value: ['first', 'second'] })
      expect(cut.get(zsetKey)).toMatchObject({ type: 'zset', value: [{ value: 'a', score: 0.12345678901234568 }, { value: 'b', score: 2 }] })
      expect(await client.sendCommand(['PEXPIRETIME', REVISION])).toBe(expiry)
    })
  })

  it.each([
    ['matching-record count', ['1', '268435456', '4096', '134217728']],
    ['raw byte count', ['4096', '1', '4096', '134217728']],
    ['collection count', ['4096', '268435456', '1', '134217728']]
  ])('refuses a bounded %s cut without changing any captured state', async (_label, bounds) => {
    await redis.execute(async (client) => {
      await client.json.set(REVISION, '$', { precise: 0.12345678901234568 })
      await client.sAdd(INDEX, ['a@r1', 'b@r1'])
      const before = await client.sendCommand(['JSON.GET', REVISION])
      const answer = await client.eval(HAIR_BACKUP_SNAPSHOT_SCRIPT, { keys: [], arguments: bounds })
      expect(() => parseHairBackupSnapshot(answer)).toThrow(/LIMIT.*Retry backup/)
      expect(await client.sendCommand(['JSON.GET', REVISION])).toBe(before)
      expect((await client.sMembers(INDEX)).sort()).toEqual(['a@r1', 'b@r1'])
    })
  })
})
