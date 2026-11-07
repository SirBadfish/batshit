import type { BuiltinVoiceCatalogSnapshot } from '$lib/types/builtinVoiceCatalog'
import { runVoiceCatalogCasAttempt } from '$lib/utils/builtinVoiceCatalog'
import { upstashKvGetRaw, upstashKvSetIfUnchanged } from './upstashKv'
import { GLOBAL_VOICE_CATALOG_KEY, type VoiceCatalogStringStore } from './builtinVoiceCatalogStore'

/** Explicit call only: no default wrapper, route, cron or automation imports this preparation. */
export function createGlobalVoiceCatalogStore(): VoiceCatalogStringStore {
  return {
    async read() {
      const raw = await upstashKvGetRaw(GLOBAL_VOICE_CATALOG_KEY, { required: true, timeoutMs: 5000 })
      return raw === null ? { state: 'absent' } : { state: 'present', raw }
    },
    compareAndSet(expectedRaw, nextRaw) {
      // upstashKvSetIfUnchanged serializes its value once. Passing text would double encode it.
      return upstashKvSetIfUnchanged(GLOBAL_VOICE_CATALOG_KEY, expectedRaw, JSON.parse(nextRaw), { timeoutMs: 5000 })
    }
  }
}

export async function publishBuiltinVoiceCatalog(options: {
  store: VoiceCatalogStringStore
  collect(previous: BuiltinVoiceCatalogSnapshot | null): Promise<BuiltinVoiceCatalogSnapshot['providers']>
  nowMs: number
  initializeAbsent?: boolean
  dryRun?: boolean
}) {
  return runVoiceCatalogCasAttempt({ read: () => options.store.read(), collect: options.collect,
    compareAndSet: (before, next) => options.store.compareAndSet(before, next) }, options)
}
