/**
 * Contract test for the style-conflict check (scripts/check-style-conflicts.mjs).
 *
 * The check exists because Tailwind utilities resolve in a LATER cascade layer
 * than Batshit's own `@layer components` classes, so a utility silently beats a
 * Batshit rule that sets the same property. These fixtures run through the real
 * script against the real src/app.css -- no stubbed stylesheet -- and pin both
 * directions: the conflicts it must catch, and the ordinary Tailwind use it
 * must leave alone.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const appRoot = process.cwd()
const scriptPath = path.join(appRoot, 'scripts', 'check-style-conflicts.mjs')

interface Finding {
  file: string
  line: number
  batshitClass: string
  utilityClass: string
  property: string
  winner: 'batshit' | 'tailwind'
  identical: boolean
}

/**
 * One fixture per case. Names are asserted against, so each stays distinct.
 * `field-lane` caps a Settings field at the shared field max; `empty-state`
 * sets its own padding; the goon-cue rule is scoped by a `>` parent.
 */
const FIXTURES: Record<string, string> = {
  // The bug this check was built for: `flex-1` overrides the lane's own flex.
  'FlexFight.svelte': `<div class="batshit-settings-field-lane min-w-0 flex-1"></div>`,

  // Layout mechanics the lane class does not claim. Must stay clean.
  'LayoutMechanics.svelte': `<div class="batshit-settings-field-lane flex items-center gap-2"></div>`,

  // Shorthand vs longhand: `padding` and `padding-block` are the same pixels.
  'PaddingShorthand.svelte': `<div class="batshit-settings-empty-state py-4"></div>`,

  // Ternary arms are never on the element together, so they cannot conflict.
  'TernaryArms.svelte':
    `<div class={managedTunnelIsReady ? 'batshit-success-chip' : 'bg-sky-500/10 text-sky-300'}></div>`,

  // `.batshit-goon-cue-content > .flex.items-end` needs that exact parent.
  'WrongParent.svelte':
    `<div class="relative">\n  <div class="flex items-end gap-2 p-2"></div>\n</div>`,

  // Same rule, correct parent. Proves the ancestor check is not just "always no".
  'RightParent.svelte':
    `<div class="batshit-goon-cue-content">\n  <div class="flex items-end gap-2 p-2"></div>\n</div>`,

  // `.batshit-goon-cue-content > .flex.flex-wrap .batshit-settings-form-label`
  // is the only rule giving a form label `text-align`. Nothing here can sit
  // under that wrapper, so `text-left` fights nobody.
  'UnreachableScope.svelte':
    `<button class="batshit-settings-form-label text-left">Runtime</button>`,

  // The same label, actually inside that wrapper. Now the rule really applies.
  'ReachableScope.svelte':
    `<div class="batshit-goon-cue-content">\n  <div class="flex flex-wrap">\n` +
    `    <span class="batshit-settings-form-label text-left">Cue</span>\n  </div>\n</div>`
}

let findings: Finding[] = []
let fixtureDir = ''

function findingsFor(fixture: string): Finding[] {
  return findings.filter((finding) => path.basename(finding.file) === fixture)
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batshit-style-conflicts-'))
  const files: string[] = []

  for (const [name, contents] of Object.entries(FIXTURES)) {
    const filePath = path.join(fixtureDir, name)
    fs.writeFileSync(filePath, contents + '\n')
    files.push('--file', filePath)
  }

  const result = spawnSync('node', [scriptPath, '--json', ...files], {
    cwd: appRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })

  if (result.error) throw result.error
  // Exit code 1 just means conflicts were found, which these fixtures expect.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`check-style-conflicts exited ${result.status}: ${result.stderr}`)
  }

  findings = JSON.parse(result.stdout).findings
}, 180_000)

afterAll(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
})

describe('style conflict check', () => {
  it('catches a Tailwind utility overriding a Batshit class on the same property', () => {
    const flexFight = findingsFor('FlexFight.svelte').find((finding) => finding.utilityClass === 'flex-1')

    expect(flexFight).toBeDefined()
    expect(flexFight!.batshitClass).toBe('batshit-settings-field-lane')
    // Both sides write the `flex` shorthand, so the clash is reported against
    // one of the longhands it expands to.
    expect(flexFight!.property).toMatch(/^flex-(grow|shrink|basis)$/)
    // Utilities land in a later cascade layer, so the Batshit rule loses.
    expect(flexFight!.winner).toBe('tailwind')
    expect(flexFight!.identical).toBe(false)
  })

  it('reports a utility that merely repeats the class as redundant, not as an override', () => {
    const redundant = findingsFor('FlexFight.svelte').find((finding) => finding.utilityClass === 'min-w-0')

    expect(redundant).toBeDefined()
    expect(redundant!.property).toBe('min-width')
    expect(redundant!.identical).toBe(true)
  })

  it('leaves Tailwind alone when it sets a property no Batshit class claims', () => {
    // `batshit-settings-field-lane` owns width/flex, not display, alignment, or gap.
    expect(findingsFor('LayoutMechanics.svelte')).toEqual([])
  })

  it('matches a shorthand against the longhands it expands to', () => {
    const padding = findingsFor('PaddingShorthand.svelte')

    expect(padding.length).toBeGreaterThan(0)
    expect(padding.every((finding) => finding.utilityClass === 'py-4')).toBe(true)
    // The class writes `padding`, the utility writes `padding-block`. Different
    // names, overlapping pixels -- only longhand expansion connects them.
    expect(padding.every((finding) => /^padding-(top|bottom)$/.test(finding.property))).toBe(true)
  })

  it('does not pair classes that sit in opposite arms of a ternary', () => {
    // Only one arm ever reaches the element, so neither can override the other.
    expect(findingsFor('TernaryArms.svelte')).toEqual([])
  })

  it('does not apply a feature-scoped rule to a file that scope can never reach', () => {
    // Static-import render graph: no component carrying the wrapper class
    // renders this one, so the rule that needs it cannot be in play here.
    expect(findingsFor('UnreachableScope.svelte')).toEqual([])

    const scoped = findingsFor('ReachableScope.svelte')
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every((finding) => finding.utilityClass === 'text-left')).toBe(true)
    expect(scoped.map((finding) => finding.property)).toContain('text-align')
  })

  it('respects a child-combinator scope instead of matching on the class alone', () => {
    expect(findingsFor('WrongParent.svelte')).toEqual([])

    const scoped = findingsFor('RightParent.svelte')
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every((finding) => finding.utilityClass === 'p-2')).toBe(true)
  })
})
