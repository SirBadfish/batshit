import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BL-382: after the live connection drops and comes back, the chat on screen is read again ONCE.
 * The server replays only a chat's live turn to a listener it adds again, and a finished turn's
 * buffer goes 5 s after its `end`, so a reply that ended while the tab was away was lost (stuck
 * half-written, or missing) until a manual reload, and the next send compiled that stale history.
 */
describe('the chat page after a live reconnect (source pins, from the line start)', () => {
  const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')

  it('each chat subscription tells the page when the server added it again', () => {
    expect(page).toMatch(
      /\n\s*\(error\) => handleSSEError\(error, sessionId\),\n\s*\(\) => handleSSEReconnected\(sessionId\)\n\s*\)\n/
    )
  })

  it('the page reads the chat on screen (or a chat still streaming) again, through the one load queue', () => {
    const start = page.indexOf('\n  function handleSSEReconnected(sessionId: string) {\n')
    expect(start).toBeGreaterThan(-1)
    const body = page.slice(start, page.indexOf('\n  }\n', start + 1) + 1)
    expect(body).toContain('\n    toast.dismiss(SSE_RECONNECT_TOAST_ID)\n')
    expect(body).toContain('onScreen: sessionId === sessionStore.getCurrentSessionId()')
    expect(body).toContain('\n    void catchUpAfterReconnect(sessionId)\n')
  })
})
