import { describe, expect, it, vi } from 'vitest'
import { clipHairUploadReferences } from '../clipHairReferences'
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
