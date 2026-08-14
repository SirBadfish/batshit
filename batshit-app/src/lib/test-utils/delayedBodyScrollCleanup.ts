import { setTimeout as delay } from 'node:timers/promises'

function bodyScrollLockIsActive(): boolean {
  return (
    typeof document !== 'undefined' &&
    (document.body.style.overflow === 'hidden' ||
      document.body.style.pointerEvents === 'none')
  )
}

export async function waitForDelayedBodyScrollCleanup(): Promise<void> {
  if (!bodyScrollLockIsActive()) return

  // Bits UI deliberately waits 24 ms before releasing its shared body lock so
  // a replacement dialog can mount in the same tick. This global afterEach hook
  // runs after Svelte Testing Library's normal cleanup and keeps jsdom alive only
  // when that lock is still present.
  const deadline = Date.now() + 1_000
  while (bodyScrollLockIsActive()) {
    if (Date.now() >= deadline) {
      throw new Error('Svelte component cleanup left the document body locked')
    }
    await delay(5)
  }
}
