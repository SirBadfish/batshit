#!/usr/bin/env node
/**
 * Fails when one element hands the same CSS property to two owners: a Batshit
 * class and a Tailwind utility. See scripts/lib/style-conflicts.mjs for why
 * that silently breaks the Batshit rule, and for what the check can and cannot
 * prove.
 *
 * Usage:
 *   node scripts/check-style-conflicts.mjs                  # ratcheted check
 *   node scripts/check-style-conflicts.mjs --all            # list every finding
 *   node scripts/check-style-conflicts.mjs --json           # machine readable
 *   node scripts/check-style-conflicts.mjs --file a.svelte  # only these files
 *   node scripts/check-style-conflicts.mjs --write-baseline # accept current state
 *
 * The tree is currently CLEAN -- there is no baseline file, so any conflict
 * fails. `--write-baseline` exists only as an escape hatch for a large landing
 * that cannot be cleaned in one go; if you use it, the file it writes is a
 * visible list in the repo that may shrink and must never grow.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { analyzeFiles, appRoot, collectAppSvelteFiles, findingKey } from './lib/style-conflicts.mjs'

const BASELINE_PATH = path.join(appRoot, 'scripts', 'style-conflicts-baseline.json')

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const files = []

for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--file') continue
  const value = args[index + 1]
  if (!value) {
    console.error('--file needs a path')
    process.exit(2)
  }
  files.push(path.resolve(value))
  index += 1
}

const known = ['--all', '--json', '--file', '--write-baseline', '--no-baseline']
const unknown = [...flags].filter((flag) => !known.includes(flag))
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}`)
  process.exit(2)
}

const targeted = files.length > 0
const showAll = flags.has('--all')
const asJson = flags.has('--json')
const writeBaseline = flags.has('--write-baseline')
const useBaseline = !targeted && !flags.has('--no-baseline')

const targets = targeted ? files : await collectAppSvelteFiles()
const findings = await analyzeFiles(targets)

if (writeBaseline) {
  const counts = {}
  for (const finding of findings) {
    const key = findingKey(finding)
    counts[key] = (counts[key] ?? 0) + 1
  }
  const baseline = {
    comment:
      'Conflicts that already existed when the style-conflict check landed. ' +
      'This list may shrink, never grow. Fix an entry, then rerun with --write-baseline.',
    generated: findings.length,
    entries: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  }
  await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.log(`Wrote baseline with ${findings.length} conflicts to ${path.relative(appRoot, BASELINE_PATH)}`)
  process.exit(0)
}

let baselineEntries = {}
if (useBaseline && existsSync(BASELINE_PATH)) {
  baselineEntries = JSON.parse(await readFile(BASELINE_PATH, 'utf8')).entries ?? {}
}

const seen = new Map()
const fresh = []
for (const finding of findings) {
  const key = findingKey(finding)
  const count = (seen.get(key) ?? 0) + 1
  seen.set(key, count)
  if (count > (baselineEntries[key] ?? 0)) fresh.push(finding)
}

const fixed = Object.keys(baselineEntries).filter((key) => !seen.has(key))

if (asJson) {
  console.log(JSON.stringify({ findings, fresh, fixed, scanned: targets.length }, null, 2))
  process.exit(fresh.length > 0 ? 1 : 0)
}

function describe(finding) {
  const arrow = finding.winner === 'tailwind' ? '->' : '<-'
  return (
    `  ${finding.file}:${finding.line}  <${finding.element}>\n` +
    `    .${finding.batshitClass} { ${finding.batshitDeclaration} }  ${arrow}  ` +
    `.${finding.utilityClass} { ${finding.utilityDeclaration} }`
  )
}

function report(title, explanation, group) {
  if (group.length === 0) return
  console.log(`\n${title} (${group.length})`)
  console.log(`  ${explanation}\n`)
  const shown = showAll ? group : group.slice(0, 15)
  for (const finding of shown) console.log(describe(finding))
  if (shown.length < group.length) {
    console.log(`\n  ... and ${group.length - shown.length} more. Run with --all to list them.`)
  }
}

function reportGroups(group) {
  report(
    'OVERRIDDEN -- the Tailwind utility wins',
    'The Batshit rule is silently dead here. Drop the utility, or move its intent into the class.',
    group.filter((finding) => finding.winner === 'tailwind' && !finding.identical)
  )
  report(
    'DEAD UTILITY -- the Batshit rule wins',
    'The utility does nothing. Remove it so the markup stops implying a style it never applies.',
    group.filter((finding) => finding.winner === 'batshit' && !finding.identical)
  )
  report(
    'REDUNDANT -- both set the same value',
    'Harmless today, drifts tomorrow. Drop the utility and let the class own it.',
    group.filter((finding) => finding.identical)
  )
}

if (fresh.length > 0) {
  console.log(`Style conflicts: ${fresh.length} NEW across ${new Set(fresh.map((f) => f.file)).size} files.`)
  console.log('One element, one property, two owners. Give each property back to exactly one of them.')
  reportGroups(fresh)
  console.log(`\nScanned ${targets.length} Svelte files.`)
  process.exit(1)
}

const remaining = findings.length
if (remaining === 0) {
  console.log(`Style conflicts: none. Scanned ${targets.length} Svelte files.`)
  process.exit(0)
}

console.log(`Style conflicts: 0 new. ${remaining} known conflict${remaining === 1 ? '' : 's'} still in the baseline.`)
if (fixed.length > 0) {
  console.log(`${fixed.length} baseline entr${fixed.length === 1 ? 'y is' : 'ies are'} fixed.`)
  console.log('Run with --write-baseline to shrink the baseline.')
}
console.log('Run with --all to see the remaining work.')

if (showAll) reportGroups(findings)
process.exit(0)
