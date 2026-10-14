import { describe, expect, it } from 'vitest'

import { validateArtifactHtmlPreflight } from './artifactHtmlPreflight'
import {
  ARTIFACT_THEME_VARIABLES,
  checkArtifactThemeVariables,
  suggestArtifactThemeVariable
} from './artifactThemeVariables'

// BL-326: an agent-built panel styled its OCR result with `var(--bs-surface-alt, #f5f5f5)` and
// `var(--bs-border, #e0e0e0)`. Artifacts get only Batshit's `--batshit-*` theme tokens, so the white
// fallbacks were drawn and the text was nearly unreadable. The save now names each variable an
// artifact never receives and the `--batshit-*` token to use, and never refuses one the page defines.
const OCR_PANEL = [
  '<!doctype html>',
  '<html><head><style>',
  '.result { background: var(--bs-surface-alt, #f5f5f5);',
  '  border: 1px solid var(--bs-border, #e0e0e0); color: var(--batshit-text); }',
  '</style></head>',
  '<body><div class="result"></div></body></html>'
].join('\n')

describe('the theme tokens an artifact receives', () => {
  it('are the --batshit-* tokens the runtime theme defines', () => {
    expect(ARTIFACT_THEME_VARIABLES.has('--batshit-bg')).toBe(true)
    expect(ARTIFACT_THEME_VARIABLES.has('--batshit-surface-inset')).toBe(true)
    expect(ARTIFACT_THEME_VARIABLES.has('--batshit-primary-text')).toBe(true)
    expect(ARTIFACT_THEME_VARIABLES.has('--batshit-font-mono')).toBe(true)
    expect([...ARTIFACT_THEME_VARIABLES].every((name) => name.startsWith('--batshit-'))).toBe(true)
    expect(ARTIFACT_THEME_VARIABLES.has('--bs-app-canvas')).toBe(false)
  })
})

describe('checkArtifactThemeVariables (BL-326)', () => {
  it('names each variable an artifact never receives, where it is, and the token to use', () => {
    const check = checkArtifactThemeVariables(OCR_PANEL, [])
    expect(check.unknown).toEqual([
      { name: '--bs-surface-alt', line: 3, suggestion: '--batshit-surface-inset' },
      { name: '--bs-border', line: 4, suggestion: '--batshit-border' }
    ])
    expect(check.added.map((entry) => entry.name)).toEqual(['--bs-surface-alt', '--bs-border'])
    expect(check.kept).toEqual([])
  })

  it('never flags a variable the page defines itself, however it defines it', () => {
    const page = [
      '<style>:root { --glow: #fff; } .a { color: var(--glow); }</style>',
      '<div style="--gap: 4px; margin: var(--gap)"></div>',
      "<script>document.body.style.setProperty('--row-h', '20px'); el.style.height = 'var(--row-h)';",
      "const vars = { '--tile': '8px' }; box.style.width = 'var(--tile)';</script>",
      '<style>@property --spin { syntax: "<angle>"; inherits: false; initial-value: 0deg; } .s { rotate: var(--spin); }</style>'
    ].join('\n')
    expect(checkArtifactThemeVariables(page, []).unknown).toEqual([])
  })

  it('does not flag the theme tokens themselves', () => {
    const page = '<style>body { background: var(--batshit-bg); } .c { background: var( --batshit-surface , #000); }</style>'
    expect(checkArtifactThemeVariables(page, []).unknown).toEqual([])
  })

  it('flags a --batshit-* name the theme does not have, and suggests the real one', () => {
    const check = checkArtifactThemeVariables('<style>.c { background: var(--batshit-surface-alt); }</style>', [])
    expect(check.unknown).toEqual([{ name: '--batshit-surface-alt', line: 1, suggestion: '--batshit-surface-inset' }])
  })

  it('cannot judge other names when the page loads an outside stylesheet, but still judges --batshit-* names', () => {
    const page = [
      '<link rel="stylesheet" href="https://cdn.example/bootstrap.min.css">',
      '<style>.c { color: var(--bs-primary); background: var(--batshit-card); }</style>'
    ].join('\n')
    expect(checkArtifactThemeVariables(page, []).unknown.map((entry) => entry.name)).toEqual(['--batshit-card'])
    const imported = '<style>@import url("https://cdn.example/pico.css"); .c { color: var(--pico-primary); }</style>'
    expect(checkArtifactThemeVariables(imported, []).unknown).toEqual([])
  })

  it('ignores a variable that only appears in a comment', () => {
    const page = '<!-- was var(--bs-old) --><style>/* var(--bs-older) */ .c { color: var(--batshit-text); }</style>'
    expect(checkArtifactThemeVariables(page, []).unknown).toEqual([])
  })

  it('refuses only what a save adds: a variable a saved version already read is kept', () => {
    const saved = '<style>.r { border: 1px solid var(--bs-border, #e0e0e0); }</style>'
    const check = checkArtifactThemeVariables(OCR_PANEL, [saved, null, undefined])
    expect(check.added.map((entry) => entry.name)).toEqual(['--bs-surface-alt'])
    expect(check.kept.map((entry) => entry.name)).toEqual(['--bs-border'])
  })
})

describe('suggestArtifactThemeVariable', () => {
  it.each([
    ['--bs-app-canvas', '--batshit-bg'],
    ['--background', '--batshit-bg'],
    ['--bs-app-card', '--batshit-surface'],
    ['--card-bg', '--batshit-surface'],
    ['--bs-surface-alt', '--batshit-surface-inset'],
    ['--panel-raised', '--batshit-surface-elevated'],
    ['--bs-app-text', '--batshit-text'],
    ['--muted-foreground', '--batshit-muted'],
    ['--heading-color', '--batshit-text-strong'],
    ['--bs-border', '--batshit-border'],
    ['--divider-subtle', '--batshit-border-subtle'],
    ['--input-border', '--batshit-field-border'],
    ['--input-bg', '--batshit-field'],
    ['--destructive', '--batshit-danger'],
    ['--color-error', '--batshit-danger'],
    ['--warning', '--batshit-warning'],
    ['--ring', '--batshit-ring'],
    ['--radius-lg', '--batshit-radius-lg'],
    ['--font-mono', '--batshit-font-mono'],
    ['--primary-foreground', '--batshit-primary-foreground'],
    ['--accent-text', '--batshit-primary-text']
  ])('%s -> %s', (name, token) => {
    expect(suggestArtifactThemeVariable(name)).toBe(token)
    expect(ARTIFACT_THEME_VARIABLES.has(token)).toBe(true)
  })

  it('gives no token when nothing fits', () => {
    expect(suggestArtifactThemeVariable('--sidebar-width')).toBeNull()
  })
})

describe('the save preflight (BL-326)', () => {
  it('refuses a save that adds a variable artifacts never receive, naming the token to use', () => {
    const result = validateArtifactHtmlPreflight(OCR_PANEL, { previousContents: [], refuseAddedThemeVariables: true })
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'UNKNOWN_THEME_VARIABLE', line: 3 })
    ])
    const message = result.issues[0].message
    expect(message).toContain('`--bs-surface-alt` (line 3): use `--batshit-surface-inset`')
    expect(message).toContain('`--bs-border` (line 4): use `--batshit-border`')
    expect(message).toContain('--batshit-*')
  })

  it('only advises when the variable was already saved, or when refusing is off', () => {
    const saved = OCR_PANEL
    const kept = validateArtifactHtmlPreflight(OCR_PANEL, { previousContents: [saved], refuseAddedThemeVariables: true })
    expect(kept.ok).toBe(true)
    expect(kept.advisories).toEqual([expect.objectContaining({ code: 'UNKNOWN_THEME_VARIABLE', line: 3 })])

    const off = validateArtifactHtmlPreflight(OCR_PANEL, { previousContents: [], refuseAddedThemeVariables: false })
    expect(off.ok).toBe(true)
    expect(off.advisories.map((advisory) => advisory.code)).toEqual(['UNKNOWN_THEME_VARIABLE'])

    const legacyCall = validateArtifactHtmlPreflight(OCR_PANEL)
    expect(legacyCall.ok).toBe(true)
  })

  it('says nothing for a page that uses only the theme tokens and its own variables', () => {
    const page = '<style>:root { --gap: 8px } .c { gap: var(--gap); background: var(--batshit-surface-inset); }</style>'
    const result = validateArtifactHtmlPreflight(page, { previousContents: [], refuseAddedThemeVariables: true })
    expect(result).toMatchObject({ ok: true, issues: [], advisories: [] })
  })
})
