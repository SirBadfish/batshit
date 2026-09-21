import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Fonts are self-hosted and every mono surface reads the one mono token (2026-09-21).
 *
 * Josh picked Nunito Sans for the interface and Google Sans Code for code. Two things went
 * quietly wrong before this pin: four renderers hard-coded `'SF Mono', Monaco, ...`, and a
 * component class beats the global `code, pre` rule, so the file-edit diff drew in Monaco
 * (a Mac system font) while the rest of chat used the app's mono (BL-76); and `app.html`
 * preloaded two Geist files the page no longer used, a warning on every load (BL-73).
 */

const APP_CSS = readFileSync('src/app.css', 'utf8')
const FONTS_CSS = readFileSync('src/lib/styles/core/fonts.css', 'utf8')
const APP_HTML = readFileSync('src/app.html', 'utf8')

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')

const faceFamilies = new Set(
  [...FONTS_CSS.matchAll(/font-family:\s*"([^"]+)"/g)].map((match) => match[1]),
)
const faceUrls = [...FONTS_CSS.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((match) => match[1])
/** Which family each font file belongs to, from its @font-face block. */
const familyOfUrl = new Map(
  [...FONTS_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].flatMap((block) => {
    const family = block[1].match(/font-family:\s*"([^"]+)"/)?.[1]
    return [...block[1].matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((url) => [url[1], family] as const)
  }),
)

/** The first family of a `--bs-font-*` stack in app.css. */
function firstFamily(token: string) {
  const match = APP_CSS.match(new RegExp(`${token}:\\s*"([^"]+)"`))
  if (!match) throw new Error(`${token} is not defined with a quoted first family in app.css`)
  return match[1]
}

function styleSources(dir: string, found: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      styleSources(full, found)
      continue
    }
    if (/\.(svelte|css)$/.test(name) && full !== path.join('src', 'lib', 'styles', 'core', 'fonts.css')) {
      found.push(full)
    }
  }
  return found
}

const MONO_NAMES = /monospace|mono\b|monaco|menlo|consolas|courier|cascadia/i
const THROUGH_TOKEN = /^var\(--(bs-font-mono|font-mono|batshit-font-mono)\b/

describe('Batshit fonts', () => {
  it('serves every @font-face file from static/', () => {
    expect(faceUrls.length).toBeGreaterThan(0)
    const missing = faceUrls.filter((url) => !existsSync(path.join('static', url)))
    expect(missing).toEqual([])
  })

  it('self-hosts the interface and mono families the tokens name first', () => {
    expect(firstFamily('--bs-font-sans')).toBe('Nunito Sans')
    expect(firstFamily('--bs-font-mono')).toBe('Google Sans Code')
    for (const family of [firstFamily('--bs-font-sans'), firstFamily('--bs-font-mono')]) {
      expect(faceFamilies.has(family), `${family} needs an @font-face in fonts.css`).toBe(true)
    }
  })

  it('never hard-codes a monospace stack in a component: mono text reads the token', () => {
    const offenders: string[] = []
    for (const file of styleSources('src')) {
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const match of source.matchAll(/(?:^|[;{\s])font-family:\s*([^;}]+)/g)) {
        const value = match[1].trim()
        if (MONO_NAMES.test(value) && !THROUGH_TOKEN.test(value)) offenders.push(`${file}: font-family: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('preloads only font files the page really uses', () => {
    const preloads = [...APP_HTML.matchAll(/<link[^>]*rel="preload"[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => /as="font"/.test(tag))
      .map((tag) => (tag.match(/href="%sveltekit\.assets%([^"]+)"/) ?? [])[1])
    for (const href of preloads) {
      expect(href, 'a font preload needs a %sveltekit.assets% href').toBeTruthy()
      expect(existsSync(path.join('static', href!)), `${href} is missing from static/`).toBe(true)
      // a fallback family's file is declared but never drawn, so preloading it only earns a warning
      const rendered = [firstFamily('--bs-font-sans'), firstFamily('--bs-font-mono')]
      expect(rendered, `${href} is preloaded but is not a file of a family the app draws first`).toContain(familyOfUrl.get(href!))
    }
  })
})
