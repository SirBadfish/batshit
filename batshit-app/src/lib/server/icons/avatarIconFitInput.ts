import type { AvatarIconFit } from '$lib/icons/iconTypes'

export function normalizeOptionalAvatarIconFitInput(
  value: unknown,
  fieldName: string
): AvatarIconFit | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (value === 'contain' || value === 'fill') return 'fill'

  throw Object.assign(new Error(`${fieldName} must be "contain" or "fill"`), {
    status: 400
  })
}
