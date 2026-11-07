import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VoiceCatalogStringStore } from '../src/lib/server/services/builtinVoiceCatalogStore'
import type { publishFreshBuiltinVoiceCatalog } from '../src/lib/server/services/builtinVoiceCatalogCollector'
import { BUILTIN_VOICE_PROVIDER_IDS } from '../src/lib/data/builtinVoiceCatalog'

export type VoiceSyncOptions = { dryRun: boolean; initializeAbsent: boolean }
type Publish = typeof publishFreshBuiltinVoiceCatalog
export type VoiceSyncPorts = { store: VoiceCatalogStringStore; http: typeof fetch; now: () => number; publish: Publish }

/** Unknown, duplicate and contradictory flags fail before any live dependency is loaded. */
export function parseVoiceSyncArgs(argv: string[]): VoiceSyncOptions {
  const seen = new Set<string>()
  for (const arg of argv) {
    if (!['--publish', '--dry-run', '--initialize-absent'].includes(arg) || seen.has(arg)) throw new Error('invalid_arguments')
    seen.add(arg)
  }
  if (seen.has('--publish') && seen.has('--dry-run')) throw new Error('invalid_arguments')
  return { dryRun: !seen.has('--publish'), initializeAbsent: seen.has('--initialize-absent') }
}

/** Emit only fixed-schema facts: never source bodies, model names, provider errors or credentials. */
export async function runVoiceSync(options: VoiceSyncOptions, ports: VoiceSyncPorts) {
  try {
    const result = await ports.publish({ store: ports.store, http: ports.http, now: ports.now,
      dryRun: options.dryRun, initializeAbsent: options.initializeAbsent })
    const snapshot = result.status === 'conflict' ? result.winner : result.snapshot
    if (!snapshot || !['proposed', 'stored', 'conflict'].includes(result.status)
      || (options.dryRun ? result.status === 'stored' : result.status === 'proposed')
      || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1
      || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1
      || result.report.length !== BUILTIN_VOICE_PROVIDER_IDS.length) throw new Error('invalid_result')
    const providers = BUILTIN_VOICE_PROVIDER_IDS.map(providerId => {
      const matches = result.report.filter(row => row.providerId === providerId)
      const provider = snapshot.providers[providerId]
      if (matches.length !== 1 || !provider || !Array.isArray(provider.entries)) throw new Error('invalid_result')
      const row = matches[0]
      if (!['current', 'changed', 'blocked', 'runtime-owned'].includes(row.status)
        || !['complete', 'partial', 'unknown', 'not-applicable'].includes(row.discovery)
        || !['none', 'source-incomplete', 'adapter-contract'].includes(row.followUp)
        || !Number.isSafeInteger(row.pending) || row.pending < 0) throw new Error('invalid_result')
      return { providerId, status: row.status, discovery: row.discovery, pending: row.pending, followUp: row.followUp, count: provider.entries.length }
    })
    const failed = result.status === 'conflict' || providers.some(provider => provider.status === 'blocked')
    return { exitCode: failed ? 1 : 0, output: { status: result.status, mode: options.dryRun ? 'dry-run' : 'publish',
      order: { generation: snapshot.generation, sequence: snapshot.sequence }, providers } }
  } catch {
    return { exitCode: 1, output: { status: 'failed', mode: options.dryRun ? 'dry-run' : 'publish' } }
  }
}

async function main() {
  let options: VoiceSyncOptions
  try { options = parseVoiceSyncArgs(process.argv.slice(2)) }
  catch { console.log(JSON.stringify({ status: 'invalid-arguments' })); process.exitCode = 1; return }
  try {
    // The existing local-env loader's console output is deliberately suppressed: this command
    // exposes only the finite outcome below, including when a local file cannot be read.
    const { loadLocalEnvFiles } = await import('../scripts/lib/loadLocalEnv')
    const log = console.log, warn = console.warn
    let envLoadFailed = false
    try { console.log = () => {}; console.warn = () => { envLoadFailed = true }; loadLocalEnvFiles({ label: 'voice-catalog', allowedNames: ['KV_REST_API_URL', 'KV_REST_API_READ_ONLY_TOKEN', 'KV_REST_API_TOKEN'] }) }
    finally { console.log = log; console.warn = warn }
    if (envLoadFailed) throw new Error('env_load_failed')
    const [{ createGlobalVoiceCatalogStore }, { publishFreshBuiltinVoiceCatalog }] = await Promise.all([
      import('../src/lib/server/services/builtinVoiceCatalogPublisher'),
      import('../src/lib/server/services/builtinVoiceCatalogCollector')
    ])
    const result = await runVoiceSync(options, { store: createGlobalVoiceCatalogStore(), http: fetch, now: Date.now, publish: publishFreshBuiltinVoiceCatalog })
    console.log(JSON.stringify(result.output)); process.exitCode = result.exitCode
  } catch { console.log(JSON.stringify({ status: 'failed', mode: options.dryRun ? 'dry-run' : 'publish' })); process.exitCode = 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
