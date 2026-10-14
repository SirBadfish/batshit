import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Source with its comments stripped, matching the other route contract tests' approach. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const rawPage = readFileSync('src/routes/desktop-controls/+page.svelte', 'utf8')
const page = codeOnly(rawPage)

/**
 * BL-484: `getClipCompressionSettings` used to throw "Clip compression settings are
 * unavailable." for a MISSING `ui_settings` — the shape every fresh install and every user
 * who has never saved Settings > Clips actually has — instead of defaulting, like the chat's
 * Clips menu already did. The fix moved the response handling into the shared normalizer
 * (`clipCompressionSettingsFromResponse`, proven by `clipCompressionSettings.test.ts`'s own
 * three cases: a missing `ui_settings` gives the defaults, a null payload throws, a non-OK
 * response throws) so this page and any future caller read one rule. This pins the PAGE to
 * that rule: it cannot prove runtime behavior (the normalizer's own tests do that), but it
 * catches the regression of the page going back to its own inline throw-on-missing logic,
 * which the normalizer's tests alone cannot see because they never touch this file.
 */
describe('desktop-controls +page.svelte getClipCompressionSettings (BL-484)', () => {
  function extractFunctionBody(functionSignature: string): string {
    const start = page.indexOf(functionSignature)
    expect(start, `${functionSignature} not found in the page`).toBeGreaterThanOrEqual(0)
    const open = page.indexOf('{', start)
    let depth = 0
    let close = -1
    for (let index = open; index < page.length; index += 1) {
      if (page[index] === '{') depth += 1
      else if (page[index] === '}') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    expect(close, 'getClipCompressionSettings body never closed').toBeGreaterThan(open)
    return page.slice(open, close + 1)
  }

  it('imports the shared normalizer', () => {
    expect(rawPage).toContain(
      "import { clipCompressionSettingsFromResponse } from '$lib/utils/clipCompressionSettings'"
    )
  })

  it('reads settings through the shared util, not its own inline throw-on-missing logic', () => {
    const body = extractFunctionBody('async function getClipCompressionSettings()')

    // The fix: the response (ok + parsed payload) is handed to the shared function, which
    // owns the missing-vs-failed rule.
    expect(body).toContain('clipCompressionSettingsFromResponse(')

    // The regression this guards against: a MISSING `ui_settings` must never throw here
    // again. The page no longer contains its own copy of this message or an inline
    // `!settings` / `!response.ok` throw guarding it.
    expect(body).not.toContain('Clip compression settings are unavailable')
    expect(body).not.toMatch(/if\s*\(\s*!settings\s*\)/)
  })
})
