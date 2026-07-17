import type { FacialArtworkProvenance } from './facialArtwork'

export type FacialArtworkUploadSourceKind = Extract<
  FacialArtworkProvenance['sourceKind'],
  'user-authored' | 'comfyui-generated' | 'approved-external'
>

export type FacialArtworkUploadCreditDraft = {
  sourceKind: FacialArtworkUploadSourceKind
  externalAuthor: string
  externalLicense: string
  externalRightsConfirmed: boolean
}

export function createDefaultFacialArtworkUploadCreditDraft(): FacialArtworkUploadCreditDraft {
  return {
    sourceKind: 'user-authored',
    externalAuthor: '',
    externalLicense: '',
    externalRightsConfirmed: false
  }
}

export type FacialArtworkUploadProvenanceInput = {
  sourceKind: FacialArtworkUploadSourceKind
  ownerDisplayName: string
  externalAuthor: string
  externalLicense: string
  externalRightsConfirmed: boolean
}

export type FacialArtworkUploadProvenanceResolution = {
  provenance: FacialArtworkProvenance | null
  missingReason: string
}

export function resolveFacialArtworkUploadProvenance(
  input: FacialArtworkUploadProvenanceInput
): FacialArtworkUploadProvenanceResolution {
  if (input.sourceKind === 'approved-external') {
    const author = input.externalAuthor.trim()
    const license = input.externalLicense.trim()
    if (!author) {
      return { provenance: null, missingReason: 'Add the original artist or source before uploading.' }
    }
    if (!license) {
      return { provenance: null, missingReason: 'Add the license or permission note before uploading.' }
    }
    if (!input.externalRightsConfirmed) {
      return { provenance: null, missingReason: 'Confirm that you have permission before uploading.' }
    }
    return {
      provenance: {
        sourceKind: input.sourceKind,
        author,
        license,
        rightsConfirmed: true
      },
      missingReason: ''
    }
  }

  const author = input.ownerDisplayName.trim()
  if (!author) {
    return {
      provenance: null,
      missingReason: 'Add your display name in User Settings before uploading your artwork.'
    }
  }

  return {
    provenance: {
      sourceKind: input.sourceKind,
      author,
      license:
        input.sourceKind === 'comfyui-generated'
          ? 'User-created ComfyUI output; use confirmed'
          : 'User-owned artwork',
      rightsConfirmed: true
    },
    missingReason: ''
  }
}
