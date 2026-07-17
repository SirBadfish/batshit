#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = path.join(repoRoot, 'batshit-portable-skills/portable-skills.manifest.json')

function usage() {
  console.error('Usage: node tools/portable-skills/sync-portable-skills.mjs --check|--write')
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function sameFile(left, right) {
  try {
    const [leftRaw, rightRaw] = await Promise.all([
      fs.readFile(left, 'utf8'),
      fs.readFile(right, 'utf8')
    ])
    return leftRaw === rightRaw
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

async function syncFile({ source, destination, write }) {
  const matches = await sameFile(source, destination)
  if (matches) return { changed: false, destination }
  if (!write) return { changed: true, destination }

  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
  return { changed: true, destination }
}

async function main() {
  const mode = process.argv.includes('--write')
    ? 'write'
    : process.argv.includes('--check')
      ? 'check'
      : null

  if (!mode) {
    usage()
    process.exit(2)
  }

  const manifest = await readJson(manifestPath)
  if (!manifest || !Array.isArray(manifest.bundles)) {
    throw new Error(`Invalid portable skills manifest: ${manifestPath}`)
  }

  const drifted = []
  let copied = 0

  for (const bundle of manifest.bundles) {
    if (!bundle || typeof bundle !== 'object') continue
    const sourceRoot = path.join(repoRoot, bundle.sourceSkillRoot)
    const portableRoot = path.join(repoRoot, bundle.portableRoot)
    const references = Array.isArray(bundle.sharedReferences) ? bundle.sharedReferences : []
    const files = Array.isArray(bundle.sharedFiles) ? bundle.sharedFiles : []

    for (const relativeFile of [...references, ...files]) {
      const source = path.join(sourceRoot, relativeFile)
      const destination = path.join(portableRoot, relativeFile)
      const result = await syncFile({
        source,
        destination,
        write: mode === 'write'
      })
      if (result.changed) {
        if (mode === 'write') {
          copied += 1
        } else {
          drifted.push(toPosix(path.relative(repoRoot, result.destination)))
        }
      }
    }
  }

  if (mode === 'check' && drifted.length > 0) {
    console.error('Portable skill reference drift detected:')
    for (const file of drifted) {
      console.error(`- ${file}`)
    }
    console.error('Run: node tools/portable-skills/sync-portable-skills.mjs --write')
    process.exit(1)
  }

  if (mode === 'write') {
    console.log(`Synced ${copied} portable skill file${copied === 1 ? '' : 's'}.`)
  } else {
    console.log('Portable skill files are in sync.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
