import { describe, expect, it, vi } from 'vitest'
import { clipClothingUploadReferences, clipHairUploadReferences } from '../clipHairReferences'
import { storeClipRecordForClient } from '../clipPersistence.server'

describe('Clip Hair publication/projection (default boundary, not Lua)', () => {
  it('projects every actual URL field with the readers decoded locator, preserving encoded filenames', () => {
    const row = { tunnelPath: '/uploads/%67oon_hair_imports/raw%23source.obj',
      localUrl: '/uploads/goon_hair_assets/a.png', displayUrl: 'http://local.test/uploads/goon_hair_assets/b.png?view=1',
      externalUrl: '/uploads/goon_hair_assets/c.png', thumbnailUrl: '/uploads/goon_hair_assets/d.png',
      fullResolutionUrl: '/uploads/goon_hair_assets/e.png', content: '/uploads/goon_hair_assets/prose.png',
      description: '/uploads/goon_hair_assets/prose.png', tags: ['/uploads/goon_hair_assets/prose.png'] }
    expect(clipHairUploadReferences(row).map((ref) => [ref.uploadType, ref.filename])).toEqual([
      ['goon_hair_imports', 'raw#source.obj'], ['goon_hair_assets', 'a.png'], ['goon_hair_assets', 'b.png'],
      ['goon_hair_assets', 'c.png'], ['goon_hair_assets', 'd.png'], ['goon_hair_assets', 'e.png']
    ])
    expect(clipHairUploadReferences(JSON.stringify(row))).toEqual(clipHairUploadReferences(row))
  })

  it('keeps ordinary/prose Clip writes on the native fast path', async () => {
    const clip = { localUrl: '/uploads/images/photo.png', externalUrl: 'https://example.test/photo.png',
      content: '/uploads/goon_hair_assets/quoted.png', description: '/uploads/goon_hair_imports/quoted.obj' }
    const client = { json: { set: vi.fn().mockResolvedValue('OK') }, eval: vi.fn() }
    expect(await storeClipRecordForClient(client, 'clip:owner:ordinary', clip)).toBe('OK')
    expect(client.eval).not.toHaveBeenCalled()
    expect(client.json.set).toHaveBeenCalledWith('clip:owner:ordinary', '$', clip)
  })

  it('projects Clothing independently without broadening the Hair backup projection', () => {
    const row = {
      tunnelPath: '/uploads/%67oon_clothing_assets/top%23preview.png',
      localUrl: '/uploads/goon_clothing_assets/local.png',
      displayUrl: 'https://display.test/uploads/goon_clothing_assets/display.png?view=1',
      externalUrl: '/uploads/goon_clothing_assets/external.png',
      thumbnailUrl: '/uploads/goon_clothing_assets/thumb.png',
      fullResolutionUrl: '/uploads/goon_clothing_assets/full.png',
      content: '/uploads/goon_clothing_assets/not-owned.png', mimeType: { malformed: true }
    }
    expect(clipClothingUploadReferences(row).map(ref => ref.filename)).toEqual([
      'top#preview.png', 'local.png', 'display.png', 'external.png', 'thumb.png', 'full.png'
    ])
    expect(clipClothingUploadReferences(JSON.stringify(row))).toEqual(clipClothingUploadReferences(row))
    expect(clipHairUploadReferences(row)).toEqual([])
    expect(clipClothingUploadReferences({ content: row.localUrl, description: row.localUrl, tags: [row.localUrl] })).toEqual([])
    expect(clipClothingUploadReferences('not a serialized Clip row')).toEqual([])
  })

  it('guards Clothing URLs in the same atomic whole-row write without rewriting either namespace', async () => {
    const clip = { localUrl: '/uploads/%67oon_clothing_assets/preview%23one.png',
      thumbnailUrl: '/uploads/goon_hair_assets/hair.png', content: 'unchanged' }
    const client = { json: { set: vi.fn() }, eval: vi.fn().mockResolvedValue('ASSET_UNAVAILABLE') }
    await expect(storeClipRecordForClient(client, 'clip:owner:held-clothes', clip)).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
    expect(client.json.set).not.toHaveBeenCalled()
    const options = client.eval.mock.calls[0][1]
    expect(JSON.parse(options.arguments[0])).toEqual(clip)
    expect(JSON.parse(options.arguments[1])).toEqual([
      'upload:goon_hair_assets:hair.png', 'upload:goon_clothing_assets:preview#one.png'
    ])
  })

  it('protects all six legacy Closet URL fields independently of Hair backup and ignores prose', async () => {
    const fields = ['tunnelPath', 'localUrl', 'displayUrl', 'externalUrl', 'thumbnailUrl', 'fullResolutionUrl']
    const row = Object.fromEntries(fields.map((field, index) => [field, `/uploads/goon_closet/${index}_legacy%23texture.png`]))
    row.content = '/uploads/goon_closet/not-a-borrower.png'
    const refs = clipClothingUploadReferences(row)
    expect(refs.map(ref => ref.filename)).toEqual(fields.map((_, index) => `${index}_legacy#texture.png`))
    expect(clipClothingUploadReferences(JSON.stringify(row))).toEqual(refs)
    expect(clipHairUploadReferences(row)).toEqual([])
    const client = { json: { set: vi.fn() }, eval: vi.fn().mockResolvedValue('ASSET_UNAVAILABLE') }
    await expect(storeClipRecordForClient(client, 'clip:owner:legacy-closet', row)).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
    expect(client.json.set).not.toHaveBeenCalled()
    expect(JSON.parse(client.eval.mock.calls[0][1].arguments[1])).toEqual(fields.map((_, index) => `upload:goon_closet:${index}_legacy#texture.png`))
  })

  it('passes decoded exact upload keys to atomic publication without rewriting the saved Clip', async () => {
    const clip = { localUrl: '/uploads/%67oon_hair_assets/texture%23alpha.png', content: 'unchanged', extra: [1, 2] }
    const client = { json: { set: vi.fn() }, eval: vi.fn().mockResolvedValue('ASSET_UNAVAILABLE') }
    await expect(storeClipRecordForClient(client, 'clip:owner:held', clip)).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
    expect(client.json.set).not.toHaveBeenCalled()
    const options = client.eval.mock.calls[0][1]
    expect(options.keys).toEqual(['clip:owner:held'])
    expect(JSON.parse(options.arguments[0])).toEqual(clip)
    expect(JSON.parse(options.arguments[1])).toEqual(['upload:goon_hair_assets:texture#alpha.png'])
  })
})
