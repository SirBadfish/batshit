/**
 * Contract test for build-scripts/trim-hosted-vercel-function.mjs (BL-344).
 *
 * api.batshit.ai is this whole app built for Vercel, but it serves only the
 * registry JSON and one cron route. The build step removes the function's
 * copy of static/ for that hosted deployment, keeps it when the full hosted
 * app is switched on, and fails the build with a size breakdown when a
 * function is over Vercel's 250 MB limit.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VERCEL_FUNCTION_LIMIT_BYTES,
  finishVercelFunctions,
  isHostedVercelRegistryBuild
} from '../../../build-scripts/trim-hosted-vercel-function.mjs'
import { isHostedVercelRegistryDeployment } from '$lib/server/services/hostedAppGuard'

let root: string
let functionsRoot: string
let funcDir: string

function writeFile(relativePath: string, content = 'x') {
  const fullPath = path.join(funcDir, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
}

function run(env: Record<string, string | undefined>) {
  const lines: string[] = []
  const fits = finishVercelFunctions({ functionsRoot, env, log: (line: string) => lines.push(line) })
  return { fits, output: lines.join('\n') }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'batshit-trim-vercel-'))
  functionsRoot = path.join(root, 'functions')
  funcDir = path.join(functionsRoot, '![-]', 'catchall.func')
  writeFile('.svelte-kit/output/server/index.js', 'export {}')
  writeFile('node_modules/redis/index.js', 'module.exports = {}')
  writeFile('static/goons/stunt-dummy.vrm', 'v'.repeat(4096))
  writeFile('static/goon-assets/hair/v2/catalog.json', '{}')
  // SvelteKit links each route's .func to the one real function folder.
  fs.symlinkSync(path.join('![-]', 'catchall.func'), path.join(functionsRoot, 'index.func'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('trim-hosted-vercel-function', () => {
  it('uses the same hosted rule as hostedAppGuard', () => {
    const envs = [
      {},
      { VERCEL: '1' },
      { VERCEL: 'true', BATSHIT_ENABLE_HOSTED_APP: '0' },
      { VERCEL: '1', BATSHIT_ENABLE_HOSTED_APP: '1' },
      { VERCEL: '1', BATSHIT_ENABLE_HOSTED_APP: 'yes' },
      { BATSHIT_ENABLE_HOSTED_APP: '1' }
    ]
    for (const env of envs) {
      expect(isHostedVercelRegistryBuild(env)).toBe(isHostedVercelRegistryDeployment(env))
    }
  })

  it('removes static/ from the hosted registry function and keeps the rest', () => {
    const { fits, output } = run({ VERCEL: '1' })

    expect(fits).toBe(true)
    expect(fs.existsSync(path.join(funcDir, 'static'))).toBe(false)
    expect(fs.existsSync(path.join(funcDir, '.svelte-kit/output/server/index.js'))).toBe(true)
    expect(fs.existsSync(path.join(funcDir, 'node_modules/redis/index.js'))).toBe(true)
    expect(output).toContain('![-]/catchall.func: removed static/')
    // The symlinked route entry is not a second function.
    expect(output).not.toContain('index.func')
  })

  it('keeps static/ when the full hosted app is switched on', () => {
    const { fits, output } = run({ VERCEL: '1', BATSHIT_ENABLE_HOSTED_APP: '1' })

    expect(fits).toBe(true)
    expect(fs.existsSync(path.join(funcDir, 'static/goons/stunt-dummy.vrm'))).toBe(true)
    expect(output).toContain('the full app keeps static/')
  })

  it('reports a function over the limit and names what fills it', () => {
    // A sparse file: its size counts, but it takes no disk space.
    const big = path.join(funcDir, 'node_modules/huge-package/blob.bin')
    fs.mkdirSync(path.dirname(big), { recursive: true })
    fs.writeFileSync(big, '')
    fs.truncateSync(big, VERCEL_FUNCTION_LIMIT_BYTES + 1)

    const { fits, output } = run({ VERCEL: '1' })

    expect(fits).toBe(false)
    expect(output).toContain('TOO BIG')
    expect(output).toMatch(/250\.00 MB\s+node_modules\/huge-package/)
  })

  it('fails loudly when the build wrote no function', () => {
    fs.rmSync(functionsRoot, { recursive: true, force: true })
    fs.mkdirSync(functionsRoot)

    expect(() => run({ VERCEL: '1' })).toThrow('No Vercel function found')
  })
})
