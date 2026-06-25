import { loadPublishedCompatibilityMatrix, publishCompatibilityMatrix } from '../src/lib/server/services/compatibilityMatrixAdmin'
import { runN8nCompatibilitySync } from '../src/lib/server/services/n8nParameterCompatibility'
import { redis } from '../src/lib/server/redis'
import { loadLocalEnvFiles } from './lib/loadLocalEnv'

loadLocalEnvFiles({ label: 'matrix' })

async function main() {
  try {
    let previousFetchedAt: string | null = null
    let previousEntries = 0

    try {
      const previous = await loadPublishedCompatibilityMatrix()
      previousFetchedAt = previous.fetchedAt ?? null
      previousEntries = previous.entries.length
    } catch (error) {
      console.warn('[matrix] Failed to load previously published snapshot before sync:', error)
    }

    const synced = await runN8nCompatibilitySync()
    const published = await publishCompatibilityMatrix(synced)

    console.log(`[matrix] Sync complete. entries=${synced.entries.length}`)
    console.log(`[matrix] Previous fetchedAt: ${previousFetchedAt ?? 'unknown'}`)
    console.log(`[matrix] Current fetchedAt:  ${published.fetchedAt}`)
    console.log(`[matrix] Previous entries: ${previousEntries}`)
    console.log(`[matrix] Current entries:  ${published.entries.length}`)

    const providerSummary = synced.entries
      .map((entry) => {
        const provider = entry.scope.provider ?? 'unknown'
        const allowCount = Array.isArray(entry.allow) ? entry.allow.length : 0
        return `${provider}:${allowCount}`
      })
      .sort()

    if (providerSummary.length) {
      console.log('[matrix] Provider parameter counts:')
      for (const row of providerSummary) {
        console.log(`[matrix]   - ${row}`)
      }
    }
  } finally {
    await redis.disconnect().catch((error) => {
      console.warn('[matrix] Failed to disconnect Redis cleanly after sync:', error)
    })
  }
}

main().catch((error) => {
  console.error('[matrix] Failed to sync compatibility matrix:', error)
  process.exit(1)
})
