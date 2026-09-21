import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/routes/+page.svelte', 'utf8')
const chatMessage = readFileSync('src/lib/components/chat/ChatMessage.svelte', 'utf8')

/**
 * A running reply no longer holds a browser connection (2026-09-18).
 *
 * The page and the approval card awaited `POST /api/messages/send-routed` until the turn was
 * over, and each running reply held one of the browser's six HTTP/1.1 connections: five
 * replies at once froze every other request of every tab, Stop included
 * (`_local/sconn-proof/fivetabs-before.json`). Both now send through `postSendRouted`
 * (`$lib/services/sendRoutedClient.ts`, tested there), which is answered once the server owns
 * the turn and then waits for its final answer over the live hub. The page keeps its send's
 * abort controller until that answer, so its busy state and the browser-held queue wait for
 * the server's own "turn over"; Stop aborts the wait as it aborted the request.
 */
describe('the page and the approval card send without holding a connection', () => {
  it('nothing in either calls send-routed with a bare fetch any more', () => {
    expect(page).not.toMatch(/fetch\(\s*['"`]\/api\/messages\/send-routed/)
    expect(chatMessage).not.toMatch(/fetch\(\s*['"`]\/api\/messages\/send-routed/)
  })

  it('the page’s send, with its 409 retry, goes through postSendRouted with its abort signal', () => {
    const retry = page.indexOf('\n  async function postSendRoutedWithInterruptRetry(params: {')
    const loop = page.indexOf('\n    while (true) {\n      const response = await postSendRouted(bodyText, { signal: params.signal })\n', retry)
    expect(retry).toBeGreaterThan(-1)
    expect(loop).toBeGreaterThan(retry)
    expect(page).toContain("\n  import { postSendRouted } from '$lib/services/sendRoutedClient'\n")
  })

  it('the approval card’s answer goes through postSendRouted too', () => {
    const submit = chatMessage.indexOf('\n  async function submitToolApprovals(approvals: any[]) {')
    const call = chatMessage.indexOf('\n        const response = await postSendRouted(\n          JSON.stringify({\n', submit)
    expect(submit).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(submit)
    // The card keeps its marks from the server's acceptance on (bug sweep, 2026-09-18).
    const accepted = chatMessage.indexOf('\n            onAccepted: () => {\n              accepted = true\n', call)
    expect(accepted).toBeGreaterThan(call)
    expect(chatMessage).toContain("\n  import { postSendRouted } from '$lib/services/sendRoutedClient'\n")
  })
})
