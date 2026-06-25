import { cloneIconRef, isIconRef, type IconRef } from '$lib/icons/iconTypes'

export function normalizeOptionalIconRefInput(value: unknown, fieldName: string): IconRef | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isIconRef(value)) {
    throw Object.assign(new Error(`${fieldName} must be a valid icon picker reference`), {
      status: 400
    })
  }
  return cloneIconRef(value)
}
