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
 * Every `$effect(() => { ... })` body in the page. The scan is plain brace matching, so it
 * checks itself: each body must be followed by the `)` that closes its `$effect(`. If a
 * brace inside a string ever throws it off, the self-check fails instead of the rule below
 * passing on a wrong slice.
 */
function effectBodies(source: string) {
  const bodies: string[] = []
  let at = source.indexOf('$effect(() => {')
  while (at !== -1) {
    const open = source.indexOf('{', at)
    let depth = 0
    let close = -1
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    expect(close, 'an $effect body never closed').toBeGreaterThan(open)
    expect(source.slice(close + 1).trimStart().startsWith(')'), 'an $effect body scan went wrong').toBe(true)
    bodies.push(source.slice(open, close + 1))
    at = source.indexOf('$effect(() => {', close)
  }
  return bodies
}

/**
 * The chat page re-fetched the open chat about ten times a second from 2026-06-06: its load
 * `$effect` read the message cache and the run registry, so the load's own answer re-ran it.
 * The rule is `watchSelectedSessionLoad` (`$lib/utils/selectedSessionLoad.svelte.ts`), whose
 * own tests drive the REAL stores. These pins hold the page to that rule; they cannot prove
 * behavior, which is why the rule lives in the module.
 */
describe('the chat page loads the selected chat through ONE rule', () => {
  it('wires the load with only the selected chat and its creating hold as inputs', () => {
    const calls = page.split('watchSelectedSessionLoad({').length - 1
    expect(calls).toBe(1)
    const call = page.slice(page.indexOf('watchSelectedSessionLoad({'))
    expect(call).toMatch(/^watchSelectedSessionLoad\(\{\s*selectedSessionId: \(\) => currentSessionId,\s*isCreating: isSessionCreating,/)
  })

  it('has no $effect that loads a chat, and only the busy-to-idle one reads the execution log', () => {
    const bodies = effectBodies(page)
    expect(bodies.length).toBeGreaterThan(20)
    for (const body of bodies) {
      expect(body).not.toContain('loadMessagesForSession(')
      expect(body).not.toContain('refreshJevJuicePostTurnRecords(')
      expect(body).not.toContain('messageStore.setMessagesForSession(')
    }
    // The one legitimate effect-driven execution-log read: once, when a reply finishes.
    const executionLogReaders = bodies.filter((body) => body.includes('loadExecutionSnapshots('))
    expect(executionLogReaders).toHaveLength(1)
    expect(executionLogReaders[0]).toContain('if (!busy && executionBusyPrev && sessionId)')
  })

  it('follows the run registry in an effect that only syncs the tool flags', () => {
    const mirrors = effectBodies(page).filter((body) => body.includes('chatRunRegistry.getRunState(sessionId)'))
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0]).toContain('untrack(syncActiveToolProcessingState)')
    expect(mirrors[0]).not.toContain('load')
  })

  it('loads a chat through the queue, so a request during a load is not dropped', () => {
    expect(page).toContain('const chatLoadQueue = createChatLoadQueue(')
    const loader = page.slice(page.indexOf('function loadMessagesForSession(sessionId: string) {'))
    expect(loader.slice(0, 160)).toContain('return chatLoadQueue.request(sessionId)')
    // The old set-based guard returned instead, which only worked because the page asked
    // again 100 ms later.
    expect(page).not.toContain('loadingMessageSessionIds')
  })
})

/**
 * What the server has to say out loud now that the page no longer re-reads the open chat ten
 * times a second.
 */
describe('the chat page hears about changes it cannot see', () => {
  it('re-reads the chat on screen when the server says its messages changed', () => {
    const handler = page.indexOf("if (event?.type === 'session_messages_changed')")
    expect(handler).toBeGreaterThan(-1)
    const body = page.slice(handler, handler + 700)
    expect(body).toContain('!== currentSessionId) return')
    expect(body).toContain('void loadMessagesForSession(changedSessionId)')
  })

  it('keeps the chat on screen subscribed to its stream even when it is empty', () => {
    const rule = page.indexOf('function shouldAutoConnectSseForSession(sessionId: string) {')
    expect(rule).toBeGreaterThan(-1)
    const body = page.slice(rule, rule + 400)
    expect(body).toContain('if (sessionId === sessionStore.getCurrentSessionId()) return true')
    // The disconnect that used to drop an empty selected chat's stream is gone: an event for
    // a session with no listener is DROPPED by `/api/sse`, so a voice turn or a shared
    // artifact written into an empty chat reached nobody.
    expect(page).not.toContain('Disconnecting idle blank selected session SSE')
  })
})
