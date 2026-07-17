#!/usr/bin/env node
// Syncs UserDocs pages into built-in system skill reference folders per
// tools/system-skills/userdocs-skill-references.manifest.json.
//
// Contract:
// - Every .md under a sync's sourceRoot must be listed as include or exclude,
//   so a new UserDocs page fails this script instead of silently never
//   reaching the skill.
// - Destination reference folders are pure mirrors of the manifest: --write
//   copies includes byte-for-byte and deletes unlisted files; --check exits 1
//   on any drift (content mismatch, missing copy, stale file, unlisted or
//   missing source).
// - Run this BEFORE tools/portable-skills/sync-portable-skills.mjs whenever
//   UserDocs change, because portable bundles copy from the in-app skill
//   folder this script writes.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = path.join(repoRoot, 'tools/system-skills/userdocs-skill-references.manifest.json')

function usage() {
  console.error('Usage: node tools/system-skills/sync-userdocs-skill-references.mjs --check|--write')
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

async function listMarkdownFiles(root) {
  const results = []

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(toPosix(path.relative(root, fullPath)))
      }
    }
  }

  await walk(root)
  return results.sort()
}

function validateSync(sync) {
  const errors = []
  const include = Array.isArray(sync.include) ? sync.include : []
  const exclude = Array.isArray(sync.exclude) ? sync.exclude : []

  const sources = new Set()
  const references = new Set()

  for (const entry of include) {
    if (!entry?.source || !entry?.reference) {
      errors.push(`include entry missing source/reference: ${JSON.stringify(entry)}`)
      continue
    }
    if (sources.has(entry.source)) errors.push(`duplicate source listed twice: ${entry.source}`)
    sources.add(entry.source)
    if (entry.reference.includes('/')) {
      errors.push(`reference names must be flat (no /): ${entry.reference}`)
    }
    if (references.has(entry.reference)) errors.push(`duplicate reference name: ${entry.reference}`)
    references.add(entry.reference)
  }

  for (const entry of exclude) {
    if (!entry?.source || !entry?.reason) {
      errors.push(`exclude entry missing source/reason: ${JSON.stringify(entry)}`)
      continue
    }
    if (sources.has(entry.source)) errors.push(`source listed as both include and exclude: ${entry.source}`)
    sources.add(entry.source)
  }

  return { errors, include, exclude, sources }
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

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (!manifest || !Array.isArray(manifest.syncs)) {
    throw new Error(`Invalid UserDocs skill reference manifest: ${manifestPath}`)
  }

  const problems = []
  let copied = 0
  let deleted = 0

  for (const sync of manifest.syncs) {
    const syncId = sync?.id ?? '(missing id)'
    const { errors, include, exclude, sources } = validateSync(sync)
    for (const error of errors) {
      problems.push(`[${syncId}] manifest error: ${error}`)
    }
    if (errors.length > 0) continue

    const sourceRoot = path.join(repoRoot, sync.sourceRoot)
    const destinationRoot = path.join(repoRoot, sync.destinationRoot)

    // Completeness sweep: every real .md page is deliberately included or excluded,
    // and every manifest row still points at a real page.
    const actualPages = await listMarkdownFiles(sourceRoot)
    const actualSet = new Set(actualPages)
    for (const page of actualPages) {
      if (!sources.has(page)) {
        problems.push(
          `[${syncId}] unlisted UserDocs page: ${page} — add it to include (or exclude with a reason) in ${toPosix(path.relative(repoRoot, manifestPath))}`
        )
      }
    }
    for (const source of sources) {
      if (!actualSet.has(source)) {
        problems.push(`[${syncId}] manifest lists a missing UserDocs page: ${source} — remove or fix the row`)
      }
    }

    // Mirror pass: copies match byte-for-byte; nothing unlisted lives in the destination.
    if (mode === 'write') {
      await fs.mkdir(destinationRoot, { recursive: true })
    }

    const expectedReferences = new Map(include.map((entry) => [entry.reference, entry.source]))

    for (const [reference, source] of expectedReferences) {
      const sourcePath = path.join(sourceRoot, source)
      const destinationPath = path.join(destinationRoot, reference)
      if (!actualSet.has(source)) continue // already reported above

      const sourceContent = await fs.readFile(sourcePath, 'utf8')
      let destinationContent = null
      try {
        destinationContent = await fs.readFile(destinationPath, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }

      if (destinationContent === sourceContent) continue

      if (mode === 'write') {
        await fs.writeFile(destinationPath, sourceContent, 'utf8')
        copied += 1
      } else {
        problems.push(
          `[${syncId}] reference drift: ${toPosix(path.relative(repoRoot, destinationPath))} does not match ${sync.sourceRoot}/${source}`
        )
      }
    }

    let destinationEntries = []
    try {
      destinationEntries = await fs.readdir(destinationRoot, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    for (const entry of destinationEntries) {
      if (entry.name.startsWith('.')) continue
      if (expectedReferences.has(entry.name) && entry.isFile()) continue
      const stalePath = path.join(destinationRoot, entry.name)
      if (mode === 'write') {
        await fs.rm(stalePath, { recursive: true, force: true })
        deleted += 1
      } else {
        problems.push(
          `[${syncId}] stale file in mirror: ${toPosix(path.relative(repoRoot, stalePath))} is not in the manifest`
        )
      }
    }
  }

  if (problems.length > 0) {
    console.error('UserDocs skill reference sync problems:')
    for (const problem of problems) {
      console.error(`- ${problem}`)
    }
    if (mode === 'check') {
      console.error('Run: node tools/system-skills/sync-userdocs-skill-references.mjs --write (after fixing manifest problems)')
    }
    process.exit(1)
  }

  if (mode === 'write') {
    console.log(`Synced ${copied} reference file${copied === 1 ? '' : 's'}, removed ${deleted} stale file${deleted === 1 ? '' : 's'}.`)
  } else {
    console.log('UserDocs skill references are in sync.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
