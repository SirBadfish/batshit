#!/usr/bin/env node
// The old per-skill downloads are frozen publication inputs. Both historical
// entrypoints verify their exact bytes; neither writes the published tree.
// New authoring lives in src/lib/server/system-plugins/batshit.
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frozenRoot = path.join(repoRoot, 'batshit-portable-skills')
const inventoryPath = path.join(repoRoot, 'tools/portable-skills/frozen-distribution.json')

async function main() {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : null
  if (!mode) throw new Error('Usage: node tools/portable-skills/sync-portable-skills.mjs --check|--write')
  const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'))
  if (inventory.version !== 1 || !inventory.files || typeof inventory.files !== 'object') {
    throw new Error(`Invalid frozen distribution inventory: ${inventoryPath}`)
  }
  const actual = new Map()
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        actual.set(path.relative(frozenRoot, full).split(path.sep).join('/'), createHash('sha256').update(await fs.readFile(full)).digest('hex'))
      } else throw new Error(`Frozen distribution contains a non-regular entry: ${path.relative(frozenRoot, full)}`)
    }
  }
  await walk(frozenRoot)
  const problems = []
  for (const [file, hash] of Object.entries(inventory.files)) {
    if (actual.get(file) !== hash) problems.push(`missing or changed: ${file}`)
  }
  for (const file of actual.keys()) {
    if (!Object.hasOwn(inventory.files, file)) problems.push(`unexpected file: ${file}`)
  }
  if (problems.length) throw new Error(`Frozen portable distribution differs from its published inventory:\n${problems.join('\n')}`)
  console.log(`Frozen portable distribution verified (${actual.size} files). ${mode === 'write' ? '--write performs no writes; ' : ''}Author the canonical Batshit plugin; published downloads remain unchanged.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
