import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(appRoot)
const systemSkillSourceDir = join(appRoot, 'src', 'lib', 'server', 'system-skills')
const promptDefaultsSourceDir = join(repoRoot, 'docs', 'batshit_System_Prompts')

const serverRoots = [
  join(appRoot, 'build', 'server'),
  join(appRoot, '.svelte-kit', 'output', 'server')
]

function findVercelFunctionDirs(rootDir) {
  if (!existsSync(rootDir)) return []

  const results = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dir, entry.name)
      if (entry.name.endsWith('.func')) {
        results.push(fullPath)
        continue
      }
      visit(fullPath)
    }
  }

  visit(rootDir)
  return results
}

const vercelFunctionDirs = findVercelFunctionDirs(join(appRoot, '.vercel', 'output', 'functions'))

function copyBundle({ sourceDir, outputDirs, label }) {
  if (!existsSync(sourceDir)) {
    throw new Error(`${label} source directory not found: ${sourceDir}`)
  }

  let copied = 0

  for (const outputDir of outputDirs) {
    const parentDir = dirname(outputDir)
    const nearestExistingParent = existsSync(parentDir) ? parentDir : dirname(parentDir)
    if (!existsSync(nearestExistingParent) || !statSync(nearestExistingParent).isDirectory()) continue

    mkdirSync(parentDir, { recursive: true })
    rmSync(outputDir, { recursive: true, force: true })
    cpSync(sourceDir, outputDir, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).some((part) => part.startsWith('.'))
    })
    copied += 1
  }

  if (copied === 0) {
    console.warn(`[copy-system-skills-to-build] No compatible output directory found for ${label}.`)
  } else {
    console.log(
      `[copy-system-skills-to-build] Copied ${label} to ${copied} output director${copied === 1 ? 'y' : 'ies'}.`
    )
  }
}

copyBundle({
  sourceDir: systemSkillSourceDir,
  outputDirs: [
    ...serverRoots.map((root) => join(root, 'system-skills')),
    ...vercelFunctionDirs.map((root) => join(root, 'system-skills'))
  ],
  label: 'system skills'
})

copyBundle({
  sourceDir: promptDefaultsSourceDir,
  outputDirs: [
    ...serverRoots.map((root) => join(root, 'docs', 'batshit_System_Prompts')),
    ...vercelFunctionDirs.map((root) => join(root, 'docs', 'batshit_System_Prompts'))
  ],
  label: 'core system prompt defaults'
})
