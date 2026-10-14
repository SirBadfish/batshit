import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  session: null as any,
  zip: null as any,
  messages: [] as any[],
  group: null as any,
  activeMessageId: null as string | null
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: vi.fn(async () => state.session),
    getZip: vi.fn(async () => state.zip),
    getAllMessages: vi.fn(async () => state.messages),
    getGroup: vi.fn(async () => state.group)
  }
}))
vi.mock('../streamAbortRegistry', () => ({
  getActiveStream: vi.fn(() => state.activeMessageId
    ? { messageId: state.activeMessageId }
    : null)
}))

const { fetchZipForModel, FETCH_ZIP_PAGE_MAX_CHARS, MAX_FETCH_ZIP_CHARS } = await import('../fetchZipForModel')
const ZIP_ID = 'tool_raw_1790000000000_abcd'
const context = { userId: 'user-1', sessionId: 'chat-1', agentId: 'agent-a', messageId: 'reply-1' }

function zip(metadata: Record<string, any>, content = 'x'.repeat(180)) {
  return { id: ZIP_ID, type: 'tool_raw', content, metadata, tokens: 45 }
}

function message(agentId = 'agent-a') {
  return {
    id: 'reply-1', session_id: 'chat-1', user_id: 'user-1', role: 'assistant',
    agent_id: agentId,
    content: `{{batshit-zip:${ZIP_ID}:::tool result}}`,
    metadata: { zipIds: [ZIP_ID] }
  }
}

beforeEach(() => {
  state.session = { id: 'chat-1', user_id: 'user-1', metadata: {} }
  state.zip = zip({ userId: 'user-1', sessionId: 'chat-1', messageId: 'reply-1' })
  state.messages = []
  state.group = null
  state.activeMessageId = null
})

describe('model Fetch Zip ownership and pages', () => {
  it('pages content without repeating page one and returns a typed continuation', async () => {
    const result = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: 64, offset: 64 })
    expect(result).toMatchObject({
      found: true, offset: 64, nextOffset: 128,
      contentLength: 180, contentTruncated: true, content: 'x'.repeat(64)
    })
    expect(result.readMore).toContain('offset 128')
    const last = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: 64, offset: 128 })
    expect(last).toMatchObject({ found: true, offset: 128, nextOffset: null, contentTruncated: false })
    expect(last.content).toHaveLength(52)
  })

  it('keeps a Unicode pair together at the source page boundary', async () => {
    const full = 'a'.repeat(63) + '😀tail'
    state.zip.content = full
    const first = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: 64 })
    expect(first.content).toBe('a'.repeat(63))
    expect(first.nextOffset).toBe(63)
    const second = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: 64, offset: first.nextOffset })
    expect(first.content + second.content).toBe(full)
  })

  // BL-676: a 250,000-character page used to meet the size guard, which cut it again while its
  // own next offset still named the uncut end, so the text between was never read.
  it.each([
    ['ASCII lines', 'plain text line\n'],
    ['quotes and backslashes', 'say "hi" \\ there\n'],
    ['control characters', `${String.fromCharCode(1)}${String.fromCharCode(31)}\t\n`],
    ['CJK', '漢字かな混じり文\n'],
    ['emoji', '😀🎉x']
  ])('fits every %s page under the page limit and reads all of it in order', async (_label, unit) => {
    const full = unit.repeat(Math.ceil(400_000 / unit.length)).slice(0, 400_000)
    state.zip.content = full
    let offset = 0
    let seen = ''
    let pages = 0
    while (true) {
      const page = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: MAX_FETCH_ZIP_CHARS, offset })
      pages += 1
      expect(page.found).toBe(true)
      expect(JSON.stringify(page, null, 2).length).toBeLessThanOrEqual(FETCH_ZIP_PAGE_MAX_CHARS)
      expect(page.offset).toBe(offset)
      expect(page.content.length).toBeGreaterThan(0)
      expect(page.content).toBe(full.slice(offset, offset + page.content.length))
      seen += page.content
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBe(offset + page.content.length)
      expect(page.readMore).toContain(`offset ${page.nextOffset},`)
      expect(page.readMore).toContain('so that it fits one result')
      offset = page.nextOffset
    }
    expect(seen).toBe(full)
    expect(pages).toBeGreaterThan(4)
  })

  it('returns a small page whole, and refuses a page whose details alone cannot fit', async () => {
    state.zip.content = 'y'.repeat(1_000)
    const whole = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: MAX_FETCH_ZIP_CHARS })
    expect(whole).toMatchObject({ found: true, nextOffset: null, contentTruncated: false })
    expect(whole.content).toBe('y'.repeat(1_000))
    expect(whole).not.toHaveProperty('readMore')

    state.zip.description = 'd'.repeat(FETCH_ZIP_PAGE_MAX_CHARS)
    const refused = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: MAX_FETCH_ZIP_CHARS })
    expect(refused).toMatchObject({ found: false, code: 'PAGE_DOES_NOT_FIT' })
  })

  // Review of BL-676: when the details nearly fill a page, only one or two characters fit. The
  // page must never end inside a pair; it is shorter, or refused, instead.
  it.each([['pairs only', '😀'.repeat(500)], ['a letter, then pairs', `a${'😀'.repeat(500)}`]])(
    'never splits a pair when the details leave room for a character or two (%s)',
    async (_label, full) => {
      state.zip.content = full
      state.zip.description = ''
      const empty = JSON.stringify({ ...(await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: 64 })), content: '' }, null, 2).length
      const seen = new Set<string>()
      for (let spare = -8; spare <= 160; spare += 1) {
        state.zip.description = 'd'.repeat(Math.max(0, FETCH_ZIP_PAGE_MAX_CHARS - empty - spare))
        const page = await fetchZipForModel(context, { zipId: ZIP_ID, maxChars: MAX_FETCH_ZIP_CHARS })
        if (page.found === false) {
          expect(page.code).toBe('PAGE_DOES_NOT_FIT')
          seen.add('refused')
          continue
        }
        expect(JSON.stringify(page, null, 2).length).toBeLessThanOrEqual(FETCH_ZIP_PAGE_MAX_CHARS)
        expect(page.content.length).toBeGreaterThan(0)
        expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/)
        expect(full.slice(page.nextOffset ?? full.length)).not.toMatch(/^[\uDC00-\uDFFF]/)
        expect(page.content).toBe(full.slice(0, page.content.length))
        seen.add(page.content.length <= 2 ? 'tiny page' : 'page')
      }
      expect(seen).toEqual(new Set(['refused', 'tiny page', 'page']))
    }
  )

  it('refuses malformed or past-end offsets instead of silently clamping', async () => {
    for (const offset of [-1, 1.5, Number.NaN, 180]) {
      const result = await fetchZipForModel(context, { zipId: ZIP_ID, offset })
      expect(result.found).toBe(false)
      expect(result.code).toMatch(/INVALID_OFFSET|OFFSET_PAST_END/)
    }
  })

  it('requires the vouched chat even when a zip names the same user', async () => {
    const otherChat = await fetchZipForModel({ ...context, sessionId: 'chat-2' }, { zipId: ZIP_ID })
    expect(otherChat).toMatchObject({ found: false, reason: 'Zip belongs to a different chat.' })
    const missingScope = await fetchZipForModel({ ...context, sessionId: null }, { zipId: ZIP_ID })
    expect(missingScope).toMatchObject({ found: false, code: 'MODEL_SCOPE_REQUIRED' })
  })

  it('allows a legacy user-only zip only through this chat\'s saved trusted metadata', async () => {
    state.zip = zip({ userId: 'user-1' })
    state.messages = [message()]
    expect((await fetchZipForModel(context, { zipId: ZIP_ID })).found).toBe(true)
    state.messages = [{ ...message(), metadata: {} }]
    expect((await fetchZipForModel(context, { zipId: ZIP_ID })).found).toBe(false)
    state.messages = [{ ...message(), content: 'no zip marker' }]
    expect((await fetchZipForModel(context, { zipId: ZIP_ID })).found).toBe(true)
    state.session = { id: 'chat-2', user_id: 'user-1', metadata: {} }
    state.messages = []
    expect((await fetchZipForModel({ ...context, sessionId: 'chat-2' }, { zipId: ZIP_ID })).found)
      .toBe(false)
  })

  it('keeps unshared group results with their author and allows exactly shared tools', async () => {
    state.session.metadata = { group_chat: { group_id: 'group-1' } }
    state.group = { id: 'group-1', user_id: 'user-1', shared_tools: [] }
    state.zip = zip({ userId: 'user-1', sessionId: 'chat-1', messageId: 'reply-1', toolName: 'web_search' })
    state.messages = [message()]
    expect((await fetchZipForModel(context, { zipId: ZIP_ID })).found).toBe(true)
    const other = { ...context, agentId: 'agent-b' }
    expect((await fetchZipForModel(other, { zipId: ZIP_ID })).found).toBe(false)
    state.group.shared_tools = ['web_search']
    expect((await fetchZipForModel(other, { zipId: ZIP_ID })).found).toBe(true)
  })

  it('reads a newly retained raw zip before save only for its verified live author', async () => {
    state.session.metadata = { group_chat: { group_id: 'group-1' } }
    state.group = { id: 'group-1', user_id: 'user-1', shared_tools: ['web_search'] }
    state.zip = zip({
      userId: 'user-1', sessionId: 'chat-1', messageId: 'reply-1', agentId: 'agent-a',
      retainedForSizeGuard: true, toolName: 'web_search'
    })
    state.activeMessageId = 'reply-1'
    expect((await fetchZipForModel(context, { zipId: ZIP_ID })).found).toBe(true)
    expect((await fetchZipForModel({ ...context, agentId: 'agent-b' }, { zipId: ZIP_ID })).found)
      .toBe(false)
    state.activeMessageId = null
    expect((await fetchZipForModel(context, { zipId: ZIP_ID })).found).toBe(false)
    state.messages = [message()]
    expect((await fetchZipForModel(context, { zipId: ZIP_ID })).found).toBe(true)
  })
})
