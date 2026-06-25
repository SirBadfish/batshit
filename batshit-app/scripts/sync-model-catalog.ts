import { runModelCatalogSync } from '../src/lib/server/services/modelCatalogSync'
import { loadLocalEnvFiles } from './lib/loadLocalEnv'

loadLocalEnvFiles({ label: 'catalog' })

runModelCatalogSync({ trigger: 'cli' })
  .then((result) => {
    const { report, payload } = result
    console.log(`[catalog] Sync complete (${report.status}). models=${payload.models.length}`)
    console.log(`[catalog] Previous fetchedAt: ${report.previousFetchedAt ?? 'unknown'}`)
    console.log(`[catalog] Current fetchedAt:  ${report.fetchedAt}`)

    console.log('[catalog] Source results:')
    for (const source of report.sources ?? []) {
      const state = source.skipped
        ? 'skipped'
        : source.usedFallback
          ? 'fallback'
          : 'ok'
      const suffixParts = [
        `fetched=${source.fetchedCount}`,
        source.warning ? `warning=${source.warning}` : null,
        source.error ? `error=${source.error}` : null
      ].filter(Boolean)
      const suffix = suffixParts.length ? ` (${suffixParts.join(', ')})` : ''
      console.log(`[catalog] - ${source.connectionId}: ${state}${suffix}`)
    }

    const diff = report.diff
    console.log(
      `[catalog] Added models: ${diff.addedModelsTotal} (showing ${diff.addedModels.length})`
    )
    console.log(
      `[catalog] Removed models: ${diff.removedModelsTotal} (showing ${diff.removedModels.length})`
    )
    console.log(
      `[catalog] Connection changes: ${diff.connectionChangesTotal} (showing ${diff.connectionChanges.length})`
    )

    const printModels = (label: string, items: Array<{ displayName: string; key: string }>, limit: number) => {
      if (!items.length) return
      console.log(`[catalog] ${label}:`)
      const slice = items.slice(0, limit)
      for (const item of slice) {
        console.log(`[catalog]   - ${item.displayName} (${item.key})`)
      }
      if (items.length > slice.length) {
        console.log(`[catalog]   ...and ${items.length - slice.length} more`)
      }
    }

    printModels('Added', diff.addedModels, 25)
    printModels('Removed', diff.removedModels, 25)

    if (diff.connectionChanges.length) {
      console.log('[catalog] Connection changes (sample):')
      const sample = diff.connectionChanges.slice(0, 20)
      for (const change of sample) {
        const added = change.addedConnections.length ? `+${change.addedConnections.join(',')}` : ''
        const removed = change.removedConnections.length ? `-${change.removedConnections.join(',')}` : ''
        const details = [added, removed].filter(Boolean).join(' ')
        console.log(`[catalog]   - ${change.displayName} (${change.key}) ${details}`)
      }
      if (diff.connectionChanges.length > sample.length) {
        console.log(`[catalog]   ...and ${diff.connectionChanges.length - sample.length} more`)
      }
    }

    if (diff.truncated) {
      console.log('[catalog] Diff truncated (increase limits in modelCatalogSync if you want more)')
    }
  })
  .catch((error) => {
    console.error('[catalog] Failed to update registry:', error)
    process.exit(1)
  })
