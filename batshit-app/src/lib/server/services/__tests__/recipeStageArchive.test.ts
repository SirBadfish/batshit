import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type { RecipeStoredAssetRef } from '$lib/goons/recipe/archiveContainmentContracts'
import { strictStoredZipEntries } from '$lib/goons/recipe/liveGoonBaker'
import {
  readStageSourceArchiveBytes,
  RecipeStageArchiveMismatchError
} from '../recipeStageArchive.server'

const model = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])
const manifest = new TextEncoder().encode('{"live":1}')

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** A tiny independent ZIP32 fixture writer; malformed cases alter its fields. */
function storedZip(entries: { name: string; bytes: Uint8Array }[] = [
  { name: 'avatar.glb', bytes: model }, { name: 'avatar.json', bytes: manifest }
]) {
  const names = entries.map(entry => new TextEncoder().encode(entry.name))
  const localSize = entries.reduce((n, entry, i) => n + 30 + names[i]!.length + entry.bytes.length, 0)
  const centralSize = entries.reduce((n, _, i) => n + 46 + names[i]!.length, 0)
  const bytes = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(bytes.buffer)
  const offsets: number[] = []
  let at = 0
  entries.forEach((entry, i) => {
    const name = names[i]!, crc = crc32(entry.bytes)
    offsets.push(at)
    view.setUint32(at, 0x04034b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint32(at + 14, crc, true)
    view.setUint32(at + 18, entry.bytes.length, true)
    view.setUint32(at + 22, entry.bytes.length, true)
    view.setUint16(at + 26, name.length, true)
    bytes.set(name, at + 30)
    bytes.set(entry.bytes, at + 30 + name.length)
    at += 30 + name.length + entry.bytes.length
  })
  const centralAt = at
  entries.forEach((entry, i) => {
    const name = names[i]!, crc = crc32(entry.bytes)
    view.setUint32(at, 0x02014b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, 20, true)
    view.setUint32(at + 16, crc, true)
    view.setUint32(at + 20, entry.bytes.length, true)
    view.setUint32(at + 24, entry.bytes.length, true)
    view.setUint16(at + 28, name.length, true)
    view.setUint32(at + 42, offsets[i]!, true)
    bytes.set(name, at + 46)
    at += 46 + name.length
  })
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, entries.length, true)
  view.setUint16(at + 10, entries.length, true)
  view.setUint32(at + 12, centralSize, true)
  view.setUint32(at + 16, centralAt, true)
  return bytes
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixture(packageBytes = storedZip(), extractedModel = model, extractedManifest = manifest) {
  const assets = {
    archive: { ref: '/uploads/test/archive.bgoon', bytes: packageBytes.length, sha256: sha256(packageBytes) },
    model: { ref: '/uploads/test/avatar.glb', bytes: extractedModel.length, sha256: sha256(extractedModel) },
    manifest: { ref: '/uploads/test/avatar.json', bytes: extractedManifest.length, sha256: sha256(extractedManifest) }
  }
  const stored = new Map([
    [assets.archive.ref, packageBytes], [assets.model.ref, extractedModel],
    [assets.manifest.ref, extractedManifest]
  ])
  const readVerified = vi.fn(async (asset: RecipeStoredAssetRef) => {
    const bytes = stored.get(asset.ref)!
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw Error(`stored asset mismatch: ${asset.ref}`)
    return Uint8Array.from(bytes)
  })
  return { assets, stored, readVerified }
}

describe('Stage-only Recipe archive byte ownership', () => {
  it('shares exact stored members while still independently reading all three assets, including an offset Buffer', async () => {
    const original = storedZip()
    const padded = Buffer.alloc(original.length + 13, 0xa5)
    Buffer.from(original).copy(padded, 7)
    const packageView = padded.subarray(7, 7 + original.length)
    const { assets, readVerified } = fixture(original)
    readVerified.mockImplementation(async asset => asset.ref === assets.archive.ref
      ? packageView : Uint8Array.from(asset.ref === assets.model.ref ? model : manifest))
    const result = await readStageSourceArchiveBytes(assets, readVerified)
    expect(readVerified.mock.calls.map(([asset]) => asset.ref)).toEqual([
      assets.archive.ref, assets.model.ref, assets.manifest.ref
    ])
    expect(result.packageBytes).toBe(packageView)
    expect(Array.from(result.modelBytes)).toEqual(Array.from(model))
    expect(Array.from(result.manifestBytes)).toEqual(Array.from(manifest))
    expect(result.modelBytes.buffer).toBe(result.packageBytes.buffer)
    expect(result.manifestBytes.buffer).toBe(result.packageBytes.buffer)
    expect(result.modelBytes.byteOffset).toBeGreaterThan(result.packageBytes.byteOffset)

    const clone = structuredClone(result)
    clone.modelBytes[0] = 0
    expect(clone.packageBytes[clone.modelBytes.byteOffset - clone.packageBytes.byteOffset]).toBe(0)
    expect(result.modelBytes[0]).toBe(model[0])
    expect(padded[0]).toBe(0xa5)
    expect(padded.at(-1)).toBe(0xa5)
  })

  it.each(['model', 'manifest'] as const)(
    'rejects a corrupted independently stored %s even when the archive is valid', async role => {
      const { assets, stored, readVerified } = fixture()
      stored.set(assets[role].ref, Uint8Array.from([9, 9, 9]))
      await expect(readStageSourceArchiveBytes(assets, readVerified))
        .rejects.toThrow(`stored asset mismatch: ${assets[role].ref}`)
      expect(readVerified).toHaveBeenCalledWith(assets[role])
    }
  )

  it('compares only the exact independent offset view, including its last byte', async () => {
    const { assets, readVerified } = fixture()
    const padded = new Uint8Array(model.length + 19).fill(0xa5)
    padded.set(model, 5)
    const extracted = padded.subarray(5, 5 + model.length)
    readVerified.mockImplementation(async asset => asset.ref === assets.archive.ref
      ? storedZip() : asset.ref === assets.model.ref ? extracted : manifest)
    await expect(readStageSourceArchiveBytes(assets, readVerified)).resolves.toBeDefined()
    extracted[extracted.length - 1] ^= 1
    await expect(readStageSourceArchiveBytes(assets, readVerified))
      .rejects.toBeInstanceOf(RecipeStageArchiveMismatchError)
  })

  it.each([-1, 1])('rejects a hash-verified member with a length difference of %s', async delta => {
    const changed = new Uint8Array(model.length + delta)
    changed.set(model.subarray(0, changed.length))
    const { assets, readVerified } = fixture(storedZip(), changed)
    await expect(readStageSourceArchiveBytes(assets, readVerified))
      .rejects.toBeInstanceOf(RecipeStageArchiveMismatchError)
  })

  it.each(['model', 'manifest'] as const)(
    'rejects a separately hash-valid %s that disagrees with its archive member', async role => {
      const changed = Uint8Array.from(role === 'model' ? model : manifest)
      changed[0] ^= 1
      const { assets, readVerified } = fixture(storedZip(),
        role === 'model' ? changed : model, role === 'manifest' ? changed : manifest)
      await expect(readStageSourceArchiveBytes(assets, readVerified))
        .rejects.toBeInstanceOf(RecipeStageArchiveMismatchError)
      expect(readVerified).toHaveBeenCalledWith(assets[role])
    }
  )

  it('falls back to separate buffers for a valid deflated authoring archive', async () => {
    const compressed = zipSync({ 'avatar.glb': model, 'avatar.json': manifest }, { level: 6 })
    expect(() => strictStoredZipEntries(compressed)).toThrow()
    const { assets, readVerified } = fixture(compressed)
    const result = await readStageSourceArchiveBytes(assets, readVerified)
    expect(readVerified).toHaveBeenCalledTimes(3)
    expect(Array.from(result.modelBytes)).toEqual(Array.from(model))
    expect(Array.from(result.manifestBytes)).toEqual(Array.from(manifest))
    expect(result.modelBytes.buffer).not.toBe(result.packageBytes.buffer)
    expect(result.manifestBytes.buffer).not.toBe(result.packageBytes.buffer)
  })

  it.each([
    ['CRC', () => { const bytes = storedZip(); bytes[40] ^= 1; return bytes }],
    ['duplicate entry', () => storedZip([
      { name: 'avatar.glb', bytes: model }, { name: 'avatar.glb', bytes: manifest }
    ])],
    ['unsafe path', () => storedZip([
      { name: '../bad.glb', bytes: model }, { name: 'avatar.json', bytes: manifest }
    ])],
    ['local/central name mismatch', () => { const bytes = storedZip(); bytes[30] ^= 1; return bytes }],
    ['local size mismatch', () => { const bytes = storedZip(); new DataView(bytes.buffer).setUint32(18, model.length + 1, true); return bytes }]
  ] as const)(
    '%s is ineligible for sharing and retains the existing independent-read behavior',
    async (_, makeBytes) => {
      const packageBytes = makeBytes()
      expect(() => strictStoredZipEntries(packageBytes)).toThrow()
      const { assets, readVerified } = fixture(packageBytes)
      const result = await readStageSourceArchiveBytes(assets, readVerified)
      expect(readVerified).toHaveBeenCalledTimes(3)
      expect(Array.from(result.modelBytes)).toEqual(Array.from(model))
      expect(Array.from(result.manifestBytes)).toEqual(Array.from(manifest))
      expect(result.modelBytes.buffer).not.toBe(result.packageBytes.buffer)
      expect(result.manifestBytes.buffer).not.toBe(result.packageBytes.buffer)
    }
  )
})
