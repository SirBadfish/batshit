import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BATSHIT_THEME_CSS, generateArtifactApiScript } from './generateArtifactApi'

/**
 * BL-99: artifacts run in their own document, so they cannot read the app's CSS variables. The
 * runtime theme carries its own copy of the app's primary, and this suite is what keeps that copy
 * equal to `app.css`: change the app's fill or mark and this fails until the artifact theme follows.
 * BL-172 added the surfaces an artifact paints (the canvas, cards, raised and inset surfaces, and
 * fields): the artifact canvas had stayed on the old launch canvas, so artifact bodies looked darker
 * than the panel around them. Values are compared after resolving `var()`, relative
 * `oklch(from ...)`, and `color-mix(in oklab, ...)`, not as text, so either side may spell a value
 * differently as long as it is the same colour.
 */

const APP_CSS = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8')

// Artifact token -> the app token whose value it must carry (Fill and Mark, `batshit-ui-patterns`).
const APP_TOKEN_FOR_ARTIFACT_TOKEN: Record<string, string> = {
  '--batshit-primary': '--bs-app-primary', // the fill, only ever behind light text
  '--batshit-primary-line': '--bs-app-primary-line', // the fill's rim
  '--batshit-primary-foreground': '--bs-app-primary-foreground', // text on the fill
  '--batshit-primary-text': '--bs-app-primary-text', // the mark: text, lines, slider fills
  '--batshit-primary-soft': '--bs-app-primary-soft', // washes of the mark
  '--batshit-primary-faint': '--bs-app-primary-faint',
  '--batshit-ring': '--ring', // focus rings
  // The older accent names. Saved artifacts draw text, borders, and spinners with them (their
  // accent-coloured buttons are repainted by the theme's own button rule), so they carry the mark.
  '--batshit-accent': '--bs-app-primary-text',
  '--batshit-accent-soft': '--bs-app-primary-soft',
  '--batshit-accent-faint': '--bs-app-primary-faint',
  // Text on the light accent is dark, as on the app's DM badge (`color: var(--background)`).
  '--batshit-accent-foreground': '--background',
  // BL-172: the surfaces an artifact paints match the app's (Josh, 2026-09-26: match the app canvas).
  '--batshit-bg': '--bs-app-canvas', // the page canvas
  '--batshit-surface': '--bs-app-card', // cards
  '--batshit-surface-elevated': '--bs-app-raised', // raised surfaces
  '--batshit-surface-inset': '--bs-app-inset-surface', // inset rows inside a card
  '--batshit-field': '--bs-app-field', // input and select faces
  '--batshit-field-hover': '--bs-app-field-hover'
}

type Oklch = { l: number; c: number; h: number; alpha: number }

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function firstRootBlock(css: string): string {
  const source = stripComments(css)
  const start = source.search(/(^|\n)\s*:root\s*\{/)
  if (start === -1) throw new Error('no :root block')
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  throw new Error('unclosed :root block')
}

function customProperties(block: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    // First definition wins, as later ones in this block would be a mistake worth seeing.
    if (!declarations.has(match[1])) declarations.set(match[1], match[2].replace(/\s+/g, ' ').trim())
  }
  return declarations
}

// A tiny evaluator for the colour forms these tokens use: oklch(L C H [/ A]), var(--x), the
// relative form oklch(from <colour> <ch> <ch> <ch> [/ A]) where a channel is a number, one of the
// keywords l / c / h, or calc(<keyword> +|- <number>), and color-mix(in oklab, <colour> [p%],
// <colour> [p%]). Anything else throws, so an app token that moves to a new form fails loudly here
// instead of comparing wrongly.
function resolveToken(name: string, declarations: Map<string, string>, seen: string[] = []): Oklch {
  if (seen.includes(name)) throw new Error(`cycle: ${[...seen, name].join(' -> ')}`)
  const value = declarations.get(name)
  if (value === undefined) throw new Error(`${name} is not defined`)
  return evaluateColour(value, declarations, [...seen, name])
}

function evaluateColour(value: string, declarations: Map<string, string>, seen: string[]): Oklch {
  const tokens = value.match(/color-mix\(|oklch\(|var\(|calc\(|--[\w-]+|[a-z]+|\d*\.?\d+%?|[(),/+\-]/g) ?? []
  let position = 0
  const peek = () => tokens[position]
  const take = (expected?: string) => {
    const token = tokens[position]
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected} but found ${token ?? 'end'} in "${value}"`)
    }
    position += 1
    return token
  }
  const number = (token: string | undefined) => {
    if (token === undefined || !/^\d*\.?\d+%?$/.test(token)) throw new Error(`bad number ${token} in "${value}"`)
    return token.endsWith('%') ? Number(token.slice(0, -1)) / 100 : Number(token)
  }
  const colour = (): Oklch => {
    const head = take()
    if (head === 'var(') {
      const referenced = take()
      take(')')
      return resolveToken(referenced as string, declarations, seen)
    }
    if (head === 'color-mix(') {
      take('in')
      take('oklab')
      take(',')
      const first = colour()
      const firstShare = peek()?.endsWith('%') ? number(take()) : null
      take(',')
      const second = colour()
      const secondShare = peek()?.endsWith('%') ? number(take()) : null
      take(')')
      return mixInOklab(first, firstShare, second, secondShare, value)
    }
    if (head !== 'oklch(') throw new Error(`unsupported colour "${value}"`)
    let origin: Oklch | null = null
    if (peek() === 'from') {
      take('from')
      origin = colour()
    }
    const channel = (key: 'l' | 'c' | 'h'): number => {
      const token = take()
      if (token === 'calc(') {
        const base = channelKeyword(take())
        const operator = take()
        const amount = number(take())
        take(')')
        if (operator === '+') return base + amount
        if (operator === '-') return base - amount
        throw new Error(`unsupported calc operator ${operator} in "${value}"`)
      }
      if (token === 'l' || token === 'c' || token === 'h') return channelKeyword(token)
      return number(token)
      function channelKeyword(keyword: string | undefined): number {
        if (!origin) throw new Error(`channel keyword ${keyword} without "from" in "${value}"`)
        if (keyword !== 'l' && keyword !== 'c' && keyword !== 'h') throw new Error(`bad channel ${keyword}`)
        void key
        return origin[keyword]
      }
    }
    const l = channel('l')
    const c = channel('c')
    const h = channel('h')
    let alpha = origin ? origin.alpha : 1
    if (peek() === '/') {
      take('/')
      alpha = number(take())
    }
    take(')')
    return { l, c, h, alpha }
  }
  const result = colour()
  if (position !== tokens.length) throw new Error(`trailing input in "${value}"`)
  return result
}

// CSS Color 5 color-mix(): a missing share is the rest of 100%, the mix is premultiplied by alpha,
// and shares that add up to less than 100% scale the result's alpha.
function mixInOklab(first: Oklch, firstShare: number | null, second: Oklch, secondShare: number | null, value: string): Oklch {
  const p1 = firstShare ?? (secondShare === null ? 0.5 : 1 - secondShare)
  const p2 = secondShare ?? 1 - p1
  const sum = p1 + p2
  if (sum <= 0) throw new Error(`color-mix shares add up to zero in "${value}"`)
  const w1 = p1 / sum
  const w2 = p2 / sum
  const toLab = (colour: Oklch) => ({
    l: colour.l,
    a: colour.c * Math.cos((colour.h * Math.PI) / 180),
    b: colour.c * Math.sin((colour.h * Math.PI) / 180)
  })
  const one = toLab(first)
  const two = toLab(second)
  const alpha = first.alpha * w1 + second.alpha * w2
  const mix = (x: number, y: number) => (x * first.alpha * w1 + y * second.alpha * w2) / alpha
  const l = mix(one.l, two.l)
  const a = mix(one.a, two.a)
  const b = mix(one.b, two.b)
  const c = Math.hypot(a, b)
  const h = c < 1e-9 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  return { l, c, h, alpha: alpha * Math.min(1, sum) }
}

function round(colour: Oklch): Oklch {
  const r = (n: number) => Math.round(n * 1e6) / 1e6
  return { l: r(colour.l), c: r(colour.c), h: r(colour.h), alpha: r(colour.alpha) }
}

const appTokens = customProperties(firstRootBlock(APP_CSS))
const artifactTokens = customProperties(firstRootBlock(BATSHIT_THEME_CSS))

describe('artifact runtime theme carries the app primary (BL-99)', () => {
  it.each(Object.entries(APP_TOKEN_FOR_ARTIFACT_TOKEN))('%s equals app %s', (artifactToken, appToken) => {
    expect(round(resolveToken(artifactToken, artifactTokens))).toEqual(round(resolveToken(appToken, appTokens)))
  })

  it('pins the literal values of the fill and the mark, so a test that moves with its own table cannot hide a change', () => {
    expect(round(resolveToken('--batshit-primary', artifactTokens))).toEqual({ l: 0.33, c: 0.07, h: 274.7, alpha: 1 })
    expect(round(resolveToken('--batshit-primary-text', artifactTokens))).toEqual({ l: 0.74, c: 0.07, h: 274.7, alpha: 1 })
  })

  it('paints the artifact canvas with the app canvas, not the old launch canvas (BL-172)', () => {
    expect(round(resolveToken('--batshit-bg', artifactTokens))).toEqual({ l: 0.1656, c: 0.0127, h: 277.51, alpha: 1 })
    expect(artifactTokens.get('--batshit-bg')).not.toContain('0.11 0.02 276')
  })

  it('mixes colours the way color-mix(in oklab) does, so the inset surface comparison means something', () => {
    const declarations = new Map([
      ['--black', 'oklch(0 0 0)'],
      ['--white', 'oklch(1 0 0)'],
      ['--half', 'color-mix(in oklab, var(--black) 50%, var(--white))'],
      ['--quarter', 'color-mix(in oklab, var(--black), var(--white) 25%)']
    ])
    expect(round(resolveToken('--half', declarations))).toEqual({ l: 0.5, c: 0, h: 0, alpha: 1 })
    expect(round(resolveToken('--quarter', declarations))).toEqual({ l: 0.25, c: 0, h: 0, alpha: 1 })
    // Two different inset mixes must not compare equal.
    const insetOther = new Map([...artifactTokens, ['--probe', 'color-mix(in oklab, var(--batshit-surface) 40%, oklch(0.28 0.02 282.95))']])
    expect(round(resolveToken('--probe', insetOther))).not.toEqual(round(resolveToken('--batshit-surface-inset', artifactTokens)))
  })

  it('keeps the accent hover one step lighter than the accent, as it was beside the lavender', () => {
    const accent = resolveToken('--batshit-accent', artifactTokens)
    const hover = resolveToken('--batshit-accent-hover', artifactTokens)
    expect(round(hover)).toEqual(round({ ...accent, l: accent.l + 0.06 }))
  })

  it('no longer ships the retired lavender anywhere in the theme or the Builder Kit styles', () => {
    const script = generateArtifactApiScript({ artifactId: 'artifact_theme_test', runtimeToken: `art_rt_${'a'.repeat(64)}` })
    for (const source of [BATSHIT_THEME_CSS, script]) {
      expect(source).not.toContain('0.5 0.044 281')
      expect(source).not.toContain('0.56 0.05 281')
    }
  })

  it('draws marks with the mark tokens and keeps tinted surfaces on the fill', () => {
    const script = generateArtifactApiScript({ artifactId: 'artifact_theme_test', runtimeToken: `art_rt_${'a'.repeat(64)}` })
    // Native control marks: slider fills, checkbox and radio ticks.
    expect(script).not.toContain('accent-color:var(--batshit-primary);')
    expect(script).toContain('.batshit-builder-checkbox-row input{accent-color:var(--batshit-primary-text);}')
    expect(script).toContain('.batshit-builder-radio-group input{accent-color:var(--batshit-primary-text);}')
    expect(script).toMatch(/\.batshit-builder-slider\{[^}]*accent-color:var\(--batshit-primary-text\)/)
    // Focus rings: the Builder Kit fields and the theme's own field and button rules.
    expect(script).toContain(':focus{border-color:var(--batshit-ring);box-shadow:0 0 0 2px var(--batshit-field-focus-ring);')
    expect(BATSHIT_THEME_CSS).toContain('border-color: var(--batshit-ring) !important;')
    expect(artifactTokens.get('--batshit-field-focus-ring')).toBe('var(--batshit-primary-soft)')
    // Tinted surfaces mix the fill into a surface and stay on it.
    expect(script).toContain('color-mix(in oklab,var(--batshit-surface-elevated) 86%,var(--batshit-primary) 14%)')
    expect(artifactTokens.get('--batshit-control-surface')).toContain('var(--batshit-primary) 28%')
  })
})
