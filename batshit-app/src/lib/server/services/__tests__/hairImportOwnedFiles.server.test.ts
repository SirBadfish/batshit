import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createHairImportTexturePng,
  strictJsonBytes,
  storeHairAssetArtifact,
  discoverHairImportCleanupFiles
} from '../hairImportOwnedFiles.server'

function chunks(bytes: Uint8Array) {
  const values: Array<{ type: string; data: Uint8Array }> = []
  let offset = 8
  while (offset < bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    const length = view.getUint32(0, false)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    values.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  return values
}

describe('Hair import owned-file helpers', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('publishes the importer owner with canonical bytes before any job CAS', async () => {
    const bytes = new TextEncoder().encode('{}\n')
    const { createHash } = await import('node:crypto')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    vi.stubEnv('BATSHIT_TOKEN', 'synthetic-hair-file-test-token')
    const request = vi.fn(async (_url: unknown, options: any) => {
      const form = options.body as FormData
      expect(JSON.parse(String(form.get('hairImportOwner')))).toEqual({ contract: 'hair-import-upload/v1', userId: 'user', jobId: 'job' })
      expect(form.get('hairImportStateVersion')).toBe('7')
      expect(form.get('assetId')).toBe('imported-hair-job')
      expect(form.get('revisionId')).toBe('imported-hair-job-r1')
      expect(form.get('role')).toBe('import-receipt')
      expect([...new Uint8Array(await (form.get('file') as Blob).arrayBuffer())]).toEqual([...bytes])
      return Response.json({ file: { filename: 'receipt.json', size: bytes.length, sha256 } })
    })
    vi.stubGlobal('fetch', request)
    const stored = await storeHairAssetArtifact({ assetId: 'imported-hair-job', revisionId: 'imported-hair-job-r1',
      role: 'import-receipt', importOwner: { userId: 'user', jobId: 'job', stateVersion: 7 }, filename: 'receipt.json', mimeType: 'application/json', bytes })
    expect(stored).toMatchObject({ uploadType: 'goon_hair_assets', sha256, bytes: bytes.length })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('refuses malformed discovery tuples before they can corrupt retry ownership', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ files: [{ uploadType: 'goon_hair_assets', filename: 'foreign.png',
      ref: '/uploads/goon_hair_assets/foreign.png', sha256: 'a'.repeat(64), bytes: 1, mimeType: 'image/png' }] })))
    await expect(discoverHairImportCleanupFiles({ jobKey: 'hair_import_job:owner:job', stateVersion: 2, mode: 'retired', files: [] }))
      .rejects.toThrow('invalid file list')
  })

  it('keeps most of each lock Base with a full-strength soft Highlight streak across its width', () => {
    const png = createHairImportTexturePng('highlight-mask');
    const raw = inflateSync(Buffer.concat(chunks(png).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
    const row = (y: number) => Array.from({ length: 64 }, (_, x) => raw[y * 257 + 1 + x * 4]);
    const values = row(0);
    expect(values.filter((value) => value === 0).length).toBeGreaterThan(40);
    expect(values[31]).toBe(255);
    expect(values[32]).toBe(255);
    expect(values.some((value) => value > 0 && value < 255)).toBe(true);
    expect(values).toEqual([...values].reverse());
    expect(row(32)).toEqual(values);
    expect(row(63)).toEqual(values);
  });

  it('creates deterministic RGBA PNGs for neutral value and highlight masks', () => {
    const neutral = createHairImportTexturePng('neutral-value', 4, 3)
    const repeated = createHairImportTexturePng('neutral-value', 4, 3)
    const highlight = createHairImportTexturePng('highlight-mask', 4, 3)

    expect(neutral).toEqual(repeated)
    expect([...neutral.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(neutral).not.toEqual(highlight)

    const raw = inflateSync(Buffer.concat(chunks(neutral).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)))
    expect(raw.byteLength).toBe(3 * (1 + 4 * 4))
    expect(raw[1]).toBe(128)
    expect(raw[4]).toBe(255)
  })

  it('serializes only JSON objects for immutable receipts', () => {
    expect(new TextDecoder().decode(strictJsonBytes({ b: 2, a: 1 }))).toBe('{"a":1,"b":2}\n')
    expect(() => strictJsonBytes(null)).toThrow(/one JSON object/)
    expect(() => strictJsonBytes([])).toThrow(/one JSON object/)
  })

  it('rejects unbounded generated texture dimensions', () => {
    expect(() => createHairImportTexturePng('neutral-value', 1, 64)).toThrow(/between 2 and 256/)
    expect(() => createHairImportTexturePng('neutral-value', 257, 64)).toThrow(/between 2 and 256/)
  })
})
