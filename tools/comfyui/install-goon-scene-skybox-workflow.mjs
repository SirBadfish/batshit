#!/usr/bin/env node
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceWorkflow = path.join(
  repoRoot,
  'batshit-app',
  'src',
  'lib',
  'server',
  'system-skills',
  'goon-scene-creator',
  'assets',
  'comfyui',
  'qwen360-skybox-ui-workflow.json'
)
const outputFilename = 'batshit_qwen360_skybox.json'

function usage() {
  console.log(`Usage: node tools/comfyui/install-goon-scene-skybox-workflow.mjs [--target <workflow-dir>] [--dry-run]

Copies Batshit's visible Qwen 360 skybox ComfyUI workflow into a ComfyUI
user workflows folder as ${outputFilename}.

Target discovery order:
  1. --target <workflow-dir>
  2. COMFYUI_USER_WORKFLOWS_DIR or COMFYUI_WORKFLOWS_DIR
  3. COMFYUI_ROOT/user/default/workflows
  4. Windows Comfy Desktop default under LOCALAPPDATA

Examples:
  node tools/comfyui/install-goon-scene-skybox-workflow.mjs
  node tools/comfyui/install-goon-scene-skybox-workflow.mjs --target "C:\\path\\to\\ComfyUI\\user\\default\\workflows"
  node tools/comfyui/install-goon-scene-skybox-workflow.mjs --dry-run
`)
}

function parseArgs(argv) {
  const args = {
    target: '',
    dryRun: false,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }
    if (arg === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (arg === '--target') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--target requires a workflow directory path.')
      }
      args.target = value
      index += 1
      continue
    }
    if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function pushCandidate(candidates, value, label, explicit = false) {
  if (!value) return
  candidates.push({
    path: path.resolve(value),
    label,
    explicit
  })
}

function buildCandidates(targetArg) {
  const candidates = []
  pushCandidate(candidates, targetArg, '--target', true)
  pushCandidate(
    candidates,
    process.env.COMFYUI_USER_WORKFLOWS_DIR || process.env.COMFYUI_WORKFLOWS_DIR,
    'COMFYUI_USER_WORKFLOWS_DIR/COMFYUI_WORKFLOWS_DIR',
    Boolean(process.env.COMFYUI_USER_WORKFLOWS_DIR || process.env.COMFYUI_WORKFLOWS_DIR)
  )

  if (process.env.COMFYUI_ROOT) {
    pushCandidate(
      candidates,
      path.join(process.env.COMFYUI_ROOT, 'user', 'default', 'workflows'),
      'COMFYUI_ROOT/user/default/workflows',
      true
    )
  }

  if (process.env.LOCALAPPDATA) {
    pushCandidate(
      candidates,
      path.join(
        process.env.LOCALAPPDATA,
        'Comfy-Desktop',
        'ComfyUI-Installs',
        'ComfyUI',
        'ComfyUI',
        'user',
        'default',
        'workflows'
      ),
      'Windows Comfy Desktop default'
    )
  }

  if (process.env.HOME) {
    pushCandidate(
      candidates,
      path.join(process.env.HOME, 'Library', 'Application Support', 'ComfyUI', 'user', 'default', 'workflows'),
      'macOS standalone ComfyUI guess'
    )
    pushCandidate(
      candidates,
      path.join(process.env.HOME, '.config', 'ComfyUI', 'user', 'default', 'workflows'),
      'Linux standalone ComfyUI guess'
    )
  }

  return candidates
}

async function pickTarget(candidates) {
  for (const candidate of candidates) {
    if (candidate.explicit) return candidate
    const stats = await stat(candidate.path).catch(() => null)
    if (stats?.isDirectory()) return candidate
  }
  return null
}

async function sha256(filePath) {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

function timestampForBackup() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '-')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }

  if (!existsSync(sourceWorkflow)) {
    throw new Error(`Source workflow not found: ${sourceWorkflow}`)
  }

  const target = await pickTarget(buildCandidates(args.target))
  if (!target) {
    throw new Error(
      [
        'Could not find a ComfyUI user workflows folder.',
        'Pass one explicitly with --target <workflow-dir>, or set COMFYUI_USER_WORKFLOWS_DIR.',
        `Source workflow: ${sourceWorkflow}`
      ].join(' ')
    )
  }

  const destinationDir = target.path
  const destination = path.join(destinationDir, outputFilename)
  const sourceHash = await sha256(sourceWorkflow)
  const destinationExists = existsSync(destination)
  const destinationHash = destinationExists ? await sha256(destination) : ''

  console.log(`Source: ${sourceWorkflow}`)
  console.log(`Target (${target.label}): ${destination}`)

  if (destinationHash === sourceHash) {
    console.log('Workflow already installed and up to date.')
    return
  }

  if (args.dryRun) {
    console.log(destinationExists ? 'Dry run: would back up and replace existing workflow.' : 'Dry run: would install workflow.')
    return
  }

  await mkdir(destinationDir, { recursive: true })

  if (destinationExists) {
    const backupPath = `${destination}.${timestampForBackup()}.bak`
    await copyFile(destination, backupPath)
    console.log(`Backed up existing workflow: ${backupPath}`)
  }

  await copyFile(sourceWorkflow, destination)
  console.log(`Installed workflow: ${destination}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
