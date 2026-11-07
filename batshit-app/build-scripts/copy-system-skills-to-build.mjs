import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(appRoot)
const systemPluginSourceDir = join(appRoot, 'src', 'lib', 'server', 'system-plugins')
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

function copyBundle({ sourceDir, outputDirs, label, pluginManifests = false }) {
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
      filter: (source) => {
        if (lstatSync(source).isSymbolicLink()) return false
        const parts = relative(sourceDir, source).split(/[\\/]/)
        return !parts.some((part, index) => part.startsWith('.') && !(
          pluginManifests && index === 1 && part === '.claude-plugin' &&
          (parts.length === 2 || (parts.length === 3 && parts[2] === 'plugin.json'))
        ))
      }
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
  sourceDir: systemPluginSourceDir,
  outputDirs: [
    ...serverRoots.map((root) => join(root, 'system-plugins')),
    ...vercelFunctionDirs.map((root) => join(root, 'system-plugins'))
  ],
  label: 'system plugins',
  pluginManifests: true
})

// Incremental builds must not keep the superseded authored bundle beside the
// canonical package. Only generated output roots are eligible for this cleanup.
for (const root of [...serverRoots, ...vercelFunctionDirs]) {
  if (existsSync(join(root, 'system-plugins'))) rmSync(join(root, 'system-skills'), { recursive: true, force: true })
}

copyBundle({
  sourceDir: promptDefaultsSourceDir,
  outputDirs: [
    ...serverRoots.map((root) => join(root, 'docs', 'batshit_System_Prompts')),
    ...vercelFunctionDirs.map((root) => join(root, 'docs', 'batshit_System_Prompts'))
  ],
  label: 'core system prompt defaults'
})
