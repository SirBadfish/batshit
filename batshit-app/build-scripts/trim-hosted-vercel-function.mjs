#!/usr/bin/env node
/**
 * Finishes the Vercel build of api.batshit.ai (BL-344). Runs after `vite build`
 * and the system-skill copy; does nothing outside a Vercel build.
 *
 * The Vercel project `batshit` builds this whole app, but its deployment serves
 * only the public registry JSON and one protected cron route:
 * `src/lib/server/services/hostedAppGuard.ts` answers every other path with 410
 * before any route code runs. Vercel's file tracer cannot see that boundary, so
 * it packs every file the app could read on a Mac or in Docker into the one
 * serverless function, and Vercel caps a function at 250 MB on every plan.
 *
 * 1. For the hosted deployment only, this removes the function's copy of
 *    `static/`. Vercel's CDN serves `static/` from `.vercel/output/static`;
 *    inside the function it is read only by the Goon Hair and Clothing
 *    repositories (`process.cwd()/static/...`), whose routes the guard blocks.
 *    That copy was about 95 MB and grows with every Goon asset.
 * 2. It prints each function's size and largest folders, and fails the build
 *    above Vercel's limit, so an overflow names its cause in the build log.
 *
 * Build-time tools live in build-scripts/, never scripts/: the app reads
 * scripts/ at runtime (the CLI helpers), so the tracer ships and parses every
 * file there, and whatever paths a tool names follow it into the function.
 */

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Vercel's uncompressed function size limit, the same on every plan. */
export const VERCEL_FUNCTION_LIMIT_BYTES = 250 * 1024 * 1024

/** Folders inside a function that the hosted deployment never reads. */
export const HOSTED_UNUSED_FOLDERS = ['static']

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isTruthy(value) {
  return TRUE_VALUES.has((value ?? '').trim().toLowerCase())
}

/** Same rule as isHostedVercelRegistryDeployment in hostedAppGuard.ts. */
export function isHostedVercelRegistryBuild(env) {
  return isTruthy(env.VERCEL) && !isTruthy(env.BATSHIT_ENABLE_HOSTED_APP)
}

/** Real function folders; the per-route `.func` entries are symlinks to them. */
export function findFunctionDirs(functionsRoot) {
  const results = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dir, entry.name)
      if (entry.name.endsWith('.func')) results.push(fullPath)
      else visit(fullPath)
    }
  }
  visit(functionsRoot)
  return results
}

/** Total bytes plus bytes per top folder (per package under node_modules). */
export function measureFunction(funcDir) {
  const folders = new Map()
  let total = 0
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      const size = lstatSync(fullPath).size
      total += size
      const parts = relative(funcDir, fullPath).split(sep)
      const depth = parts[0] === 'node_modules' ? (parts[1]?.startsWith('@') ? 3 : 2) : 1
      const key = parts.length > depth ? parts.slice(0, depth).join('/') : parts[0]
      folders.set(key, (folders.get(key) ?? 0) + size)
    }
  }
  visit(funcDir)
  const largest = [...folders].sort((a, b) => b[1] - a[1])
  return { total, largest }
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function trimHostedFunction(funcDir) {
  const removed = []
  for (const folder of HOSTED_UNUSED_FOLDERS) {
    const target = join(funcDir, folder)
    if (!existsSync(target) || !lstatSync(target).isDirectory()) continue
    const size = measureFunction(target).total
    rmSync(target, { recursive: true, force: true })
    removed.push({ folder, size })
  }
  return removed
}

/** Trims (hosted only) and reports every function; true when all fit Vercel's limit. */
export function finishVercelFunctions({ functionsRoot, env, log = console.log }) {
  const hosted = isHostedVercelRegistryBuild(env)
  const funcDirs = findFunctionDirs(functionsRoot)
  if (funcDirs.length === 0) throw new Error(`No Vercel function found under ${functionsRoot}`)

  let fits = true
  for (const funcDir of funcDirs) {
    const name = relative(functionsRoot, funcDir)
    if (hosted) {
      const removed = trimHostedFunction(funcDir)
      const summary = removed.map((item) => `${item.folder}/ (${megabytes(item.size)})`).join(', ')
      log(`[trim-hosted-vercel-function] ${name}: removed ${summary || 'nothing'} (hosted registry deployment).`)
    } else {
      log(`[trim-hosted-vercel-function] ${name}: BATSHIT_ENABLE_HOSTED_APP is on, so the full app keeps static/.`)
    }

    const { total, largest } = measureFunction(funcDir)
    const over = total > VERCEL_FUNCTION_LIMIT_BYTES
    if (over) fits = false
    log(
      `[trim-hosted-vercel-function] ${name}: ${megabytes(total)} of Vercel's ${megabytes(VERCEL_FUNCTION_LIMIT_BYTES)} limit${over ? ' -- TOO BIG' : ''}. Largest:`
    )
    for (const [folder, size] of largest.slice(0, 12)) log(`    ${megabytes(size).padStart(11)}  ${folder}`)
  }
  return fits
}

function main() {
  const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const env = process.env
  if (!isTruthy(env.VERCEL)) {
    console.log('[trim-hosted-vercel-function] Not a Vercel build; nothing to do.')
    return
  }
  if ((env.BATSHIT_SVELTE_ADAPTER ?? 'vercel') === 'node') {
    throw new Error('BATSHIT_SVELTE_ADAPTER=node on Vercel: the build wrote no Vercel function.')
  }

  const fits = finishVercelFunctions({ functionsRoot: join(appRoot, '.vercel', 'output', 'functions'), env })
  if (!fits) {
    console.error(
      '[trim-hosted-vercel-function] A function is over Vercel\'s limit. The folders above say what fills it; see BL-344 in the bug list and "What Fills The api.batshit.ai Function" in the batshit-site deep dive.'
    )
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
