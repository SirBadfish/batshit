/**
 * BL-98 guard: a colour function may wrap `var(--x)` only when `--x` is a bare channel list.
 *
 * Batshit's colour tokens are complete colours (`oklch(...)`, `color-mix(...)`, or an alias of
 * one), so `hsl(var(--border))` becomes `hsl(oklch(...))` once the variable is substituted. That
 * is invalid at computed-value time, and the browser treats the declaration as `unset`: a
 * border vanishes, a background goes see-through, a focus ring disappears, text inherits a
 * colour it was never given. No console error, no build error, no style-gate failure. Twenty
 * such declarations outlived the move from shadcn's HSL-triplet tokens to OKLCH until BL-98.
 *
 * `hsl(var(--x))` stays legal for a token whose every definition is a channel list such as
 * `220 14% 96%`; the cases below pin both directions. Read a colour token directly instead:
 * `var(--x)`, or `color-mix(in oklab, var(--x) N%, transparent)` for a see-through form.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

type Source = { file: string; text: string }
type Violation = { file: string; line: number; wrapper: string; token: string; definition: string }

const APP_ROOT = process.cwd()
const SRC_ROOT = path.join(APP_ROOT, 'src')
const SCANNED = /\.(css|svelte|ts|js|html)$/
const NOT_PRODUCT = /(\.test\.|\.spec\.|\/__tests__\/|\/test-utils\/|\/src\/tests\/)/

// The start of a colour function whose first argument is a variable.
const WRAPPER = /\b(hsla?|rgba?)\(\s*var\(\s*(--[\w-]+)/gi
// `--name: value;` inside CSS. Values may span lines (color-mix(...) often does).
const DEFINITION = /(?<![\w-])(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g
// A value a colour function can take as its channels: `220 14% 96%`, `255, 255, 255`, `/ 0.5`.
const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|grad|rad|turn|%)?`
const CHANNEL_LIST = new RegExp(
  String.raw`^${NUMBER}(?:\s*,\s*|\s+)${NUMBER}(?:\s*,\s*|\s+)${NUMBER}(?:\s*[/,]\s*${NUMBER})?$`
)
const ALIAS = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/

/** Blank out comments, keeping every offset and newline so line numbers stay true. */
function withoutComments(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ')
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank)
}

/** The CSS a file contributes definitions from: all of a .css file, the <style> blocks of a .svelte file. */
function cssOf(source: Source): string {
  if (source.file.endsWith('.css')) return source.text
  if (!source.file.endsWith('.svelte')) return ''
  return [...source.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n')
}

function collectDefinitions(sources: Source[]): Map<string, string[]> {
  const definitions = new Map<string, string[]>()
  for (const source of sources) {
    for (const match of withoutComments(cssOf(source)).matchAll(DEFINITION)) {
      const value = match[2].replace(/\s*!important\s*$/i, '').replace(/\s+/g, ' ').trim()
      definitions.set(match[1], [...(definitions.get(match[1]) ?? []), value])
    }
  }
  return definitions
}

/**
 * The first definition of `token` that a colour function cannot wrap (a complete colour,
 * directly or through `var()` aliases), or null when every definition is a channel list.
 * A token defined nowhere proves nothing either way, so it is not reported here.
 */
function completeColourDefinition(
  token: string,
  definitions: Map<string, string[]>,
  seen = new Set<string>()
): string | null {
  if (seen.has(token)) return null
  seen.add(token)
  for (const value of definitions.get(token) ?? []) {
    if (CHANNEL_LIST.test(value)) continue
    const alias = value.match(ALIAS)
    if (alias) {
      const target = alias[1]
      if (definitions.has(target)) {
        if (completeColourDefinition(target, definitions, seen)) return value
        continue
      }
      const fallback = alias[2]?.trim()
      if (fallback && !CHANNEL_LIST.test(fallback)) return value
      continue
    }
    return value
  }
  return null
}

function findInvalidColourWrappers(sources: Source[]): Violation[] {
  const definitions = collectDefinitions(sources)
  const violations: Violation[] = []
  for (const source of sources) {
    const text = withoutComments(source.text)
    for (const match of text.matchAll(WRAPPER)) {
      const token = match[2]
      const definition = completeColourDefinition(token, definitions)
      if (!definition) continue
      violations.push({
        file: source.file,
        line: text.slice(0, match.index).split('\n').length,
        wrapper: `${match[1]}(var(${token}))`,
        token,
        definition
      })
    }
  }
  return violations
}

function productSources(): Source[] {
  const sources: Source[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (SCANNED.test(entry.name) && !NOT_PRODUCT.test(full)) {
        sources.push({ file: path.relative(APP_ROOT, full), text: fs.readFileSync(full, 'utf8') })
      }
    }
  }
  walk(SRC_ROOT)
  return sources
}

const TOKENS_CSS: Source = {
  file: 'tokens.css',
  text: `:root {
  --border: oklch(0.62 0.024 282 / 0.2);
  --primary: var(--bs-app-primary);
  --bs-app-primary: oklch(0.33 0.07 274.7);
  --hue-triplet: 220 14% 96%;
  --rgb-triplet: 255, 255, 255;
  --blend: color-mix(
    in oklab,
    var(--border) 38%,
    transparent
  );
}`
}

const run = (...files: Source[]) => findInvalidColourWrappers([TOKENS_CSS, ...files])

describe('colour-token wrapper guard: the analysis (BL-98)', () => {
  it('flags hsl() around a token that is an oklch colour, with its alpha form', () => {
    const found = run({
      file: 'a.css',
      text: `.a { border: 1px solid hsl(var(--border)); }\n.b { background: hsl(var(--border) / 0.8); }`
    })
    expect(found.map((v) => [v.line, v.wrapper])).toEqual([
      [1, 'hsl(var(--border))'],
      [2, 'hsl(var(--border))']
    ])
    expect(found[0].definition).toBe('oklch(0.62 0.024 282 / 0.2)')
  })

  it('follows var() aliases to the colour underneath', () => {
    const found = run({ file: 'b.css', text: `.a { color: hsl(var(--primary)); }` })
    expect(found).toHaveLength(1)
    expect(found[0].definition).toBe('var(--bs-app-primary)')
  })

  it('catches hsla, rgb, rgba, a multi-line color-mix token, and a wrapper nested in color-mix', () => {
    const found = run({
      file: 'c.svelte',
      text: `<div style="color: hsla(var(--border), 0.5)"></div>
<style>
  .a { color: rgb(var(--blend)); }
  .b { background: color-mix(in srgb, rgba(var(--primary), 0.4) 78%, transparent); }
</style>`
    })
    expect(found.map((v) => [v.line, v.wrapper])).toEqual([
      [1, 'hsla(var(--border))'],
      [3, 'rgb(var(--blend))'],
      [4, 'rgba(var(--primary))']
    ])
  })

  it('leaves a channel-list token alone, and a token read directly', () => {
    const found = run({
      file: 'd.css',
      text: `.a { color: hsl(var(--hue-triplet)); background: rgba(var(--rgb-triplet), 0.5); }
.b { border-color: var(--border); background: color-mix(in oklab, var(--border) 80%, transparent); }`
    })
    expect(found).toEqual([])
  })

  it('ignores wrappers written in comments', () => {
    const found = run({
      file: 'e.svelte',
      text: `<!-- hsl(var(--border)) -->
<script lang="ts">
  // hsl(var(--border)) was the old shadcn form
</script>
<style>
  /* never: hsl(var(--primary)) */
</style>`
    })
    expect(found).toEqual([])
  })
})

describe('colour-token wrapper guard: the app (BL-98)', () => {
  it('has no colour function wrapping a token that is already a colour', () => {
    const sources = productSources()
    // Positive control: the scan really reached the stylesheets and the page that had the bug.
    expect(sources.some((source) => source.file === path.join('src', 'app.css'))).toBe(true)
    expect(sources.some((source) => source.file.endsWith(path.join('desktop-controls', '+page.svelte')))).toBe(true)
    expect(collectDefinitions(sources).get('--border')?.length).toBeGreaterThan(0)

    const found = findInvalidColourWrappers(sources).map(
      (v) => `${v.file}:${v.line}  ${v.wrapper}  (${v.token}: ${v.definition})`
    )
    expect(found, 'Read the token directly: var(--x), or color-mix(in oklab, var(--x) N%, transparent)').toEqual([])
  })
})
