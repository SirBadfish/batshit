import type { GoonAnimationLibrary } from '$lib/types/goons'

const emptyLibrary: GoonAnimationLibrary = { vrma: [] }

let library = $state<GoonAnimationLibrary>({ ...emptyLibrary })
let loading = $state(false)
let error = $state<string | null>(null)

export function getGoonAnimationLibrary() {
  return library
}

export function setGoonAnimationLibrary(next: GoonAnimationLibrary | null | undefined) {
  const vrma = Array.isArray(next?.vrma) ? next!.vrma : []
  library = {
    ...emptyLibrary,
    ...(next ?? {}),
    vrma
  }
}

export function setGoonAnimationLibraryLoading(value: boolean) {
  loading = value
}

export function setGoonAnimationLibraryError(value: string | null) {
  error = value
}
