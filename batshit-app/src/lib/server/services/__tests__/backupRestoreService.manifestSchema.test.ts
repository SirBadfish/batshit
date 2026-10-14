/**
 * BL-1402: a backup's `schemaVersion` must be an exact positive integer, checked without
 * coercion, through BOTH restore preflights (the buffer one and the staged one). A malformed value
 * is a 400, a well-formed integer above this reader's maximum (2, BL-378 Phase 1b) a 409, and a
 * schema that disagrees with its partial-backup fields a 400: schema 2 is only ever a partial
 * backup (`backupRestoreService.partialReader.test.ts` reads real ones), so this complete
 * archive saying 2 is inconsistent.
 *
 * Owned state only: a temporary upload folder and staging folder, the default-lane Redis fake,
 * one synthetic upload record. No restore runs; nothing outside the temporary folders is read.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { unzipSync, zipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  BACKUP_READER_MAX_SCHEMA_VERSION,
  BATSHIT_BACKUP_SCHEMA_VERSION,
  createBackupBundle,
  preflightBackupRestore,
  preflightStagedBackupRestore
} from '../backupRestoreService'

useRedisTestServer()

const USER = 'user-1'
const STAGE_ID = '11111111-2222-4333-8444-5555555555bb'
let uploadRoot = ''
let stagingRoot = ''
let exported: Uint8Array

beforeEach(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-manifest-schema-uploads-'))
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-manifest-schema-staging-'))
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', stagingRoot)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  // A preflight never talks to batshit-server.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('preflight must not fetch')
  }))
  const relativePath = 'images/schema.png'
  await fs.mkdir(path.join(uploadRoot, 'images'), { recursive: true })
  await fs.writeFile(path.join(uploadRoot, relativePath), 'abc')
  await redis.json.set('upload:images:schema.png', '$', {
    filename: 'schema.png',
    originalName: 'schema.png',
    mimetype: 'image/png',
    size: 3,
    uploadType: 'images',
    storage: 'filesystem',
    relativePath,
    filePath: path.join(uploadRoot, relativePath)
  })
  exported = (await createBackupBundle(USER)).bytes
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(uploadRoot, { recursive: true, force: true })
  await fs.rm(stagingRoot, { recursive: true, force: true })
})

/**
 * The exported archive with `"schemaVersion": <json>` written as raw JSON text, so values JSON
 * can carry but JavaScript would print differently (`1e400` parses to Infinity, `-0`, `2.0`)
 * reach the reader exactly as an archive would hold them. `undefined` removes the field.
 */
function withSchemaJson(json: string | undefined) {
  const entries = unzipSync(exported)
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  expect(manifest.schemaVersion).toBe(1)
  const marker = '"__schema_marker__"'
  manifest.schemaVersion = '__schema_marker__'
  let text = JSON.stringify(manifest, null, 2)
  text = json === undefined
    ? text.replace(`  "schemaVersion": ${marker},\n`, '')
    : text.replace(marker, json)
  expect(text.includes('__schema_marker__')).toBe(false)
  entries['manifest.json'] = new Uint8Array(Buffer.from(text, 'utf8'))
  return zipSync(entries)
}

async function stage(bytes: Uint8Array) {
  const storageKey = createHash('sha256').update(STAGE_ID, 'utf8').digest('hex')
  const archivePath = path.join(stagingRoot, `${storageKey}.zip`)
  await fs.writeFile(archivePath, bytes)
  await fs.writeFile(
    path.join(stagingRoot, `${storageKey}.json`),
    `${JSON.stringify({
      contract: 'batshit-backup-stage/v1',
      stageId: STAGE_ID,
      userId: USER,
      filename: 'batshit-backup.zip',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      stagedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      archivePath
    })}\n`
  )
  return STAGE_ID
}

const MALFORMED = "This backup's schema version is not one Batshit supports."
const future = (value: string) =>
  `This backup uses schema ${value}, but this Batshit build only supports schema ${BACKUP_READER_MAX_SCHEMA_VERSION}.`
const INCONSISTENT = "This backup's partial-backup information is inconsistent."

/**
 * The rev 3 / rev 4 value table, as an archive's manifest JSON can carry it. NaN cannot be
 * written in JSON (`JSON.stringify(NaN)` is `null`), so no archive can hold it; the rule refuses
 * it anyway (`Number.isInteger(NaN)` is false). `1e400` is how JSON carries Infinity.
 */
const MALFORMED_CASES: Array<[label: string, json: string | undefined]> = [
  ['missing (undefined)', undefined],
  ['null', 'null'],
  ['string "1"', '"1"'],
  ['string "2"', '"2"'],
  ['string " 2 "', '" 2 "'],
  ['string "2.0"', '"2.0"'],
  ['string "3"', '"3"'],
  ['string "abc"', '"abc"'],
  ['empty string', '""'],
  ['true', 'true'],
  ['false', 'false'],
  ['[2]', '[2]'],
  ['[]', '[]'],
  ['{}', '{}'],
  ['1.5', '1.5'],
  ['0.5', '0.5'],
  ['0', '0'],
  ['-0', '-0'],
  ['-1', '-1'],
  ['Infinity (1e400)', '1e400'],
  ['-Infinity (-1e400)', '-1e400']
]

/** Schema 2 on a complete archive: an integer this reader accepts, but no partial section. */
const INCONSISTENT_CASES: Array<[label: string, json: string]> = [
  ['2', '2'],
  ['2 written as 2.0', '2.0']
]

const FUTURE_CASES: Array<[label: string, json: string, shown: string]> = [
  ['3', '3', '3'],
  ['a huge integer', '1e300', '1e+300']
]

const PREFLIGHTS = [
  ['the buffer preflight', (bytes: Uint8Array) => preflightBackupRestore(USER, bytes)],
  ['the staged preflight', async (bytes: Uint8Array) => preflightStagedBackupRestore(USER, await stage(bytes))]
] as const

/** What one preflight answers, as one comparable line, so a failure shows the whole table. */
async function outcome(run: Promise<unknown>) {
  try {
    await run
    return 'accepted'
  } catch (error) {
    const { name, status, message } = error as { name?: string; status?: number; message?: string }
    return `${name} ${status}: ${message}`
  }
}

describe('backup schema version is an exact positive integer (BL-1402)', () => {
  for (const [preflightName, preflight] of PREFLIGHTS) {
    describe(preflightName, () => {
      it('refuses every malformed schema value with 400', async () => {
        const answers: string[] = []
        for (const [label, json] of MALFORMED_CASES) {
          answers.push(`${label} -> ${await outcome(preflight(withSchemaJson(json)))}`)
        }
        expect(answers).toEqual(MALFORMED_CASES.map(([label]) => `${label} -> BackupRestoreError 400: ${MALFORMED}`))
      })

      it('refuses the integer 2 on an archive with no partial section as inconsistent (400)', async () => {
        const answers: string[] = []
        for (const [label, json] of INCONSISTENT_CASES) {
          answers.push(`${label} -> ${await outcome(preflight(withSchemaJson(json)))}`)
        }
        expect(answers).toEqual(INCONSISTENT_CASES.map(([label]) => `${label} -> BackupRestoreError 400: ${INCONSISTENT}`))
      })

      it('refuses every well-formed integer above 2 as a future schema with 409', async () => {
        const answers: string[] = []
        for (const [label, json] of FUTURE_CASES) {
          answers.push(`${label} -> ${await outcome(preflight(withSchemaJson(json)))}`)
        }
        expect(answers).toEqual(FUTURE_CASES.map(([label, , shown]) => `${label} -> BackupRestoreError 409: ${future(shown)}`))
      })

      it('accepts the integer 1, however the JSON writes it', async () => {
        for (const json of ['1', '1.0', '1e0']) {
          const summary = await preflight(withSchemaJson(json))
          expect(summary.ok, json).toBe(true)
          expect(summary.manifest.schemaVersion, json).toBe(1)
          expect(summary.fileAssetCount, json).toBe(1)
        }
      })
    })
  }

  it('the exporter writes the integer 1 (the history proof: every exporter since 330f1d8d9 wrote it)', () => {
    const manifest = JSON.parse(Buffer.from(unzipSync(exported)['manifest.json']).toString('utf8'))
    expect(manifest.schemaVersion).toBe(1)
    expect(Number.isInteger(manifest.schemaVersion)).toBe(true)
    expect(BATSHIT_BACKUP_SCHEMA_VERSION).toBe(1)
    expect(BACKUP_READER_MAX_SCHEMA_VERSION).toBe(2)
  })
})
