import { describe, expect, it } from 'vitest'
import { resolveFacialArtworkUploadProvenance } from './facialArtwork.provenance'

const baseInput = {
  ownerDisplayName: ' Josh ',
  externalAuthor: '',
  externalLicense: '',
  externalRightsConfirmed: false
}

describe('resolveFacialArtworkUploadProvenance', () => {
  it('makes self-authored and ComfyUI uploads ready from the live display name', () => {
    expect(
      resolveFacialArtworkUploadProvenance({ ...baseInput, sourceKind: 'user-authored' })
        .provenance
    ).toEqual({
      sourceKind: 'user-authored',
      author: 'Josh',
      license: 'User-owned artwork',
      rightsConfirmed: true
    })
    expect(
      resolveFacialArtworkUploadProvenance({ ...baseInput, sourceKind: 'comfyui-generated' })
        .provenance
    ).toEqual({
      sourceKind: 'comfyui-generated',
      author: 'Josh',
      license: 'User-created ComfyUI output; use confirmed',
      rightsConfirmed: true
    })
  })

  it('fails visibly when self-authored credit has no display name', () => {
    const result = resolveFacialArtworkUploadProvenance({
      ...baseInput,
      sourceKind: 'user-authored',
      ownerDisplayName: ' '
    })
    expect(result.provenance).toBeNull()
    expect(result.missingReason).toMatch(/display name in User Settings/i)
  })

  it('keeps external uploads blocked until trimmed attribution and permission are complete', () => {
    const missing = resolveFacialArtworkUploadProvenance({
      ...baseInput,
      sourceKind: 'approved-external'
    })
    expect(missing.provenance).toBeNull()
    expect(missing.missingReason).toMatch(/artist or source/i)

    const complete = resolveFacialArtworkUploadProvenance({
      ...baseInput,
      sourceKind: 'approved-external',
      externalAuthor: ' Example Artist ',
      externalLicense: ' Licensed with permission ',
      externalRightsConfirmed: true
    })
    expect(complete.provenance).toEqual({
      sourceKind: 'approved-external',
      author: 'Example Artist',
      license: 'Licensed with permission',
      rightsConfirmed: true
    })
  })
})
