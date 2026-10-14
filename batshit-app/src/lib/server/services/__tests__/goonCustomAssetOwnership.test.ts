import { describe, expect, it } from 'vitest'
import { loadHairBuiltinCatalogMetadata } from '../hairBuiltinCatalogMetadata.server'
import {
  collectCustomGoonUploadKeys,
  collectGoonGuardedReferences,
  customGoonDeletionKey
} from '../goonCustomAssetOwnership.server'

describe('custom Goon upload reference collection', () => {
  it('binds identity guards only to Hair state, preserving Clothing and unrelated receipts', async () => {
    const selected = { assetId: 'user-hair', assetRevisionId: 'r2', assetRevision: 2,
      assetRevisionSha256: 'a'.repeat(64), fitFamily: 'advanced', fitSha256: 'b'.repeat(64) }
    expect(await collectGoonGuardedReferences({ schemaVersion: 'clothing-state/v1', selected,
      receipt: selected }, 'owner')).toEqual([])
    expect(await collectGoonGuardedReferences({ schemaVersion: 'hair-state/v2', selected }, 'owner'))
      .toEqual([{ hairRevisionKey: 'hair_asset:owner:user-hair:r2', sha256: 'a'.repeat(64) }])
    expect(await collectGoonGuardedReferences({ ref: '/uploads/goon_hair_assets/shared.png' }, 'owner'))
      .toEqual(['upload:goon_hair_assets:shared.png'])
  })
  it('never lets a later correct selection mask an earlier conflicting immutable hash', async () => {
    const selection = { assetId: 'user-hair', assetRevisionId: 'r2', assetRevision: 2,
      assetRevisionSha256: 'a'.repeat(64) }
    await expect(collectGoonGuardedReferences([
      { schemaVersion: 'hair-state/v2', selected: selection },
      { schemaVersion: 'hair-state/v2', selected: { ...selection, assetRevisionSha256: 'b'.repeat(64) } }
    ], 'owner')).rejects.toThrow('conflicting immutable identities')
  })
  it('exempts only the exact trusted packaged identity, not a claimed builtin flag', async () => {
    const asset = (await loadHairBuiltinCatalogMetadata()).assets[0]
    const selected = { assetId: asset.assetId, assetRevisionId: asset.revisionId,
      assetRevision: asset.revision, assetRevisionSha256: asset.revisionSha256 }
    expect(await collectGoonGuardedReferences({ schemaVersion: 'hair-state/v2', selected }, 'owner')).toEqual([])
    expect(await collectGoonGuardedReferences({ schemaVersion: 'hair-state/v2', sourceClass: 'builtin',
      selected: { ...selected, assetRevisionSha256: 'f'.repeat(64) } }, 'owner')).toEqual([
      { hairRevisionKey: `hair_asset:owner:${asset.assetId}:${asset.revisionId}`, sha256: 'f'.repeat(64) }
    ])
  })
  it('collects nested custom upload URLs/refs and filename-only customAvatar files exactly once', () => {
    const value = {
      customAvatar: {
        package: { filename: 'package.bgoon' },
        backup: { model: { filename: 'old.glb' } },
        pending: { manifest: { filename: 'pending.json' } }
      },
      receipt: {
        source: { ref: 'https://batshit.example/uploads/goon_custom_packages/package.bgoon?x=1' },
        live: [
          { url: '/uploads/goon_custom_models/live.glb' },
          { ref: '/uploads/goon_custom_manifests/live.json' },
          { url: '/uploads/goons/unrelated.vrm' }
        ]
      }
    }
    expect(collectCustomGoonUploadKeys(value)).toEqual([
      'upload:goon_custom_manifests:live.json',
      'upload:goon_custom_manifests:pending.json',
      'upload:goon_custom_models:live.glb',
      'upload:goon_custom_models:old.glb',
      'upload:goon_custom_packages:package.bgoon'
    ])
    expect(customGoonDeletionKey('goon_custom_models', 'live.glb')).toBe(
      'goon_asset_delete:goon_custom_models:live.glb'
    )
  })

  it('claims the first custom filename in a URL with a suffix, matching the deletion audit', () => {
    expect(collectCustomGoonUploadKeys({
      url: '/uploads/goon_custom_models/a.glb/extra'
    })).toEqual(['upload:goon_custom_models:a.glb'])
  })

  it('ignores non-custom URLs and malformed or traversing paths', () => {
    expect(collectCustomGoonUploadKeys({
      urls: [
        '/uploads/goon_animations/a.glb',
        '/uploads/goon_custom_models/%2E%2E%2Fbad.glb',
        'Stored Recipe asset /uploads/goon_custom_models/a.glb does not match its receipt.',
        'upload:goon_custom_models:bare-key'
      ]
    })).toEqual([])
  })
})
