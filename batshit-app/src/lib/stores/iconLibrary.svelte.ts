import type { CustomIconRecord } from '$lib/icons/iconTypes'
import { iconLibraryService } from '$lib/services/iconLibraryService'

let customIcons = $state<CustomIconRecord[]>([])
let customIconsLoaded = $state(false)
let loadPromise: Promise<CustomIconRecord[]> | null = null

export function getCustomIconRecords() {
  return customIcons
}

export function areCustomIconRecordsLoaded() {
  return customIconsLoaded
}

export function setCustomIconRecords(nextIcons: CustomIconRecord[]) {
  customIcons = nextIcons
  customIconsLoaded = true
}

export function upsertCustomIconRecord(icon: CustomIconRecord) {
  setCustomIconRecords([icon, ...customIcons.filter((entry) => entry.id !== icon.id)])
}

export function removeCustomIconRecord(iconId: string) {
  setCustomIconRecords(customIcons.filter((entry) => entry.id !== iconId))
}

export async function ensureCustomIconRecordsLoaded() {
  if (customIconsLoaded) return customIcons
  if (loadPromise) return loadPromise

  loadPromise = iconLibraryService
    .list()
    .then((snapshot) => {
      setCustomIconRecords(snapshot.icons)
      return customIcons
    })
    .finally(() => {
      loadPromise = null
    })

  return loadPromise
}
