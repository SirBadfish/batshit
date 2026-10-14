import fs from 'node:fs'
import { buildCatalogFromSnapshot, runModelCatalogSync } from '../src/lib/server/services/modelCatalogSync'
import { loadLocalEnvFiles } from './lib/loadLocalEnv'

// Usage:
//   npm run sync:model-catalog                                  real sync: publishes to Upstash
//   npm run sync:model-catalog -- --dry-run --out <file>        live sources, writes ONLY <file>
//   npm run sync:model-catalog -- --replay <snapshot.json> --out <file>
//                                                               no network at all: rebuilds the
//                                                               catalog from a published snapshot
// A dry run never uploads the catalog and never stores a sync report (BL-68).

function parseArgs(argv: string[]) {
  const args: { dryRun: boolean; out: string | null; replay: string | null } = { dryRun: false, out: null, replay: null }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${flag} needs a value`)
      return value
    }
    if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--out') args.out = next()
    else if (flag === '--replay') args.replay = next()
    else throw new Error(`Unknown flag ${flag}`)
  }
  if ((args.dryRun || args.replay) && !args.out) {
    throw new Error('--dry-run and --replay write their catalog to a file: pass --out <file>')
  }
  if (args.out && !args.dryRun && !args.replay) {
    throw new Error('--out is only for --dry-run or --replay; a real sync publishes to Upstash')
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

function printCollisions(collisions: Array<{ connectionId: string; kept: string; split: string[]; dropped: string[] }>) {
  if (!collisions.length) return
  console.log(`[catalog] Same-connection entries in one row: ${collisions.length}`)
  for (const collision of collisions) {
    console.log(
      `[catalog]   - ${collision.connectionId}: kept ${collision.kept}` +
        (collision.split.length ? `; own rows: ${collision.split.join(', ')}` : '') +
        (collision.dropped.length ? `; NOT published (id taken): ${collision.dropped.join(', ')}` : '')
    )
  }
}

if (args.replay) {
  const snapshot = JSON.parse(fs.readFileSync(args.replay, 'utf8'))
  const { payload, variantCollisions } = buildCatalogFromSnapshot(snapshot)
  fs.writeFileSync(args.out!, JSON.stringify(payload))
  console.log(`[catalog] Replayed ${args.replay} (fetchedAt ${snapshot.fetchedAt ?? 'unknown'}) without any network.`)
  console.log(`[catalog] models=${payload.models.length}; wrote ${args.out}; nothing was uploaded.`)
  printCollisions(variantCollisions)
} else {
  loadLocalEnvFiles({ label: 'catalog' })

  runModelCatalogSync({ trigger: 'cli', dryRun: args.dryRun })
    .then((result) => {
      const { report, payload } = result
      if (args.dryRun) {
        fs.writeFileSync(args.out!, JSON.stringify(payload))
        console.log(`[catalog] Dry run: wrote ${args.out}; nothing was uploaded and no report was stored.`)
      }
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
      printCollisions(report.variantCollisions ?? [])
    })
    .catch((error) => {
      console.error('[catalog] Failed to update registry:', error)
      process.exit(1)
    })
}
