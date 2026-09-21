import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Source with its comments stripped: the claims are about what the code DOES. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const page = codeOnly(readFileSync('src/routes/+page.svelte', 'utf8'))

/**
 * The body of a top-level function in the page's script, found by its signature and the first
 * `) {` that ends a line after it (a parameter default such as `= {}` never does). Brace
 * matching checks itself: the body must end where its braces balance, or the pin fails instead
 * of passing on a wrong slice.
 */
function functionBody(signature: string) {
  const at = page.indexOf(signature)
  expect(at, `${signature} not found`).toBeGreaterThan(-1)
  expect(page.indexOf(signature, at + 1), `${signature} appears twice`).toBe(-1)
  const paramsEnd = page.indexOf(') {\n', at)
  expect(paramsEnd, `${signature}: no parameter list end`).toBeGreaterThan(at)
  const open = paramsEnd + ') '.length
  let depth = 0
  for (let index = open; index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    else if (page[index] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(open, index + 1)
    }
  }
  throw new Error(`${signature}: body never closed`)
}

/**
 * The Token Panel's live preview goes through ONE gate (`$lib/utils/contextPreviewGate.ts`),
 * whose own tests hold the rule: one request in flight per chat, one trailing refresh, never a
 * chat that is not on screen. Before 2026-09-18 every ask started its own request, and a reply's
 * end opened three or four at once, which with the page's two event streams filled Chrome's six
 * connections to the server and held the next send's `generate-id` for seconds. These pins hold
 * the page to the gate; they cannot prove behaviour, which is why the rule lives in the module.
 */
describe('the chat page asks for Token Panel previews through ONE gate', () => {
  it('creates one gate whose runner is the preview request and whose chat is the one on screen', () => {
    expect(page.split('createContextPreviewGate<').length - 1).toBe(1)
    expect(page).toMatch(
      /\n {2}const contextPreviewGate = createContextPreviewGate<\{\s*reason: string\s*options: ContextPreviewRefreshOptions\s*\}>\(\{\s*run: \(sessionId, ask\) => runLiveContextPreview\(ask\.reason, sessionId, ask\.options\),\s*isOnScreen: \(sessionId\) => sessionId === currentSessionId\s*\}\)/
    )
  })

  it('every ask goes to the gate: refreshLiveContextPreview only hands it over', () => {
    const body = functionBody('function refreshLiveContextPreview(')
    expect(body).toMatch(
      /^\{\n {4}if \(!scheduledSessionId\) return\n {4}contextPreviewGate\.request\(scheduledSessionId, \{ reason, options \}\)\n {2}\}$/
    )
  })

  it('sends the preview request in exactly one place, which only the gate runs', () => {
    expect(page.split("fetch('/api/messages/context-preview'").length - 1).toBe(1)
    const runner = functionBody('async function runLiveContextPreview(')
    expect(runner).toContain("\n      const response = await fetch('/api/messages/context-preview', {")
    // The definition and the gate's `run`: nothing else may start a preview around the gate.
    expect(page.split('runLiveContextPreview(').length - 1).toBe(2)
  })

  it('the timer hands its ask to the same path', () => {
    const body = functionBody('function scheduleLiveContextPreview(')
    expect(body).toContain('\n      void refreshLiveContextPreview(reason, sessionId, options)\n')
  })

  it('clearing a chat’s estimate also drops its trailing refresh', () => {
    const body = functionBody('function clearLiveContextEstimate(')
    expect(body).toContain('\n    contextPreviewGate.forget(sessionId)\n')
  })
})
