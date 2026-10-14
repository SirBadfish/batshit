/**
 * Known Fal connection identities removed by the 2026-09-29 sync while their
 * exact endpoint pages still documented inference. These are prior coverage,
 * not a live list or proof that generation currently succeeds.
 */
export const RECOVERED_FAL_ENTRIES = [
  {
    id: 'imagineart/imagineart-1.5-preview/text-to-image',
    displayName: 'Imagineart 1.5 Preview',
    tags: ['text-to-image', 'image'],
    modelType: 'image',
    evidenceUrl: 'https://fal.ai/models/imagineart/imagineart-1.5-preview/text-to-image/api',
    checkedAt: '2026-09-29'
  },
  {
    id: 'imagineart/imagineart-1.5-pro-preview/text-to-image',
    displayName: 'ImagineArt 1.5 Pro Preview',
    tags: ['text-to-image', 'image'],
    modelType: 'image',
    evidenceUrl: 'https://fal.ai/models/imagineart/imagineart-1.5-pro-preview/text-to-image/api',
    checkedAt: '2026-09-29'
  },
  {
    id: 'imagineart/imagineart-2.0-edit-preview/image-to-image',
    displayName: 'Imagineart 2.0 Edit Preview',
    tags: ['image-to-image', 'image'],
    modelType: 'image',
    evidenceUrl: 'https://fal.ai/models/imagineart/imagineart-2.0-edit-preview/image-to-image/api',
    checkedAt: '2026-09-29'
  },
  {
    id: 'imagineart/imagineart-2.0-preview/text-to-image',
    displayName: 'Imagineart 2.0 Preview',
    tags: ['text-to-image', 'image'],
    modelType: 'image',
    evidenceUrl: 'https://fal.ai/models/imagineart/imagineart-2.0-preview/text-to-image/api',
    checkedAt: '2026-09-29'
  }
] as const
