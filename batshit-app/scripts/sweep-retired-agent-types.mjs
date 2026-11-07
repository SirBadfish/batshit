#!/usr/bin/env node
// SA-139 R4 add-on (Josh, 2026-10-27): ONE-TIME sweep of what the retired agent types left in an
// instance's Redis (Codex CLI, the Claude Code CLI Primary, the n8n Subagent types). The logic and
// the family list live in `src/lib/server/services/retiredTypeSweep.ts`; this file only loads it
// through Vite's server loader (the app's own `$lib` and `$env` modules, so every delete runs
// through the app's own owners) and guards the run.
//
// Dry run (the default; changes nothing):
//   node scripts/sweep-retired-agent-types.mjs --env-file RUNTIME_ENV --expect-redis 127.0.0.1:5639/0
// Apply (only the plan the dry run printed, after a backup):
//   node scripts/sweep-retired-agent-types.mjs --env-file RUNTIME_ENV --expect-redis 127.0.0.1:5639/0 \
//     --apply --plan PLAN_ID --backup BACKUP_ZIP [--chats delete|keep]
//
// Guards:
// - The run uses ONLY the env file's variables (the app's own `runtime.env`): the script starts
//   itself again with an environment made of that file plus PATH, HOME and the locale, in the app
//   folder. Node's env-file reader is used, so a quoted value loses its quotes and an unquoted `#`
//   starts a comment (the supervisor writes plain values; no current value is affected).
// - Redis must be exactly the host, port and database named by --expect-redis; batshit-server
//   must be on this computer (loopback). No secret is printed.
// - The app folder must hold no `.env` files (the server loader would read them too) and its
//   node_modules must match its package-lock.json: run it from a fresh checkout of main.
// - The Batshit that serves this Redis must already have SA-139 R4 and have started at least once
//   on this instance: the plan refuses while the old Claude Code CLI Primary prompt is stored (an
//   older app seeds it at every start; R4's first start removes it).
// - An apply needs a complete Batshit backup of this instance's owner, made in the last 12 hours.
// - The Batshit app stays open during the run: both record owners delete avatar pictures through
//   batshit-server. Josh does not use Batshit and changes no settings while it runs.

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BACKUP_MAX_AGE_MS = 12 * 60 * 60 * 1000
const REDIS_ANSWER_MS = 8_000
const CHILD_MARK = 'BATSHIT_RETIRED_SWEEP_CHILD'
const KEPT_PROCESS_VARS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']

function fail(message) {
  console.error(`Stopped: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { envFile: null, expectRedis: null, apply: false, plan: null, backup: null, chats: null }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail(`${flag} needs a value.`)
      return value
    }
    if (flag === '--env-file') args.envFile = next()
    else if (flag === '--expect-redis') args.expectRedis = next()
    else if (flag === '--apply') args.apply = true
    else if (flag === '--plan') args.plan = next()
    else if (flag === '--backup') args.backup = next()
    else if (flag === '--chats') args.chats = next()
    else fail(`unknown flag ${flag}.`)
  }
  if (!args.envFile) fail('--env-file is required: the app\'s own environment file (runtime.env).')
  if (!args.expectRedis) fail('--expect-redis host:port/db is required, for example 127.0.0.1:5639/0.')
  if (args.chats !== null && args.chats !== 'delete' && args.chats !== 'keep') fail('--chats takes delete or keep.')
  if (!args.apply && (args.plan || args.backup || args.chats)) fail('--plan, --backup and --chats are for --apply only.')
  if (args.apply && !args.plan) fail('--apply needs --plan with the plan id the dry run printed.')
  if (args.apply && !args.backup) fail('--apply needs --backup with a Batshit backup file of this instance, made in the last 12 hours.')
  return args
}

/** host:port/db of a Redis URL, without user or password. */
function redisTarget(url) {
  let parsed
  try { parsed = new URL(url) } catch { fail('REDIS_URL in the env file is not a URL.') }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') fail('REDIS_URL in the env file is not a redis:// URL.')
  const db = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.slice(1) : '0'
  return `${parsed.hostname}:${parsed.port || '6379'}/${db}`
}

/** host:port of batshit-server, which must be on this computer. */
function serverTarget(url) {
  if (!url) fail('the env file names no BATSHIT_SERVER_URL.')
  let parsed
  try { parsed = new URL(url) } catch { fail('BATSHIT_SERVER_URL in the env file is not a URL.') }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) fail(`BATSHIT_SERVER_URL points at ${parsed.host}, not this computer.`)
  return parsed.host
}

/** Every package the lock file names must be installed at the locked version (optional ones may be absent). */
function checkInstalledPackages() {
  const hiddenPath = path.join(appRoot, 'node_modules', '.package-lock.json')
  if (!existsSync(hiddenPath)) fail(`${hiddenPath} is missing. Run npm ci in ${appRoot} first.`)
  const locked = JSON.parse(readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8')).packages ?? {}
  const installed = JSON.parse(readFileSync(hiddenPath, 'utf8')).packages ?? {}
  const wrong = []
  for (const [where, entry] of Object.entries(locked)) {
    if (!where || entry.link) continue
    const got = installed[where]
    if (!got) { if (!entry.optional && !entry.devOptional && !entry.peer) wrong.push(`${where} (missing)`) }
    else if (got.version !== entry.version) wrong.push(`${where} (${got.version}, locked ${entry.version})`)
  }
  if (wrong.length) fail(`node_modules does not match package-lock.json (${wrong.length}: ${wrong.slice(0, 3).join(', ')}). Run npm ci in ${appRoot} first.`)
}

/** Reads only `manifest.json` from a Batshit backup zip. */
async function readBackupManifest(file) {
  const yauzl = createRequire(path.join(appRoot, 'package.json'))('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (openError) return reject(new Error(`the backup is not a readable zip (${openError.message}).`))
      let found = false
      const done = (error, value) => { zip.close(); if (error) reject(error); else resolve(value) }
      zip.on('error', (error) => done(new Error(`the backup could not be read (${error.message}).`)))
      zip.on('end', () => { if (!found) done(new Error('the backup has no manifest.json.')) })
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'manifest.json') return zip.readEntry()
        found = true
        if (entry.uncompressedSize > 4 * 1024 * 1024) return done(new Error('the backup manifest is too large.'))
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return done(new Error(`the backup manifest could not be read (${streamError.message}).`))
          const chunks = []
          stream.on('data', (chunk) => chunks.push(chunk))
          stream.on('error', (error) => done(new Error(`the backup manifest could not be read (${error.message}).`)))
          stream.on('end', () => {
            try { done(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(new Error('the backup manifest is not JSON.')) }
          })
        })
      })
      zip.readEntry()
    })
  })
}

/** A complete Batshit backup of this plan's owner, made in the last 12 hours. Answers a line for the log. */
async function checkBackup(file, plan) {
  if (!existsSync(file) || !statSync(file).isFile()) fail(`the backup ${file} is not a file.`)
  let manifest
  try { manifest = await readBackupManifest(file) } catch (error) { fail(error.message) }
  if (manifest?.app?.name !== 'Batshit') fail('the backup is not a Batshit backup.')
  if (manifest.schemaVersion !== 1 || manifest.completeness !== undefined) fail('the backup is a partial backup. Make a complete backup first.')
  const created = Date.parse(manifest.createdAt)
  if (!Number.isFinite(created)) fail('the backup has no creation time.')
  const age = Date.now() - created
  if (age > BACKUP_MAX_AGE_MS || age < -5 * 60 * 1000) fail(`the backup was made at ${manifest.createdAt}, not in the last 12 hours. Make a fresh backup first.`)
  if (!(Number(manifest.contents?.redisRecordCount) > 0)) fail('the backup holds no records.')
  const owners = [...new Set(plan.items.filter((item) => item.userId && !item.ownerless).map((item) => item.userId))]
  const backupOwner = manifest.source?.userId
  if (typeof backupOwner !== 'string' || !backupOwner) fail('the backup names no owner.')
  if (owners.some((owner) => owner !== backupOwner)) fail('the backup is of another user than the records this plan deletes.')
  // A plan of keys only names no owner; the backup must still be of this instance's user.
  if (!plan.instanceOwners.length) fail('this instance has no agent records, so the backup cannot be tied to its user.')
  if (!plan.instanceOwners.includes(backupOwner)) fail('the backup is of another user than this instance\'s.')
  return `${file} (made ${manifest.createdAt}, ${manifest.contents.redisRecordCount} records, complete)`
}

// The restarted run carries a one-time token in its argument list and its environment; a shell
// that sets the environment name alone does not skip the clean restart.
const rawArgs = process.argv.slice(2)
const isChild = rawArgs[0] === '--child-token' && Boolean(rawArgs[1]) && process.env[CHILD_MARK] === rawArgs[1]
const args = parseArgs(isChild ? rawArgs.slice(2) : rawArgs)

if (!isChild) {
  // Start again with only the env file's variables, in the app folder (SvelteKit reads its
  // config and `.env` folder from the current directory).
  if (!existsSync(args.envFile)) fail(`the env file ${args.envFile} does not exist.`)
  let fileVars
  try { fileVars = parseEnv(readFileSync(args.envFile, 'utf8')) } catch (error) { fail(`the env file could not be read (${error.message}).`) }
  const env = Object.fromEntries(KEPT_PROCESS_VARS.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]))
  const token = randomUUID()
  Object.assign(env, fileVars, { [CHILD_MARK]: token })
  // Paths are made absolute here: the restarted run works in the app folder.
  const childArgs = ['--child-token', token, '--env-file', path.resolve(args.envFile), '--expect-redis', args.expectRedis,
    ...(args.apply ? ['--apply', '--plan', args.plan, '--backup', path.resolve(args.backup)] : []),
    ...(args.chats ? ['--chats', args.chats] : [])]
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), ...childArgs], { env, cwd: appRoot, stdio: 'inherit' })
  if (child.error) fail(`the sweep could not start (${child.error.message}).`)
  process.exit(child.status ?? 2)
}

for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
  if (existsSync(path.join(appRoot, name))) fail(`${path.join(appRoot, name)} exists. Run this from a fresh checkout of main with no .env files, so only the env file you name is read.`)
}
if (!process.env.REDIS_URL) fail('the env file names no REDIS_URL.')
const target = redisTarget(process.env.REDIS_URL)
if (target !== args.expectRedis) fail(`the env file points at Redis ${target}, not ${args.expectRedis}. Nothing was read.`)
const server = serverTarget(process.env.BATSHIT_SERVER_URL)
checkInstalledPackages()

const { createServer } = await import(createRequire(path.join(appRoot, 'package.json')).resolve('vite'))
const vite = await createServer({
  root: appRoot, configFile: path.join(appRoot, 'vite.config.ts'), logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { disabled: true, noDiscovery: true, include: [] },
  appType: 'custom',
})

let exitCode = 0
try {
  const { redis } = await vite.ssrLoadModule('/src/lib/server/redis.ts')
  const silent = setTimeout(() => {
    console.error(`Stopped: Redis ${target} does not answer. Nothing was changed.`)
    process.exit(2)
  }, REDIS_ANSWER_MS)
  await redis.execute((client) => client.ping())
  clearTimeout(silent)

  const sweep = await vite.ssrLoadModule('/src/lib/server/services/retiredTypeSweep.ts')
  const print = (plan, heading) => {
    console.log(heading)
    console.log(`Redis: ${target}   batshit-server: ${server}`)
    for (const family of sweep.RETIRED_TYPE_SWEEP_FAMILIES) {
      const items = plan.items.filter((item) => item.family === family.id)
      console.log(`\n${family.title}: ${items.length}`)
      console.log(`  keys: ${family.pattern}`)
      console.log(`  removed by: ${family.owner}`)
      for (const item of items) {
        console.log(`  - ${item.key}  ${item.label}${item.ownerless ? '  NO OWNER: listed only, never deleted by this sweep' : ''}`)
        if (item.primary) {
          const p = item.primary
          console.log(`      chats: ${p.chats} regular, ${p.infiniteSessions} Infinite Session(s); locked chats always kept: ${p.keptLockedChats}; saved memories: ${p.memories}`)
          if (p.chatTitles.length) console.log(`      with --chats delete these go: ${p.chatTitles.map((title) => JSON.stringify(title)).join(', ')}${p.chats + p.infiniteSessions > p.chatTitles.length ? ', ...' : ''}`)
        }
        const folderLine = (what, folder) => folder.sharedWith
          ? `      ${what}, kept (another record also uses it: ${folder.sharedWith}): ${folder.path}`
          : `      ${what}, removed (backups do not carry it): ${folder.path} (${folder.exists ? 'exists' : 'absent'})`
        if (item.profileFolder) console.log(folderLine('profile folder', item.profileFolder))
        for (const folder of item.workerFolders ?? []) console.log(folderLine('Worker slot folder', folder))
      }
    }
    console.log('\nKept on purpose (counted, never changed):')
    for (const entry of plan.kept) console.log(`  - ${entry.what}: ${entry.count} (${entry.reason})`)
    console.log('\nA Batshit backup cannot bring back the profile folders, and a restore leaves the removed families\' keys out.')
    if (plan.blockers.length) {
      console.log('\nTHE APPLY IS REFUSED ON THIS INSTANCE NOW:')
      for (const blocker of plan.blockers) console.log(`  - ${blocker}`)
    }
    console.log(`\nPlan: ${plan.planId} (${plan.items.length} item${plan.items.length === 1 ? '' : 's'})`)
  }

  if (!args.apply) {
    const plan = await sweep.planRetiredTypeSweep()
    print(plan, 'Retired-type sweep: DRY RUN (nothing was changed)')
    const needsChats = plan.items.some((item) => item.family === 'retired-primary-agents' && !item.ownerless)
    if (!plan.blockers.length) {
      console.log('\nTo apply exactly this plan, after a complete backup (put the backup file\'s path in place of BACKUP_ZIP' +
        (needsChats ? ', and delete or keep in place of CHATS_CHOICE' : '') + '):')
      console.log(`  node scripts/sweep-retired-agent-types.mjs --env-file ${JSON.stringify(args.envFile)} --expect-redis ${target} --apply --plan ${plan.planId} --backup BACKUP_ZIP${needsChats ? ' --chats CHATS_CHOICE' : ''}`)
      if (needsChats) console.log('  --chats delete removes the chats listed above with their agent; --chats keep leaves every chat without its agent.')
    }
  } else {
    const before = await sweep.planRetiredTypeSweep()
    if (before.blockers.length) throw new Error(`Nothing was deleted. ${before.blockers.join(' ')}`)
    if (before.planId !== args.plan) throw new Error(`The instance changed since the dry run (plan ${before.planId}, expected ${args.plan}). Nothing was deleted. Run the dry run again.`)
    console.log(`Backup: ${await checkBackup(args.backup, before)}`)
    const result = await sweep.applyRetiredTypeSweep({ expectedPlanId: args.plan, chats: args.chats })
    console.log(`\nDeleted ${result.done.length} of ${result.plan.items.filter((item) => !item.ownerless).length} items; ${result.gone.length} were already gone.`)
    for (const item of result.done) console.log(`  done: ${item.key}  ${item.label}`)
    for (const item of result.gone) console.log(`  already gone: ${item.key}  ${item.label}`)
    if (result.failed) {
      exitCode = 1
      console.log(`\nStopped at ${result.failed.item.key}: ${result.failed.error}`)
      console.log('That item may be partly cleaned: its owner can remove chats, pictures or references before it fails.')
      console.log('Everything listed as done above is gone. Nothing after the stopped item was touched. Fix the cause and run the dry run again.')
    }
    // The deletes ran in this process; the open app learns of them only through Redis.
    console.log('\nReload Batshit (or quit and open it) before you look; what the script listed as done is gone.')
    print(await sweep.planRetiredTypeSweep(), '\nAfter the apply, the same families now count:')
  }
} catch (error) {
  exitCode = 1
  console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  try {
    const { disconnectAllRedisServices } = await vite.ssrLoadModule('/src/lib/server/redis.ts')
    await disconnectAllRedisServices?.()
  } catch { /* the loader may not have reached Redis */ }
  await vite.close()
}
process.exit(exitCode)
