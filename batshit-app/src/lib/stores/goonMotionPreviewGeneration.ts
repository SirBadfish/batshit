import { derived, writable } from 'svelte/store'

export const GOON_MOTION_PREVIEW_GENERATION_LIMIT = 5

const pendingGenerationCountStore = writable(0)

export const goonMotionPreviewGenerationCount = derived(
  pendingGenerationCountStore,
  (count) => count
)

export const goonMotionPreviewGenerationActive = derived(
  pendingGenerationCountStore,
  (count) => count > 0
)

export function tryBeginGoonMotionPreviewGeneration() {
  let started = false
  pendingGenerationCountStore.update((count) => {
    if (count >= GOON_MOTION_PREVIEW_GENERATION_LIMIT) {
      return count
    }
    started = true
    return count + 1
  })
  return started
}

export function endGoonMotionPreviewGeneration() {
  pendingGenerationCountStore.update((count) => Math.max(0, count - 1))
}
