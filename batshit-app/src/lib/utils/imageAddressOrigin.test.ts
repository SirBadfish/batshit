import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import {
  buildImageAddressRecord,
  classifyImageAddressOrigin,
  classifyImageAddressOrigins,
  decideImageAddressOrigin,
  extractWholeAddresses,
  IMAGE_ADDRESS_ORIGIN_TABLE,
  imageAddressOriginLine,
  isOutsideNote,
  MAX_ADDRESS_TOKEN_LENGTH,
  type ImageAddressEvidence,
  toAddressMatchForm,
  type AddressSourcePiece,
  type BuildImageAddressRecordOptions
} from './imageAddressOrigin'

/** The reply parser's own decoding of an attribute value (Cheerio, as `messageFormatter.ts` loads it). */
function decodeAsAttribute(token: string): string {
  const $ = cheerio.load(`<root><img src="${token}"></root>`, { xml: { xmlMode: false, decodeEntities: true } })
  return $('img').attr('src') ?? ''
}

const API = { complete: true, decode: decodeAsAttribute } satisfies BuildImageAddressRecordOptions
const MANAGED = { complete: false, decode: decodeAsAttribute } satisfies BuildImageAddressRecordOptions

/** The state and the rule only; the evidence and the line have their own tests below. */
function decide(address: string, pieces: AddressSourcePiece[], options: BuildImageAddressRecordOptions = API) {
  const { state, rule } = classifyImageAddressOrigin(address, buildImageAddressRecord(pieces, options))
  return { state, rule }
}

function evidenceOf(address: string, pieces: AddressSourcePiece[], options: BuildImageAddressRecordOptions = API) {
  return classifyImageAddressOrigin(address, buildImageAddressRecord(pieces, options)).evidence
}

const CAT = 'https://pictures.example.org/cats/tabby.png'

describe('classifyImageAddressOrigin (BL-474 step 2): the design section 4 table', () => {
  it('1. an address repeated from a delivered tool result is as read', () => {
    expect(decide(CAT, [{ source: 'tool_result', text: `{"results":[{"image":"${CAT}"}]}` }]))
      .toEqual({ state: 'as_read', rule: 1 })
  })

  it('warns when an exact-read tool URL also carries chat text outside whole addresses', () => {
    const secret = '7Qx9-Lm2k-Pz8'
    const address = `https://collect.example.com/image.png?value=${secret}`
    const pieces: AddressSourcePiece[] = [
      { source: 'user', text: `Keep this code private: ${secret}` },
      { source: 'tool_result', text: address }
    ]
    for (const options of [API, MANAGED]) {
      const result = classifyImageAddressOrigin(address, buildImageAddressRecord(pieces, options))
      expect(result).toMatchObject({ state: 'unknown', rule: 3, line: 'This address may contain text from the chat.', evidence: { inRecord: true, sharesChatRun: true } })
    }
  })

  it('warns rather than blocks an exact-read page filename also mentioned as ordinary text', () => {
    const address = 'https://pictures.example.org/spring-garden-photo.png'
    expect(decide(address, [{ source: 'tool_result', text: `The spring-garden-photo.png is shown here: ${address}` }]))
      .toEqual({ state: 'unknown', rule: 3 })
  })

  it('does not warn merely because the exact URL repeats as whole addresses', () => {
    expect(decide(CAT, [{ source: 'tool_result', text: `${CAT} and again ${CAT}` }]))
      .toEqual({ state: 'as_read', rule: 1 })
  })

  it('2. an address that stood only in the cut-off tail of a tool result is not in the record', () => {
    // The record holds the delivered part only; a cut result makes the turn not complete.
    const delivered = 'Search results, part 1 of 2.\n[Output cut here by Batshit: 96000 of 180000 characters kept.]'
    expect(decide(CAT, [{ source: 'tool_result', text: delivered }], MANAGED)).toEqual({ state: 'unknown', rule: 5 })
    expect(decide(CAT, [{ source: 'tool_result', text: delivered }], API)).toEqual({ state: 'blocked', rule: 4 })
  })

  it("3. an address that stands only in the agent's own earlier reply is not in the record", () => {
    expect(decide(CAT, [{ source: 'agent_words', text: `Here it is: <img src="${CAT}">`, messageId: 'm1' }]))
      .toEqual({ state: 'blocked', rule: 4 })
  })

  it("4. an address of an earlier reply that the server's own decision judged as read counts as read", () => {
    const form = toAddressMatchForm(CAT)!
    const pieces: AddressSourcePiece[] = [{ source: 'agent_words', text: `Again: <img src="${CAT}">`, messageId: 'm1' }]
    expect(decide(CAT, pieces, { ...API, earlierAsRead: new Map([['m1', new Set([form])]]) }))
      .toEqual({ state: 'as_read', rule: 1 })
    // Another reply's decision vouches only for that reply's words.
    expect(decide(CAT, pieces, { ...API, earlierAsRead: new Map([['m2', new Set([form])]]) }))
      .toEqual({ state: 'blocked', rule: 4 })
    // A decision vouches for the addresses it judged as read, not for the reply's other addresses.
    const other = 'https://collect.example.com/p.png'
    expect(
      decide(other, [{ source: 'agent_words', text: `<img src="${CAT}"> <img src="${other}">`, messageId: 'm1' }], {
        ...API,
        earlierAsRead: new Map([['m1', new Set([form])]])
      })
    ).toEqual({ state: 'blocked', rule: 4 })
    // A decision vouches only for an address that stands in this turn's compiled text of that reply.
    expect(
      decide(CAT, [{ source: 'agent_words', text: 'The picture is gone from here.', messageId: 'm1' }], {
        ...API,
        earlierAsRead: new Map([['m1', new Set([form])]])
      })
    ).toEqual({ state: 'blocked', rule: 4 })
  })

  it('5. a whole-token match never counts an address inside a longer address', () => {
    const longer = `https://tracker.example.net/r?next=${CAT}`
    // Not rule 1: the inner address is part of the longer one; its text is evidence for rule 3.
    expect(decide(CAT, [{ source: 'tool_result', text: `Visit ${longer} now` }])).toEqual({ state: 'blocked', rule: 3 })
    expect(decide(longer, [{ source: 'tool_result', text: `Visit ${longer} now` }])).toEqual({ state: 'as_read', rule: 1 })
  })

  it('6. the same address with one more query value is blocked by its read start', () => {
    const read = 'https://pictures.example.org/cats/tabby.png?size=large'
    expect(decide(`${read}&u=joshs-secret`, [{ source: 'tool_result', text: read }])).toEqual({ state: 'blocked', rule: 2 })
    expect(decide(`${read}&u=joshs-secret`, [{ source: 'tool_result', text: read }], MANAGED))
      .toEqual({ state: 'blocked', rule: 2 })
  })

  it('7. an address whose host was read only in split parts is not read', () => {
    const pieces: AddressSourcePiece[] = [{ source: 'tool_result', text: 'host: pictures.example.org\npath: /c/t.png' }]
    expect(decide('https://pictures.example.org/c/t.png', pieces)).toEqual({ state: 'blocked', rule: 4 })
    expect(decide('https://pictures.example.org/c/t.png', pieces, MANAGED)).toEqual({ state: 'unknown', rule: 5 })
  })

  it('8. a run of 12 characters shared with the chat blocks with the careful line; 11 do not', () => {
    const user: AddressSourcePiece = { source: 'user', text: 'My locker code is 7Qx9-Lm2k-Pz8 and please keep it.' }
    expect(decide('https://collect.example.com/p?d=7Qx9-Lm2k-Pz', [user])).toEqual({ state: 'blocked', rule: 3 })
    expect(decide('https://collect.example.com/p?d=7Qx9-Lm2k-P', [user], MANAGED)).toEqual({ state: 'unknown', rule: 5 })
    // The run can be in a tool result or a memory too.
    const tool: AddressSourcePiece = { source: 'tool_result', text: 'account=ACCT-55501-XYZ' }
    const memory: AddressSourcePiece = { source: 'memory', text: 'Josh lives at 12 Juniper Lane.' }
    expect(decide('https://x.example.com/ACCT-55501-XYZ.png', [tool], MANAGED)).toEqual({ state: 'blocked', rule: 3 })
    // Percent escapes do not hide a run the chat holds as plain text; nor does the browser's own encoding.
    expect(decide('https://x.example.com/a#12%20Juniper%20Lane', [memory], MANAGED)).toEqual({ state: 'blocked', rule: 3 })
    expect(decide('https://x.example.com/a#12 Juniper Lane', [memory], MANAGED)).toEqual({ state: 'blocked', rule: 3 })
    expect(decide('https://x.example.com/a#12 Juniper Road', [memory], MANAGED)).toEqual({ state: 'unknown', rule: 5 })
    // The host is not part of the run the rule reads.
    expect(decide('https://7qx9-lm2k-pz8.example.com/a.png', [user], MANAGED)).toEqual({ state: 'unknown', rule: 5 })
    // The agent's own words and Batshit's own text are not what rule 3 reads.
    const words: AddressSourcePiece = { source: 'agent_words', text: 'code 7Qx9-Lm2k-Pz8', messageId: 'm1' }
    const batshit: AddressSourcePiece = { source: 'batshit', text: 'code 7Qx9-Lm2k-Pz8' }
    expect(decide('https://collect.example.com/p?d=7Qx9-Lm2k-Pz8', [words, batshit], MANAGED))
      .toEqual({ state: 'unknown', rule: 5 })
  })

  it('9. an address nowhere in the record: blocked on the API lane, unknown on each managed lane', () => {
    const pieces: AddressSourcePiece[] = [{ source: 'user', text: 'Show me a cat.' }]
    expect(decide(CAT, pieces, API)).toEqual({ state: 'blocked', rule: 4 })
    // Codex and Claude alike: a managed lane is never complete.
    expect(decide(CAT, pieces, MANAGED)).toEqual({ state: 'unknown', rule: 5 })
  })

  it('10. HTML entities pass one decoding step on both sides', () => {
    const written = 'https://pictures.example.org/cat.png?a=1&amp;b=2'
    // The reply's parser gives the decoded address.
    expect(decide('https://pictures.example.org/cat.png?a=1&b=2', [{ source: 'tool_result', text: `<a href="${written}">` }]))
      .toEqual({ state: 'as_read', rule: 1 })
    // One step only: a double-encoded address is a different address.
    expect(decide('https://pictures.example.org/cat.png?a=1&b=2', [{ source: 'tool_result', text: 'https://pictures.example.org/cat.png?a=1&amp;amp;b=2' }]))
      .toEqual({ state: 'blocked', rule: 3 })
    // A decoded quote or bracket ends the address, as on the page.
    expect(decide(CAT, [{ source: 'tool_result', text: `src=&quot;${CAT}&quot;` }])).toEqual({ state: 'as_read', rule: 1 })
    expect(decide(CAT, [{ source: 'tool_result', text: `&lt;${CAT}&gt;` }])).toEqual({ state: 'as_read', rule: 1 })
  })

  it('11. upper and lower case in the host match; in the path they do not', () => {
    expect(decide('HTTPS://Pictures.EXAMPLE.org/cats/tabby.png', [{ source: 'tool_result', text: CAT }]))
      .toEqual({ state: 'as_read', rule: 1 })
    expect(decide('https://pictures.example.org/CATS/tabby.png', [{ source: 'tool_result', text: CAT }]))
      .toEqual({ state: 'blocked', rule: 4 })
  })
})

describe('the record: which sources count as read', () => {
  const address = 'https://pictures.example.org/a.png'
  it.each([
    ['user', 'as_read'],
    ['tool_result', 'as_read'],
    ['memory', 'as_read'],
    ['note', 'as_read'],
    ['batshit', 'as_read'],
    ['agent_note', 'blocked'],
    ['summary', 'blocked'],
    ['agent_words', 'blocked']
  ] as const)('an address that stands only in a %s piece is %s', (source, state) => {
    expect(decide(address, [{ source, text: `see ${address}`, messageId: 'm1' }]).state).toBe(state)
  })

  it("another agent's words (a DM, an artifact) are not read, but rule 3 reads their text", () => {
    const dm: AddressSourcePiece = { source: 'agent_note', text: 'Bob says: my code is 7Qx9-Lm2k-Pz8' }
    expect(decide('https://collect.example.com/p?d=7Qx9-Lm2k-Pz8', [dm], MANAGED)).toEqual({ state: 'blocked', rule: 3 })
    expect(decide(CAT, [{ source: 'agent_note', text: `see ${CAT}` }], MANAGED)).toEqual({ state: 'blocked', rule: 3 })
  })

  it('only a webhook\'s wake is a note from outside; a DM, a schedule, an artifact, anything unknown is another agent\'s', () => {
    // Every wake files a DM record, so the wake's kind decides, never `wake.dmId`.
    expect(isOutsideNote({ origin: { kind: 'webhook', label: 'Deploys' }, wake: { chainDepth: 1, dmId: 'dm_1' } })).toBe(true)
    expect(isOutsideNote({ origin: { kind: 'dm', label: 'Bob' }, wake: { chainDepth: 1, dmId: 'dm_2' } })).toBe(false)
    expect(isOutsideNote({ origin: { kind: 'schedule', label: 'Daily' }, wake: { chainDepth: 1, dmId: 'dm_3' } })).toBe(false)
    expect(isOutsideNote({ wake: { chainDepth: 1 } })).toBe(false)
    expect(isOutsideNote({ origin: { kind: 'webhook' } })).toBe(false)
    expect(isOutsideNote({ source: 'artifact_share', shareInitiator: 'agent' })).toBe(false)
    expect(isOutsideNote(null)).toBe(false)
  })

  it('a turn Batshit could not account for is never complete', () => {
    expect(buildImageAddressRecord([], { complete: false }).complete).toBe(false)
    expect(buildImageAddressRecord([], {} as BuildImageAddressRecordOptions).complete).toBe(false)
  })
})

describe('extractWholeAddresses', () => {
  it.each(['"', "'", '`'])('a %s-quoted address stops at line and tag boundaries without swallowing later addresses (BL-1021)', (quote) => {
    const later = 'https://b.example/y.png'
    for (const boundary of ['\n', '\r', '\r\n', '<', '>']) {
      const text = `He said ${quote}${CAT}${boundary}then ${quote}best${quote} ${later}`
      expect(extractWholeAddresses(text), JSON.stringify({ quote, boundary })).toEqual([CAT, later])
      expect(decide(CAT, [{ source: 'tool_result', text }])).toEqual({ state: 'as_read', rule: 1 })
      expect(decide(later, [{ source: 'tool_result', text }])).toEqual({ state: 'as_read', rule: 1 })
    }
  })

  it.each(['"', "'", '`'])('a %s-quoted address keeps spaces within its one line (BL-1021)', (quote) => {
    const address = 'https://a.example/spring garden.png'
    expect(extractWholeAddresses(`Picture: ${quote}${address}${quote}`)).toEqual([address])
    expect(decide(address, [{ source: 'tool_result', text: `${quote}${address}${quote}` }]))
      .toEqual({ state: 'as_read', rule: 1 })
  })

  it('reads addresses out of prose, Markdown, HTML, and JSON', () => {
    expect(extractWholeAddresses('See https://a.example/x.png. Then (https://b.example/y.png), and <https://c.example/>!'))
      .toEqual([
        'https://a.example/x.png',
        'https://a.example/x.png.',
        'https://b.example/y.png',
        'https://b.example/y.png)',
        'https://c.example/'
      ])
    expect(extractWholeAddresses('[t](https://a.example/wiki/Cat_(animal)) {"u":"https://b.example/p?q=1"}'))
      .toEqual(['https://a.example/wiki/Cat_(animal)', 'https://a.example/wiki/Cat_(animal))', 'https://b.example/p?q=1'])
  })

  it('never starts an address inside a word or inside a longer address', () => {
    expect(extractWholeAddresses('xhttps://a.example/ and https://b.example/?to=https://c.example/z'))
      .toEqual(['https://b.example/?to=https://c.example/z'])
    // Nor inside a run that is not an address itself.
    expect(extractWholeAddresses('xhttps://a.example/?to=https://c.example/z')).toEqual([])
  })

  it('stays linear on a hostile run of punctuation or brackets, and cuts a very long token', () => {
    const started = Date.now()
    // Cut at the cap, then its trailing dots trimmed: the token as cut and without them.
    expect(extractWholeAddresses(`https://x.example/${'.'.repeat(96_000)}a`)[0]).toBe('https://x.example/')
    expect(extractWholeAddresses(`https://x.example/a${')'.repeat(48_000)}`)).toEqual([
      'https://x.example/a',
      `https://x.example/a${')'.repeat(48_000)}`.slice(0, MAX_ADDRESS_TOKEN_LENGTH)
    ])
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(extractWholeAddresses(`https://x.example/${'a'.repeat(20_000)}`)[0]).toHaveLength(MAX_ADDRESS_TOKEN_LENGTH)
  })

  it('ignores a scheme with nothing after it', () => {
    expect(extractWholeAddresses('https:// and http://')).toEqual([])
  })
})

describe('toAddressMatchForm', () => {
  it('lower-cases the scheme and host only, and writes an empty path as /', () => {
    expect(toAddressMatchForm('HTTPS://User:Pw@Pictures.Example.ORG:8443/A/B?C=D#E'))
      .toBe('https://User:Pw@pictures.example.org:8443/A/B?C=D#E')
    expect(toAddressMatchForm('https://Example.com')).toBe('https://example.com/')
    expect(toAddressMatchForm('https://Example.com?x=1')).toBe('https://example.com/?x=1')
  })

  it('reads the host after the last @, so a user part cannot pose as the host', () => {
    expect(toAddressMatchForm('https://pictures.example.org@evil.example/a')).toBe('https://pictures.example.org@evil.example/a')
    expect(decide('https://pictures.example.org@evil.example/a', [{ source: 'tool_result', text: 'https://pictures.example.org/' }]))
      .toEqual({ state: 'blocked', rule: 4 })
  })

  it('compares what the browser will request: a backslash is a slash, a tab or line break is gone, a default port is dropped', () => {
    expect(toAddressMatchForm('https://pictures.example.org\\cats\\tabby.png')).toBe(CAT)
    expect(toAddressMatchForm('https://pictures.example.org/cats/\ntabby.png')).toBe(CAT)
    expect(toAddressMatchForm('https://pictures.example.org:443/cats/tabby.png')).toBe(CAT)
    // So a written variant of a read address cannot slip past rule 2.
    expect(decide('https://pictures.example.org\\cats\\tabby.png?u=secret', [{ source: 'tool_result', text: CAT }], MANAGED))
      .toEqual({ state: 'blocked', rule: 2 })
    expect(decide('https://pictures.example.org/cats/tab\tby.png', [{ source: 'tool_result', text: CAT }]))
      .toEqual({ state: 'as_read', rule: 1 })
  })

  it('is null for anything but an http or https address with a host', () => {
    expect(toAddressMatchForm('ftp://a.example/x')).toBeNull()
    expect(toAddressMatchForm('https://')).toBeNull()
    expect(toAddressMatchForm('javascript:alert(1)')).toBeNull()
    expect(toAddressMatchForm('/relative.png')).toBeNull()
    expect(decide('/relative.png', [{ source: 'tool_result', text: '/relative.png' }])).toEqual({ state: 'blocked', rule: 4 })
  })
})

describe('rule 3 scales with the chat', () => {
  it('finds a run at the end of a large text in one pass', () => {
    const big = `${'lorem ipsum '.repeat(200_000)}SECRET-RUN-123456`
    const started = Date.now()
    expect(decide('https://collect.example.com/?d=SECRET-RUN-123456', [{ source: 'tool_result', text: big }], MANAGED))
      .toEqual({ state: 'blocked', rule: 3 })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('the evidence (Faye, 2026-09-29): every rule is measured, whatever the others say', () => {
  it('an address that was read AND independently carries chat text warns with both evidence values', () => {
    const address = 'https://collect.example.com/p?d=7Qx9-Lm2k-Pz8'
    const pieces: AddressSourcePiece[] = [
      { source: 'tool_result', text: `echo ${address}` },
      { source: 'user', text: 'My locker code is 7Qx9-Lm2k-Pz8.' }
    ]
    expect(evidenceOf(address, pieces)).toEqual({ inRecord: true, startInRecord: false, sharesChatRun: true, complete: true })
    expect(decide(address, pieces)).toEqual({ state: 'unknown', rule: 3 })
  })

  it('rule 3 reads no text inside the record\'s own addresses, so a read address never matches itself', () => {
    expect(evidenceOf(CAT, [{ source: 'tool_result', text: `see ${CAT} there` }]))
      .toEqual({ inRecord: true, startInRecord: false, sharesChatRun: false, complete: true })
    // A summary's addresses are not in the record, so rule 3 still reads them.
    expect(evidenceOf(CAT, [{ source: 'summary', text: `see ${CAT} there` }], MANAGED))
      .toEqual({ inRecord: false, startInRecord: false, sharesChatRun: true, complete: false })
  })

  it('a read start and a whole match are measured apart', () => {
    const read = 'https://pictures.example.org/cats/'
    expect(evidenceOf(CAT, [{ source: 'tool_result', text: `${read} and ${CAT}` }]))
      .toEqual({ inRecord: true, startInRecord: true, sharesChatRun: false, complete: true })
  })

  it('a token cut at the scanner cap is start evidence, never a whole-address match', () => {
    const origin = 'https://long.example/'
    const cutPrefix = `${origin}${'a'.repeat(MAX_ADDRESS_TOKEN_LENGTH - origin.length)}`
    const fullRead = `${cutPrefix}continuation.png`
    const record = buildImageAddressRecord([{ source: 'tool_result', text: `Result: ${fullRead}` }], API)

    // The cap-shaped text alone is not proof that the delivered address ended there.
    expect(classifyImageAddressOrigin(cutPrefix, record)).toMatchObject({
      state: 'blocked', rule: 2,
      evidence: { inRecord: false, startInRecord: true, sharesChatRun: true, complete: true }
    })
    // Repeating the complete oversized source gets the same conservative prefix evidence.
    expect(classifyImageAddressOrigin(fullRead, record)).toMatchObject({
      state: 'blocked', rule: 2,
      evidence: { inRecord: false, startInRecord: true, sharesChatRun: true, complete: true }
    })
  })

  it('keeps truncated quoted JSON and protocol-relative tokens as start evidence only', () => {
    const origin = '//cdn.example/'
    const cutPrefix = `${origin}${'b'.repeat(MAX_ADDRESS_TOKEN_LENGTH - origin.length)}`
    const fullRead = `${cutPrefix}continued.png`
    const record = buildImageAddressRecord([{ source: 'tool_result', text: `{"src":"${fullRead}"}` }], API)

    for (const scheme of ['http:', 'https:']) {
      expect(classifyImageAddressOrigin(`${scheme}${cutPrefix.slice(2)}`, record)).toMatchObject({
        state: 'blocked', rule: 2,
        evidence: { inRecord: false, startInRecord: true, sharesChatRun: true }
      })
      expect(classifyImageAddressOrigin(`${scheme}${fullRead.slice(2)}`, record)).toMatchObject({
        state: 'blocked', rule: 2,
        evidence: { inRecord: false, startInRecord: true, sharesChatRun: true }
      })
    }
  })

  it('independently records shared runs between different oversized URLs with the same capped prefix', () => {
    const origin = 'https://long.example/'
    const cappedPrefix = `${origin}${'c'.repeat(MAX_ADDRESS_TOKEN_LENGTH - origin.length)}`
    const read = `${cappedPrefix}first-tail.png`
    const different = `${cappedPrefix}second-tail.png`
    const record = buildImageAddressRecord([{ source: 'tool_result', text: `Fetched ${read}` }], API)

    expect(classifyImageAddressOrigin(different, record)).toMatchObject({
      state: 'blocked', rule: 2,
      evidence: { inRecord: false, startInRecord: true, sharesChatRun: true, complete: true }
    })
  })

  it('finds every address that shares a run with one text, not only the first one found', () => {
    const record = buildImageAddressRecord([{ source: 'user', text: 'pin 55501-ACCT-XYZ then code 7Qx9-Lm2k-Pz8' }], MANAGED)
    const decisions = classifyImageAddressOrigins(
      ['https://a.example.com/p?d=7Qx9-Lm2k-Pz8', 'https://b.example.com/p?d=55501-ACCT-XYZ'],
      record
    )
    expect(decisions.map((decision) => decision.evidence.sharesChatRun)).toEqual([true, true])
  })

  it('decides many addresses in one pass, each on its own evidence', () => {
    const record = buildImageAddressRecord(
      [
        { source: 'tool_result', text: CAT },
        { source: 'user', text: 'code 7Qx9-Lm2k-Pz8' }
      ],
      MANAGED
    )
    const decisions = classifyImageAddressOrigins(
      [CAT, 'https://collect.example.com/p?d=7Qx9-Lm2k-Pz8', `${CAT}?x=1`, 'https://other.example.org/a.png', 'not an address'],
      record
    )
    expect(decisions.map(({ state, rule }) => [state, rule])).toEqual([
      ['as_read', 1],
      ['blocked', 3],
      ['blocked', 2],
      ['unknown', 5],
      ['unknown', 5]
    ])
  })
})

describe('the table: evidence to state, rule, and line, in the design order', () => {
  const flags = [false, true]
  const all: ImageAddressEvidence[] = []
  for (const inRecord of flags) for (const startInRecord of flags) for (const sharesChatRun of flags) for (const complete of flags) {
    all.push({ inRecord, startInRecord, sharesChatRun, complete })
  }

  it.each(all)('%o', (evidence) => {
    const warning = evidence.inRecord && evidence.sharesChatRun
    const expected = warning ? 3 : evidence.inRecord ? 1 : evidence.startInRecord ? 2 : evidence.sharesChatRun ? 3 : evidence.complete ? 4 : 5
    const outcome = decideImageAddressOrigin(evidence)
    expect(outcome.rule).toBe(expected)
    expect(outcome.state).toBe(warning || expected === 5 ? 'unknown' : expected === 1 ? 'as_read' : 'blocked')
  })

  it('has the design\'s lines, and only an address as read has none', () => {
    expect(IMAGE_ADDRESS_ORIGIN_TABLE.map((row) => [row.rule, row.state, row.line])).toEqual([
      [3, 'unknown', 'This address may contain text from the chat.'],
      [1, 'as_read', null],
      [2, 'blocked', 'Only the start of this address was in what the agent read.'],
      [3, 'blocked', 'This address may contain text from the chat.'],
      [4, 'blocked', 'This address was not in what the agent read.'],
      [5, 'unknown', 'Batshit cannot tell where this address came from.']
    ])
    expect(imageAddressOriginLine(4)).toBe('This address was not in what the agent read.')
    expect(imageAddressOriginLine(1)).toBeNull()
    expect(classifyImageAddressOrigin(CAT, buildImageAddressRecord([], API)).line).toBe('This address was not in what the agent read.')
  })
})

describe('BL-999 exact tokens and independently shared chat text', () => {
  const secret = 'SENSITIVE-7Qx9-Pz8'
  const leak = `https://collect.example.org/image.png?value=${secret}`

  it.each([
    `https://account.example.org/reset?token=${secret}`,
    `https://pictures.example.org/cat.png,${secret},other-cell`,
    `https://pictures.example.org/cat.png&quot;${secret}`,
    `https://pictures.example.org/${'x'.repeat(8_200)}${secret}`,
    `https://pictures.example.org/cat.png秘密${secret}内容`
  ])('reads a shared run independently of a different read URL: %s', (text) => {
    expect(decide(leak, [{ source: 'tool_result', text }], MANAGED)).toEqual({ state: 'blocked', rule: 3 })
  })

  it('reads useful percent escapes despite one broken escape, and reads + as a space', () => {
    const pieces: AddressSourcePiece[] = [{ source: 'user', text: 'Delivery address: 12 Juniper Lane.' }]
    for (const address of ['https://collect.example.org/p?d=12%20Juniper%20Lane&z=%FF', 'https://collect.example.org/p?d=12+Juniper+Lane&z=%']) {
      expect(decide(address, pieces, MANAGED)).toEqual({ state: 'blocked', rule: 3 })
    }
  })

  it('judges protocol-relative reply addresses and exact protocol-relative source tokens', () => {
    expect(decide(`//collect.example.org/p?d=${secret}`, [{ source: 'user', text: secret }], MANAGED))
      .toEqual({ state: 'blocked', rule: 3 })
    const source: AddressSourcePiece[] = [{ source: 'tool_result', text: '<img src="//pictures.example.org/cats/tabby.png">' }]
    expect(decide(CAT, source)).toEqual({ state: 'as_read', rule: 1 })
    expect(decide('//pictures.example.org/cats/tabby.png', source)).toEqual({ state: 'as_read', rule: 1 })
  })

  it.each([
    ['https://pictures.example.org/a.png?a=1&b=2', '{"url":"https://pictures.example.org/a.png?a=1\\u0026b=2"}'],
    [CAT, '{"url":"https:\\/\\/pictures.example.org\\/cats\\/tabby.png"}'],
    ["https://pictures.example.org/cat's.png", `<img src="https://pictures.example.org/cat's.png">`],
    ['https://pictures.example.org/a%20b.png', '<img src="https://pictures.example.org/a b.png">'],
    ['https://pictures.example.org/a|b.png', '<img src="https://pictures.example.org/a|b.png">'],
    ['https://pictures.example.org/a%7Bb%7D.png', '<img src="https://pictures.example.org/a{b}.png">'],
    [CAT, 'Picture: https://pictures.example.org/cats/tabby.png。']
  ])('repeats the exact requested address from its source representation: %s', (address, text) => {
    expect(decide(address, [{ source: 'tool_result', text }], MANAGED)).toEqual({ state: 'as_read', rule: 1 })
  })

  it('records only the read prefix when a quoted source address crosses a line boundary (BL-1021)', () => {
    expect(decide(CAT, [{ source: 'tool_result', text: '<img src="https://pictures.example.org/cats/\ntabby.png">' }], MANAGED))
      .toEqual({ state: 'blocked', rule: 2 })
  })
})
