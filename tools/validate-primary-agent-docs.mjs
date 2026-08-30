#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const repoRoot = process.cwd()
const execFileAsync = promisify(execFile)

const forbidden = [
  {
    label: 'three Primary Agent types',
    pattern: /\bthree\b[^\n]{0,80}\bPrimary Agent types?\b/i
  },
  {
    label: 'n8n included in the live Primary Agent type list',
    pattern: /\bPrimary Agent types?\s+(?:are|include)[^.\n]{0,80}\bn8n\b/i
  },
  {
    label: 'n8n/API/CLI described as Primary parity',
    pattern: /(?:n8n\s*\/\s*API\s*\/\s*CLI|API\s*\/\s*CLI\s*\/\s*n8n|n8n\s*,\s*API\s*,\s*(?:and\s+)?CLI)[^\n]{0,80}\bPrimary/i
  },
  {
    label: 'n8n described as the main chat agent',
    pattern: /\bmain agent\b[^\n]{0,80}\bn8n workflow\b/i
  },
  {
    label: 'three-type selector badge copy',
    pattern: /\bbadge\b[^\n]{0,100}`n8n`[^\n]{0,40}`API`[^\n]{0,40}`CLI`/i
  },
  {
    label: 'retired browser-built n8n compiler path',
    pattern: /\bbrowser-(?:built|compiled) n8n (?:payload )?path\b/i
  },
  {
    label: 'retired client n8n compiler path',
    pattern: /\bclient n8n path\b/i
  },
  {
    label: 'retired n8n Primary stream flow',
    pattern: /\*\*n8n Flow:\*\*/i
  },
  {
    label: 'retired n8n Primary zip finalization path',
    pattern: /\bn8n (?:end-stage zip repair|Zip Fixes)\b/i
  },
  {
    label: 'retired three-value live agentType contract',
    pattern: /agentType:\s*'n8n'\s*\|\s*'api'\s*\|\s*'cli'/i
  },
  {
    label: 'n8n advertised as Primary-agent support',
    pattern: /Primary-agent support:\*\*\s*`n8n`/i
  }
]

async function exists(relativePath) {
  try {
    await fs.access(path.join(repoRoot, relativePath))
    return true
  } catch {
    return false
  }
}

async function listTrackedMarkdown() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z', '*.md'], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer'
  })
  return stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

function isCurrentDocumentation(relativePath) {
  if (relativePath === 'README.md') return true
  if (relativePath.startsWith('docs/user-docs/')) return true
  if (relativePath.startsWith('docs/batshit_System_Prompts/')) return true
  if (relativePath.startsWith('batshit-portable-skills/')) return true
  if (relativePath.includes('/system-skills/')) return true
  if (relativePath.endsWith('/AGENTS.md')) return true
  if (relativePath.includes('/dev-doc/architecture/')) return true
  if (relativePath.startsWith('.agents/memories/')) return true
  if (relativePath.startsWith('.agents/skills/')) return true

  const qaMarker = '/dev-doc/qa/'
  const qaIndex = relativePath.indexOf(qaMarker)
  if (qaIndex === -1) return false
  const qaRelative = relativePath.slice(qaIndex + qaMarker.length)
  if (qaRelative.includes('/')) return false
  return !/(?:ledger|pre-launch|launchgate|review-packet)/i.test(qaRelative)
}

async function requireText(relativePath, needle, label) {
  const content = await fs.readFile(path.join(repoRoot, relativePath), 'utf8')
  if (!content.includes(needle)) {
    throw new Error(`${relativePath}: missing ${label}`)
  }
}

const files = [...new Set((await listTrackedMarkdown()).filter(isCurrentDocumentation))].sort()
const violations = []

for (const relativePath of files) {
  const content = await fs.readFile(path.join(repoRoot, relativePath), 'utf8')
  for (const rule of forbidden) {
    const match = content.match(rule.pattern)
    if (!match) continue
    const line = content.slice(0, match.index).split('\n').length
    violations.push(`${relativePath}:${line}: ${rule.label}`)
  }
}

await requireText(
  'docs/user-docs/primary-agents/overview.md',
  'Batshit has two Primary Agent types: `API` and `CLI`.',
  'the two-type Primary Agent contract'
)
await requireText(
  'docs/user-docs/primary-agents/overview.md',
  'n8n is not a Primary Agent type.',
  'the n8n retirement boundary'
)
await requireText(
  'batshit-app/src/lib/server/system-skills/batshit-guide/SKILL.md',
  'The live Primary Agent types are exactly **API** and **CLI**.',
  'the Batshit Guide two-type rule'
)

for (const prompt of [
  'docs/batshit_System_Prompts/batshit_primary_agent_api_system_prompt.md',
  'docs/batshit_System_Prompts/batshit_primary_agent_cli_system_prompt.md'
]) {
  await requireText(prompt, 'exactly two live Primary Agent types: **API** and **CLI**', 'the compiled-prompt two-type rule')
  await requireText(prompt, 'n8n is not a Primary Agent type', 'the compiled-prompt n8n boundary')
}

const teamInstructions = files.find((relativePath) => relativePath.endsWith('/AGENTS.md'))
if (teamInstructions && (await exists(teamInstructions))) {
  await requireText(teamInstructions, 'Batshit exposes two user-facing Primary Agent types.', 'the team-instruction two-type rule')
}

const promptDefaults = (await fs.readdir(path.join(repoRoot, 'docs/batshit_System_Prompts'))).filter((name) =>
  /primary_agent_n8n/i.test(name)
)
if (promptDefaults.length > 0) {
  violations.push(`docs/batshit_System_Prompts: retired n8n Primary prompt file(s): ${promptDefaults.join(', ')}`)
}

const promptRegistry = await fs.readFile(
  path.join(repoRoot, 'batshit-app/src/lib/server/services/systemPromptRegistry.ts'),
  'utf8'
)
if (/['"]n8n_primary['"]/.test(promptRegistry)) {
  violations.push('batshit-app/src/lib/server/services/systemPromptRegistry.ts: retired n8n Primary prompt registry entry')
}

if (violations.length > 0) {
  console.error('Primary Agent documentation contract violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`Primary Agent documentation contract clean (${files.length} Markdown files scanned).`)
