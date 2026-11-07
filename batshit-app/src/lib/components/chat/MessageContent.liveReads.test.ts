import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MessageContent from './MessageContent.svelte'
import { refreshDeadCopies } from '$lib/stores/zipDeadCopies.svelte'
import { api } from '$lib/services/api'
import { zippingService } from '$lib/services/zipping'
import { setUserSettings } from '$lib/stores/userSettings.svelte'
import { normalizeId } from '$lib/utils/idNormalizer'
import { describeNotRefreshedReason } from '$lib/utils/liveFileReads'

// SA-137 P4 (D9, D10): the chat badge of a Read File whose newest reply showed a file snapshot is
// judged at the snapshot's size (the size the compile saw) and says so; a static copy, or a chat
// with no current receipt, changes nothing.
const zipId = 'cool_tool_1779416324513_live01'
const content = `{{batshit-zip:${zipId}:::Tool execution: read_file}}`

function storedZip(sessionId: string) {
  return {
    id: zipId,
    type: 'cool_tool',
    name: 'read_file',
    tokens: 40,
    content: JSON.stringify({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/live.ts' },
      toolResult: { content: 'const a = 1' },
      metadata: { toolName: 'read_file', tokens: 40, promptTokens: 40 }
    }),
    metadata: { sessionId, toolName: 'read_file', operationKind: 'read_file', tokens: 40, promptTokens: 40 }
  }
}

async function seedFacts(sessionId: string, liveReads: unknown) {
  await refreshDeadCopies(sessionId, (async () =>
    new Response(JSON.stringify({ deadCopies: {}, liveReads }), { status: 200 })) as typeof fetch)
}

const receipt = (copies: Record<string, unknown>, state = 'current') => ({
  state, replyId: 'reply-1', agentId: 'agent-1', delivery: 'issued', at: '2026-10-22T10:00:00.000Z', copies, overflow: 0
})

async function badgeTitle(sessionId: string) {
  render(MessageContent, { role: 'assistant', sessionId, messageId: 'reply-1', content, messageIndex: 0, totalMessages: 1 })
  // The read sits in a collapsed Tool activity group; open it to reach the tool card and its badge.
  await fireEvent.click(await screen.findByRole('button', { name: /Tool activity/ }))
  let title: string | null = null
  await waitFor(() => {
    title = document.querySelector(`[data-zip-id="${zipId}"] [aria-label="Zip controls"]`)?.getAttribute('title') ?? null
    expect(title).not.toBeNull()
  }, { timeout: 3_000 }).catch((e) => { console.log('DOM', document.body.innerHTML.slice(0, 4000)); throw e })
  return title as unknown as string
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/session-clips/state/')) return new Response('{"clips":[]}')
    if (url.includes('/api/zips/batch')) return new Response(JSON.stringify([storedZip('chat-reads')]))
    return new Response('{}', { status: 404 })
  }))
  vi.spyOn(api, 'getZips').mockImplementation(async () => new Map([[zipId, storedZip('chat-reads')]]) as any)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setUserSettings(null) })

const SNAPSHOT_LINE = 'Measured from the file as it was when the newest reply started (17,000 tokens); compressed, so its text was not sent'
const STORED_STATE = 'Expanded: compresses in 2 messages'
const tokenLabel = () => document.querySelector(`[data-zip-id="${zipId}"] .token-badge`)?.textContent?.trim()

describe('MessageContent badges with live file reads (SA-137 P4)', () => {
  it('shows the stored copy\'s own state when the chat has no live read facts', async () => {
    expect(await badgeTitle('chat-reads-none')).toBe(STORED_STATE)
  }, 15_000)

  it('judges a refreshed copy at the snapshot size, compressed by size while the stored copy is small', async () => {
    await seedFacts('chat-reads-refreshed', receipt({ [zipId]: { status: 'refreshed', promptTokens: 17_000 } }))
    expect(await badgeTitle('chat-reads-refreshed')).toBe(`Compressed. ${SNAPSHOT_LINE}`)
    // The badge's own token label keeps the stored size.
    expect(tokenLabel()).toBe('40 tokens')
  }, 15_000)

  it('says a compressed copy was only measured, prepared or sent alike (its text never went)', async () => {
    await seedFacts('chat-reads-prepared', { ...receipt({ [zipId]: { status: 'refreshed', promptTokens: 17_000 } }), delivery: 'prepared' })
    expect(await badgeTitle('chat-reads-prepared')).toBe(`Compressed. ${SNAPSHOT_LINE}`)
  }, 15_000)

  it('says the newest reply\'s snapshot is unknown when no usable record names it, keeping the stored state', async () => {
    await seedFacts('chat-reads-unknown', { state: 'unknown', replyId: 'reply-1', agentId: 'agent-1', unknownReason: 'missing', copies: { [zipId]: { status: 'unknown' } }, overflow: 0 })
    expect(await badgeTitle('chat-reads-unknown')).toBe(`${STORED_STATE}. Whether the newest reply showed this file as a fresh snapshot is unknown (no record for that reply), so this state may not match it`)
    expect(tokenLabel()).toBe('40 tokens')
  }, 15_000)

  it('names the snapshot size when it is too large for the prompt', async () => {
    await seedFacts('chat-reads-big', receipt({ [zipId]: { status: 'refreshed', promptTokens: 30_000 } }))
    expect(await badgeTitle('chat-reads-big')).toMatch(
      /^Too large for the prompt \(about 30,000 tokens\)\. The agent reads it in parts\. Measured from the file/
    )
    expect(tokenLabel()).toBe('40 tokens')
  }, 15_000)

  it('changes nothing for a static copy', async () => {
    await seedFacts('chat-reads-static', receipt({ [zipId]: { status: 'static', reason: 'file-unreadable' } }))
    expect(await badgeTitle('chat-reads-static')).toBe(STORED_STATE)
  }, 15_000)

  it('changes nothing once the receipt describes an earlier reply', async () => {
    await seedFacts('chat-reads-changed', receipt({ [zipId]: { status: 'refreshed', promptTokens: 17_000 } }, 'changed'))
    expect(await badgeTitle('chat-reads-changed')).toBe(STORED_STATE)
  }, 15_000)
})

// SA-137 Round 2 (strict freshness): the newest reply's compile showed a Read File copy only when it
// refreshed it, so under a strict receipt a static copy was NOT shown to the agent (zipped that
// turn, even if held or Off). Its badge draws compressed whatever the buffer, a hold or Off says.
describe('MessageContent badges for a copy the newest reply did not refresh (Round 2)', () => {
  const LINE = `Not shown to the agent in the newest reply: not refreshed (${describeNotRefreshedReason('not-readable')}). Batshit tries again at the next reply.`
  const strictStatic = (extra: Record<string, unknown> = {}) =>
    ({ ...receipt({ [zipId]: { status: 'static', reason: 'not-readable' } }), strict: true, ...extra })
  const userHold = { zipId, sessionId: 'chat', permanent: true, unzippedAt: 1, source: 'user' as const }
  const wrapper = () => document.querySelector(`[data-zip-id="${zipId}"]`) as HTMLElement | null

  function holdIt() {
    vi.spyOn(zippingService, 'getUnzippedInfo').mockImplementation((id: string) => (normalizeId(id) === normalizeId(zipId) ? userHold : null))
    vi.spyOn(zippingService, 'isUnzipped').mockImplementation((id: string) => normalizeId(id) === normalizeId(zipId))
  }

  it('draws the copy compressed, though the buffer keeps a small copy open, and says it was not shown', async () => {
    await seedFacts('chat-reads-notref', strictStatic())
    expect(await badgeTitle('chat-reads-notref')).toBe(`Compressed. ${LINE}`)
    expect(wrapper()?.classList.contains('zipped')).toBe(true)
    // The badge's own token label keeps the stored size.
    expect(tokenLabel()).toBe('40 tokens')
  }, 15_000)

  it('names the reason in plain words, never the raw code', async () => {
    await seedFacts('chat-reads-notref-why', strictStatic({ copies: { [zipId]: { status: 'static', reason: 'root-changed' } } }))
    const title = await badgeTitle('chat-reads-notref-why')
    expect(title).toContain(`not refreshed (${describeNotRefreshedReason('root-changed')})`)
    expect(title).not.toContain('root-changed')
  }, 15_000)

  it('a held copy stays compressed with its hold label, and the hold can still be released', async () => {
    holdIt()
    await seedFacts('chat-reads-notref-held', strictStatic())
    expect(await badgeTitle('chat-reads-notref-held')).toBe(`Compressed. Held by you. ${LINE}`)
    expect(wrapper()?.classList.contains('zipped')).toBe(true)
    await fireEvent.mouseEnter(document.querySelector(`[data-zip-id="${zipId}"] [aria-label="Zip controls"]`) as HTMLElement)
    expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy()
    // S2: under the user's own Hold the badge never offers a new Hold, which would replace it.
    expect(screen.queryByRole('button', { name: 'Hold for 10 messages' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hold' })).toBeNull()
  }, 15_000)

  it('under an agent\'s Hold the user may still replace it: both Holds and Release are offered', async () => {
    const agentHold = { zipId, sessionId: 'chat', permanent: true, unzippedAt: 1, source: 'agent' as const, agentId: 'agent-9', path: '/tmp/live.ts' }
    vi.spyOn(zippingService, 'getUnzippedInfo').mockImplementation((id: string) => (normalizeId(id) === normalizeId(zipId) ? agentHold : null))
    vi.spyOn(zippingService, 'isUnzipped').mockImplementation((id: string) => normalizeId(id) === normalizeId(zipId))
    await seedFacts('chat-reads-notref-agent-held', strictStatic())
    const title = await badgeTitle('chat-reads-notref-agent-held')
    expect(title).toBe(`Compressed. Held by the agent. ${LINE}`)
    await fireEvent.mouseEnter(document.querySelector(`[data-zip-id="${zipId}"] [aria-label="Zip controls"]`) as HTMLElement)
    expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hold for 10 messages' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hold' })).toBeTruthy()
  }, 15_000)

  it('a copy nobody holds still offers both Holds', async () => {
    await seedFacts('chat-reads-notref-unheld', strictStatic())
    await badgeTitle('chat-reads-notref-unheld')
    await fireEvent.mouseEnter(document.querySelector(`[data-zip-id="${zipId}"] [aria-label="Zip controls"]`) as HTMLElement)
    expect(await screen.findByRole('button', { name: 'Hold for 10 messages' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hold' })).toBeTruthy()
  }, 15_000)

  it('a copy whose zip row is Off is compressed too (Off keeps a copy open only when nothing says it was not shown)', async () => {
    setUserSettings({ global_zip_settings: { zip_disabled_read_file: true } } as any)
    await seedFacts('chat-reads-notref-off', strictStatic())
    const title = await badgeTitle('chat-reads-notref-off')
    expect(title).toBe(`Compressed. ${LINE}`)
    expect(wrapper()?.classList.contains('zipped')).toBe(true)
  }, 15_000)

  it('Off with a non-strict static copy is still open (today\'s behavior)', async () => {
    setUserSettings({ global_zip_settings: { zip_disabled_read_file: true } } as any)
    await seedFacts('chat-reads-off-static', receipt({ [zipId]: { status: 'static', reason: 'not-readable' } }))
    const title = await badgeTitle('chat-reads-off-static')
    expect(title).not.toContain('Not shown to the agent')
    expect(wrapper()?.classList.contains('zipped')).toBe(false)
  }, 15_000)

  it('a held static copy under a receipt that is not strict stays open, with no line', async () => {
    holdIt()
    await seedFacts('chat-reads-held-static', receipt({ [zipId]: { status: 'static', reason: 'not-readable' } }))
    const title = await badgeTitle('chat-reads-held-static')
    expect(title).toBe('Held by you')
    expect(wrapper()?.classList.contains('zipped')).toBe(false)
  }, 15_000)

  it('changes nothing once the strict receipt describes an earlier reply', async () => {
    await seedFacts('chat-reads-notref-changed', strictStatic({ state: 'changed' }))
    expect(await badgeTitle('chat-reads-notref-changed')).toBe(STORED_STATE)
    expect(wrapper()?.classList.contains('zipped')).toBe(false)
  }, 15_000)
})
