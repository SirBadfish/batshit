import { BATSHIT_THEME_CSS } from '$lib/artifacts/generateArtifactApi'

/**
 * BL-326: CSS variables an artifact reads but never receives.
 *
 * Artifacts run in their own document. The only custom properties Batshit gives them are the
 * `--batshit-*` theme tokens in `BATSHIT_THEME_CSS`; the app's own `--bs-*` tokens and shadcn names
 * (`--background`, `--border`) never reach them. A `var(--bs-surface-alt, #f5f5f5)` therefore draws
 * its fallback: the LightOn OCR panel rendered its result light gray on white. This is a static
 * scan, like the rest of the save-time checks.
 *
 * - A variable counts as defined by the page when its name appears anywhere other than inside a
 *   `var(...)`: a declaration (`--gap: 4px`, in a style block or a style attribute), a
 *   `setProperty('--gap', ...)`, a style object key, `@property --gap`. The check never flags one.
 * - References in HTML and CSS comments are ignored.
 * - A page that loads an outside stylesheet (`<link rel="stylesheet">`, `@import`) may get its
 *   variables from it (Bootstrap defines `--bs-*` of its own), so only `--batshit-*` names are
 *   judged there.
 *
 * `checkArtifactThemeVariables` compares a save with the artifact's saved versions, so only a
 * variable the save ADDS is refused (every update re-validates the whole content, BL-89); one a
 * saved version already read stays an advisory.
 */

export type UnknownArtifactThemeVariable = {
  /** The custom property the page reads, such as `--bs-surface-alt`. */
  name: string
  /** 1-based line of its first `var()` in the artifact HTML. */
  line: number
  /** The `--batshit-*` token to use instead, when one fits. */
  suggestion: string | null
}

export type ArtifactThemeVariableCheck = {
  unknown: UnknownArtifactThemeVariable[]
  /** Unknown variables this save adds. Refused while structure enforcement is on. */
  added: UnknownArtifactThemeVariable[]
  /** Unknown variables a saved version already read. Reported, never refused. */
  kept: UnknownArtifactThemeVariable[]
}

function themeRootDeclarations(css: string): Set<string> {
  const names = new Set<string>()
  const root = css.match(/:root\s*\{([\s\S]*?)\n\s*\}/)
  for (const match of (root?.[1] ?? '').matchAll(/(--batshit-[\w-]+)\s*:/g)) names.add(match[1])
  return names
}

/** The custom properties Batshit injects into every artifact. */
export const ARTIFACT_THEME_VARIABLES: ReadonlySet<string> = themeRootDeclarations(BATSHIT_THEME_CSS)

const CUSTOM_PROPERTY = /(?<![\w-])--[A-Za-z_][\w-]*/g
const VAR_REFERENCE = /var\(\s*(--[A-Za-z_][\w-]*)/g
const COMMENTS = [/<!--[\s\S]*?-->/g, /\/\*[\s\S]*?\*\//g]
const OUTSIDE_STYLESHEET = [/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i, /@import\b/i]

function blankOut(content: string, patterns: RegExp[]): string {
  let result = content
  // Keep every character's position (and so its line) while hiding what a comment says.
  for (const pattern of patterns) result = result.replace(pattern, (text) => text.replace(/[^\n]/g, ' '))
  return result
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

function referencedVariables(content: string): Map<string, number> {
  const visible = blankOut(content, COMMENTS)
  const references = new Map<string, number>()
  for (const match of visible.matchAll(VAR_REFERENCE)) {
    if (!references.has(match[1])) references.set(match[1], lineAt(content, match.index ?? 0))
  }
  return references
}

function definedVariables(content: string): Set<string> {
  const defined = new Set<string>()
  for (const match of content.matchAll(CUSTOM_PROPERTY)) {
    const before = content.slice(Math.max(0, (match.index ?? 0) - 16), match.index)
    if (/var\(\s*$/.test(before)) continue
    defined.add(match[0])
  }
  return defined
}

function unknownVariables(content: string): UnknownArtifactThemeVariable[] {
  const outsideStylesheet = OUTSIDE_STYLESHEET.some((pattern) => pattern.test(blankOut(content, COMMENTS)))
  const defined = definedVariables(content)
  const unknown: UnknownArtifactThemeVariable[] = []
  for (const [name, line] of referencedVariables(content)) {
    if (ARTIFACT_THEME_VARIABLES.has(name) || defined.has(name)) continue
    if (outsideStylesheet && !name.startsWith('--batshit-')) continue
    unknown.push({ name, line, suggestion: suggestArtifactThemeVariable(name) })
  }
  return unknown
}

export function checkArtifactThemeVariables(
  content: string | null | undefined,
  previousContents: Array<string | null | undefined>
): ArtifactThemeVariableCheck {
  const unknown = unknownVariables(typeof content === 'string' ? content : '')
  const alreadyRead = new Set<string>()
  for (const previous of previousContents) {
    if (typeof previous !== 'string') continue
    for (const name of referencedVariables(previous).keys()) alreadyRead.add(name)
  }
  return {
    unknown,
    added: unknown.filter((entry) => !alreadyRead.has(entry.name)),
    kept: unknown.filter((entry) => alreadyRead.has(entry.name))
  }
}

// The app's and shadcn's names an agent is most likely to guess, and the token that carries each.
const EXACT_SUGGESTIONS: Record<string, string> = {
  '--background': '--batshit-bg',
  '--bs-app-canvas': '--batshit-bg',
  '--foreground': '--batshit-text',
  '--bs-app-text': '--batshit-text',
  '--bs-app-title': '--batshit-text-strong',
  '--bs-app-label': '--batshit-text-secondary',
  '--bs-app-muted-text': '--batshit-muted',
  '--muted-foreground': '--batshit-muted',
  '--bs-app-faint-text': '--batshit-faint',
  '--card': '--batshit-surface',
  '--bs-app-card': '--batshit-surface',
  '--popover': '--batshit-surface-elevated',
  '--secondary': '--batshit-surface-elevated',
  '--muted': '--batshit-surface-elevated',
  '--bs-app-raised': '--batshit-surface-elevated',
  '--bs-app-inset-surface': '--batshit-surface-inset',
  '--primary': '--batshit-primary',
  '--bs-app-primary': '--batshit-primary',
  '--primary-foreground': '--batshit-primary-foreground',
  '--bs-app-primary-foreground': '--batshit-primary-foreground',
  '--primary-text': '--batshit-primary-text',
  '--bs-app-primary-text': '--batshit-primary-text',
  '--bs-app-primary-soft': '--batshit-primary-soft',
  '--bs-app-primary-faint': '--batshit-primary-faint',
  '--bs-app-primary-line': '--batshit-primary-line',
  '--ring': '--batshit-ring',
  '--border': '--batshit-border',
  '--bs-app-line': '--batshit-border',
  '--bs-app-inner-line': '--batshit-border-subtle',
  '--bs-app-line-strong': '--batshit-border-strong',
  '--input': '--batshit-field-border',
  '--bs-app-field': '--batshit-field',
  '--bs-app-field-hover': '--batshit-field-hover',
  '--bs-app-field-line': '--batshit-field-border',
  '--bs-app-field-line-hover': '--batshit-field-border-hover',
  '--destructive': '--batshit-danger',
  '--bs-app-success': '--batshit-success',
  '--radius': '--batshit-radius',
  '--font-sans': '--batshit-font',
  '--bs-font-sans': '--batshit-font',
  '--font-mono': '--batshit-font-mono',
  '--bs-font-mono': '--batshit-font-mono'
}

/** The `--batshit-*` token that most likely carries what a guessed variable meant, or null. */
export function suggestArtifactThemeVariable(name: string): string | null {
  const exact = EXACT_SUGGESTIONS[name]
  if (exact) return exact
  const words = new Set(
    name
      .replace(/^--(?:batshit|bs-app|bs|color|theme|app)-/, '--')
      .replace(/^--/, '')
      .split(/[-_]/)
      .filter(Boolean)
  )
  const has = (...candidates: string[]) => candidates.some((word) => words.has(word))

  if (has('radius', 'rounded')) return has('sm', 'small') ? '--batshit-radius-sm' : has('lg', 'large') ? '--batshit-radius-lg' : '--batshit-radius'
  if (has('font', 'family')) return has('mono', 'code') ? '--batshit-font-mono' : '--batshit-font'
  if (has('success', 'ok', 'positive')) return '--batshit-success'
  if (has('danger', 'error', 'destructive', 'negative')) return '--batshit-danger'
  if (has('warning', 'warn', 'caution')) return '--batshit-warning'
  if (has('info')) return '--batshit-info'
  if (has('ring', 'focus')) return '--batshit-ring'
  if (has('border', 'line', 'divider', 'outline', 'stroke')) {
    if (has('field', 'input')) return has('hover') ? '--batshit-field-border-hover' : '--batshit-field-border'
    if (has('subtle', 'inner', 'soft', 'light', 'faint')) return '--batshit-border-subtle'
    if (has('strong', 'bold', 'dark')) return '--batshit-border-strong'
    return '--batshit-border'
  }
  if (has('field', 'input')) return has('hover') ? '--batshit-field-hover' : '--batshit-field'
  if (has('primary', 'accent', 'brand')) {
    if (has('foreground', 'contrast', 'on')) return '--batshit-primary-foreground'
    if (has('soft')) return '--batshit-primary-soft'
    if (has('faint')) return '--batshit-primary-faint'
    if (has('hover')) return '--batshit-primary-hover'
    if (has('bg', 'background', 'fill', 'surface')) return '--batshit-primary'
    return '--batshit-primary-text'
  }
  if (has('muted')) return '--batshit-muted'
  if (has('faint', 'disabled')) return '--batshit-faint'
  if (has('text', 'foreground', 'fg', 'color', 'heading', 'title', 'label', 'ink')) {
    if (has('heading', 'title', 'strong', 'bright')) return '--batshit-text-strong'
    if (has('secondary', 'label', 'dim', 'subtle')) return '--batshit-text-secondary'
    return '--batshit-text'
  }
  if (has('surface', 'card', 'panel', 'bg', 'background', 'canvas', 'page', 'body', 'popover', 'tile')) {
    if (has('alt', 'inset', 'sunken', 'well', 'subtle', 'muted', 'secondary')) return '--batshit-surface-inset'
    if (has('elevated', 'raised', 'popover', 'overlay', 'hover', 'high')) return '--batshit-surface-elevated'
    if (has('surface', 'card', 'panel', 'tile')) return '--batshit-surface'
    return '--batshit-bg'
  }
  return null
}

const MAX_LISTED = 8

function listEntries(entries: UnknownArtifactThemeVariable[]): string {
  const listed = entries.slice(0, MAX_LISTED).map((entry) =>
    `\`${entry.name}\` (line ${entry.line}): ${entry.suggestion ? `use \`${entry.suggestion}\`` : 'use one of the `--batshit-*` tokens'}`
  )
  const more = entries.length > MAX_LISTED ? `; and ${entries.length - MAX_LISTED} more` : ''
  return listed.join('; ') + more
}

export function buildUnknownThemeVariableMessage(entries: UnknownArtifactThemeVariable[]): string {
  return (
    `The page reads CSS variables an artifact never receives, so their fallback colours are drawn instead: ${listEntries(entries)}. ` +
    'Artifacts get only the `--batshit-*` theme tokens (listed under Theme in the Artifact Creator guide) and variables the page defines itself.'
  )
}

export function buildUnknownThemeVariableAdvisory(entries: UnknownArtifactThemeVariable[]): string {
  return (
    `These CSS variables never reach an artifact, so their fallback colours are drawn instead: ${listEntries(entries)}. ` +
    'The save still works; switch them to the `--batshit-*` tokens named here.'
  )
}
