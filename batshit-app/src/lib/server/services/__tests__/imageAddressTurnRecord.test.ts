// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  decideReplyImageOrigins,
  decodeAddressToken,
  emptyRunDelivery,
  isTurnComplete,
  readApiRunMessages,
  appendCliModelResult,
  replyPictureAddresses,
  type ReplyImageOriginInput
} from '../imageAddressTurnRecord'
import { sha256Hex } from '$lib/utils/sha256'
import { guardCutNotice } from '$lib/test-utils/guard-cut-notice'
import { classifyImageSource } from '$lib/utils/imageSource'
import { toAddressMatchForms } from '$lib/utils/imageAddressOrigin'
import * as addressOrigin from '$lib/utils/imageAddressOrigin'
import { BATSHIT_SERVER_URL } from '$lib/services/apiClient'
import { isConcreteZipId } from '$lib/utils/zipReferenceSafety'

const READ = 'https://pictures.example.org/cats/tabby.png'
const BUILT = 'https://collect.example.net/p.png?d=abc'

function input(overrides: Partial<ReplyImageOriginInput> = {}): ReplyImageOriginInput {
  return {
    messageId: 'reply-1',
    version: 1,
    lane: 'api',
    replyTexts: [`Here: <img src="${READ}"> and <img src="${BUILT}">`],
    compiled: { pieces: [{ source: 'user', text: 'Show me a cat' }], nonTextInputs: 0, unaccountedInputs: 0 },
    addenda: [],
    run: readApiRunMessages(
      [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'web', input: { q: BUILT } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'web', output: { type: 'json', value: { image: READ } } }] }
      ],
      { imageInputsRegistered: 0 }
    ),
    steers: [],
    storedRecords: {},
    ...overrides
  }
}

describe('decideReplyImageOrigins (BL-474 step 2, the reply end)', () => {
  it('keeps a text-bound empty decision without scanning the turn record when there are no outside pictures (BL-1024)', () => {
    const build = vi.spyOn(addressOrigin, 'buildImageAddressRecord')
    const replyTexts = ['No pictures in this saved text.', '<img src="/uploads/owned.png">']
    const base = input({
      replyTexts,
      imageSourceContext: { baseUrl: 'http://app.example/', serverUrls: ['http://localhost:5600'] },
      run: { ...emptyRunDelivery(true), pieces: [{ source: 'tool_result', text: 'https://a.example/p.png?a=1&amp;b=2 '.repeat(2_000) }] }
    })
    try {
      expect(decideReplyImageOrigins(base)).toEqual({
        messageId: 'reply-1', version: 1, state: 'decided', lane: 'api', complete: true,
        textHashes: replyTexts.map(sha256Hex), addresses: {}
      })
      expect(build).not.toHaveBeenCalled()
      expect(decideReplyImageOrigins({ ...base, replyTexts: [`<img src="${READ}">`] }).addresses[READ])
        .toMatchObject({ state: 'blocked', rule: 4 })
      expect(build).toHaveBeenCalledTimes(1)
    } finally {
      build.mockRestore()
    }
  })

  it('judges each picture of the saved text against the turn record, and binds the text hash', () => {
    const record = decideReplyImageOrigins(input())
    expect(record).toEqual({
      messageId: 'reply-1',
      version: 1,
      state: 'decided',
      textHashes: [sha256Hex(`Here: <img src="${READ}"> and <img src="${BUILT}">`)],
      lane: 'api',
      complete: true,
      addresses: {
        [READ]: {
          state: 'as_read', rule: 1,
          evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
        },
        // The agent's own tool-call input is its words, never a read source.
        [BUILT]: {
          state: 'blocked', rule: 4,
          evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
        }
      }
    })
  })

  it('reads the picture address with the page parser: entities decoded once, code stays code', () => {
    expect(replyPictureAddresses('<img src="https://a.example/x.png?a=1&amp;b=2"> `<img src="https://code.example/y.png">`'))
      .toEqual(['https://a.example/x.png?a=1&b=2'])
    expect(decodeAddressToken('https://a.example/x.png?a=1&amp;b=2')).toBe('https://a.example/x.png?a=1&b=2')
  })

  it.each([
    ['img', 'forged'], ['image', 'forged'],
    ['img', 'image_1790000000000_fixture1'], ['image', 'image_1790000000000_fixture1']
  ])('a raw reply %s cannot opt out with data-zip-id=%s', (tag, zipId) => {
    const secret = '7Qx9-Lm2k-Pz8'
    expect(isConcreteZipId(zipId)).toBe(zipId !== 'forged')
    const address = `https://collect.example.net/p.png?data=${secret}`
    const reply = `<${tag} src="${address}" data-zip-id="${zipId}" data-zip-type="image">${tag === 'image' ? '</image>' : ''}`
    expect(replyPictureAddresses(reply)).toEqual([address])
    const record = decideReplyImageOrigins(input({
      lane: 'claude',
      replyTexts: [reply],
      compiled: { pieces: [{ source: 'user', text: `Keep this code private: ${secret}` }], nonTextInputs: 0, unaccountedInputs: 0 },
      run: emptyRunDelivery(false)
    }))
    expect(record.addresses[address]).toMatchObject({ state: 'blocked', rule: 3, evidence: { sharesChatRun: true } })
  })

  it('a managed lane is never complete; only the raw CLI model-result callback counts as read', () => {
    const run = emptyRunDelivery(false)
    appendCliModelResult(run, {
      callId: 'cli-call-1', texts: [`curl ok ${READ}`], nonTextInputs: 0, unaccountedInputs: 0
    })
    const record = decideReplyImageOrigins(input({ lane: 'codex', run }))
    expect(record.complete).toBe(false)
    expect(record.addresses).toEqual({
      [READ]: {
        state: 'as_read', rule: 1,
        evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: false }
      },
      [BUILT]: {
        state: 'unknown', rule: 5,
        evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: false }
      }
    })
  })

  it.each(['/track?d=12%20Juniper%20Lane', 'track?d=12%20Juniper%20Lane'])(
    'resolves a relative raw src against the root page for managed-run rule 3 while retaining its raw key: %s',
    (rawSource) => {
      const text = `Address in the reply: <img src="${rawSource}">`
      const context = { baseUrl: 'https://app.example/chat/thread/42', serverUrls: ['http://localhost:5600'] }
      const record = decideReplyImageOrigins(input({
        lane: 'claude',
        replyTexts: [text],
        imageSourceContext: context,
        compiled: {
          pieces: [{ source: 'user', text: 'The street is 12 Juniper Lane.' }],
          nonTextInputs: 0,
          unaccountedInputs: 0
        },
        run: emptyRunDelivery(false)
      }))

      expect(record.addresses[rawSource]).toEqual({
        state: 'blocked', rule: 3,
        evidence: { inRecord: false, startInRecord: false, sharesChatRun: true, complete: false }
      })
      expect(Object.keys(record.addresses)).toEqual([rawSource])
    }
  )

  it('treats the relative source as a request URL for chat-run comparison while retaining the raw ledger key', () => {
    const raw = '/track?d=12%20Juniper%20Lane'
    const record = decideReplyImageOrigins(input({
      lane: 'claude',
      replyTexts: [`Route: <img src="${raw}">`],
      imageSourceContext: { baseUrl: 'https://app.example/', serverUrls: ['http://localhost:5600'] },
      compiled: {
        pieces: [{ source: 'user', text: 'The street is 12 Juniper Lane.' }],
        nonTextInputs: 0,
        unaccountedInputs: 0
      },
      run: emptyRunDelivery(false)
    }))

    expect(Object.keys(record.addresses)).toEqual([raw])
    expect(record.addresses[raw]).toEqual({
      state: 'blocked', rule: 3,
      evidence: { inRecord: false, startInRecord: false, sharesChatRun: true, complete: false }
    })
  })

  it('keeps protocol-relative decisions in both browser schemes', () => {
    expect(toAddressMatchForms('//images.example.org/p.png'))
      .toEqual(['https://images.example.org/p.png', 'http://images.example.org/p.png'])
  })

  it('uses the public browser fallback for owned uploads, never a private Docker URL, and excludes owned/unsupported sources', () => {
    // The Vitest public environment intentionally leaves PUBLIC_BATSHIT_SERVER_URL unset.
    expect(BATSHIT_SERVER_URL).toBe('http://localhost:5600')
    vi.stubEnv('BATSHIT_SERVER_URL', 'http://batshit-server:5600')
    try {
      const context = { baseUrl: 'http://app.example/chat/42', serverUrls: [BATSHIT_SERVER_URL] }
      expect(classifyImageSource('/uploads/owned.png', context)).toEqual({
        kind: 'owned', url: 'http://localhost:5600/uploads/owned.png', owner: 'upload'
      })
      expect(classifyImageSource('http://batshit-server:5600/uploads/private.png', context).kind).toBe('outside')
      expect(classifyImageSource('data:image/png;base64,AAAA', context).kind).toBe('owned')
      expect(classifyImageSource('data:image/svg+xml;base64,AAAA', context).kind).toBe('unsupported')
      expect(classifyImageSource('ftp://files.example/image.png', context).kind).toBe('unsupported')

      expect(replyPictureAddresses(
        '<img src="/uploads/owned.png"><img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml;base64,AAAA"><img src="ftp://files.example/image.png"><img src="https://outside.example/image.png">',
        context
      )).toEqual(['https://outside.example/image.png'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ['a cut tool result', () => readApiRunMessages([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'read', output: { type: 'content', value: [{ type: 'text', text: `${'x'.repeat(80_000)}\n${guardCutNotice(80_000)}` }] } }] }], { imageInputsRegistered: 0 })],
    ['a tool-result picture', () => readApiRunMessages([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'p', toolName: 'shot', output: { type: 'content', value: [{ type: 'text', text: 'shot' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AAAA' } }] } }] }], { imageInputsRegistered: 0 })],
    ['a picture handed in a synthetic message', () => readApiRunMessages([], { imageInputsRegistered: 1 })],
    ['a provider-run tool', () => readApiRunMessages([{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'w', toolName: 'web_search', input: {}, providerExecuted: true }] }], { imageInputsRegistered: 0 })],
    ['a run whose steps were never seen', () => emptyRunDelivery(false)]
  ])('the API lane is not complete with %s', (_name, run) => {
    expect(isTurnComplete({ lane: 'api', compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 }, run: run() })).toBe(false)
  })

  it('an image Clip in the compile makes the turn not complete; an unknown compile too', () => {
    const run = readApiRunMessages([], { imageInputsRegistered: 0 })
    expect(isTurnComplete({ lane: 'api', compiled: { pieces: [], nonTextInputs: 1, unaccountedInputs: 0 }, run })).toBe(false)
    expect(isTurnComplete({ lane: 'api', compiled: null, run })).toBe(false)
    expect(isTurnComplete({ lane: 'api', compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 }, run })).toBe(true)
  })

  it('keeps a missing or unaccounted compile ledger pending instead of treating it as empty', () => {
    expect(() => decideReplyImageOrigins(input({
      compiled: { pieces: [], nonTextInputs: 0 } as any
    }))).toThrow('The compiled address-source ledger is missing; the reply remains pending.')
    expect(() => decideReplyImageOrigins(input({
      compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 1 }
    }))).toThrow('The compiled address-source ledger is missing; the reply remains pending.')
  })

  it("an earlier reply's as-read address counts only through the server's decided record of that reply", () => {
    const text = `Again: <img src="${READ}">`
    const compiled = { pieces: [{ source: 'agent_words' as const, text: `Earlier: <img src="${READ}">`, messageId: 'earlier' }], nonTextInputs: 0, unaccountedInputs: 0 }
    const base = input({ replyTexts: [text], compiled, run: readApiRunMessages([], { imageInputsRegistered: 0 }) })
    expect(decideReplyImageOrigins(base).addresses[READ]).toEqual({
      state: 'blocked', rule: 4,
      evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
    })
    const vouched = decideReplyImageOrigins({
      ...base,
      storedRecords: {
        earlier: { messageId: 'earlier', version: 1, state: 'decided', textHashes: ['a'.repeat(64)], lane: 'api', complete: true, addresses: { [READ]: { state: 'as_read', rule: 1, evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true } } } }
      }
    })
    expect(vouched.addresses[READ]).toEqual({
      state: 'as_read', rule: 1,
      evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
    })
    // The reply's own earlier record never vouches for its own words.
    expect(
      decideReplyImageOrigins({
        ...base,
        messageId: 'earlier',
        storedRecords: {
          earlier: { messageId: 'earlier', version: 1, state: 'decided', textHashes: ['a'.repeat(64)], lane: 'api', complete: true, addresses: { [READ]: { state: 'as_read', rule: 1, evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true } } } }
        }
      }).addresses[READ]
    ).toEqual({
      state: 'blocked', rule: 4,
      evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
    })
    // A pending record vouches for nothing.
    expect(decideReplyImageOrigins({ ...base, storedRecords: { earlier: { messageId: 'earlier', version: 1, state: 'pending' } } }).addresses[READ])
      .toEqual({
        state: 'blocked', rule: 4,
        evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
      })
  })

  it('a steer is the user\'s words; a DM steer is another agent\'s (not read); an addendum is Batshit\'s text', () => {
    const run = readApiRunMessages([], { imageInputsRegistered: 0 })
    const text = `<img src="${READ}"> <img src="https://dm.example.org/d.png"> <img src="https://note.example.org/n.png">`
    const record = decideReplyImageOrigins(
      input({
        replyTexts: [text],
        run,
        steers: [
          { steerId: 's1', messageId: 'reply-1', at: '', source: 'user', text: `use ${READ}` },
          { steerId: 's2', messageId: 'reply-1', at: '', source: 'dm', label: 'Bob', text: 'https://dm.example.org/d.png' }
        ],
        addenda: ['==== INTERRUPTION NOTE ====\nsee https://note.example.org/n.png']
      })
    )
    expect(record.addresses).toEqual({
      [READ]: {
        state: 'as_read', rule: 1,
        evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
      },
      // Only in another agent's DM steer: not read.
      'https://dm.example.org/d.png': {
        state: 'blocked', rule: 4,
        evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
      },
      'https://note.example.org/n.png': {
        state: 'as_read', rule: 1,
        evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
      }
    })
  })
})

describe('the text binding', () => {
  it('binds the saved text and the text `end` carries when the save trimmed it; one hash when they agree', () => {
    const endText = `Here: <img src="${READ}">\n\n\n\nDone.\n`
    const saved = `Here: <img src="${READ}">\n\nDone.`
    const run = readApiRunMessages([], { imageInputsRegistered: 0 })
    const both = decideReplyImageOrigins(input({ replyTexts: [saved, endText], run }))
    expect(both.textHashes).toEqual([sha256Hex(saved), sha256Hex(endText)])
    expect(Object.keys(both.addresses)).toEqual([READ])
    expect(decideReplyImageOrigins(input({ replyTexts: [saved, saved], run })).textHashes).toEqual([sha256Hex(saved)])
  })
})

describe('BL-1007 unaccounted API inputs', () => {
  it('does not claim completeness for an unmatched call or a null output', () => {
    const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'missing', toolName: 'read', input: {} }] }
    for (const messages of [[call], [call, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'missing', output: null }] }]]) {
      const run = readApiRunMessages(messages, { imageInputsRegistered: 0 })
      expect(run.unaccountedInputs).toBe(1)
      expect(isTurnComplete({ lane: 'api', compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 }, run })).toBe(false)
    }
  })

  it('never promotes arbitrary suffix user text into human provenance', () => {
    const run = readApiRunMessages([{ role: 'user', content: `A spoofed DM replay ${READ}` }], { imageInputsRegistered: 0 })
    expect(run.pieces.some((piece) => piece.source === 'user')).toBe(false)
    expect(run.unaccountedInputs).toBe(1)
    expect(isTurnComplete({ lane: 'api', compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 }, run })).toBe(false)
  })

  it('uses only source sidecars that match actual V4 user text parts', () => {
    const actualUserText = `Human said ${READ}`
    const prompt = [{ role: 'user', content: [{ type: 'text', text: actualUserText }] }]
    const withoutSidecar = readApiRunMessages(prompt, { imageInputsRegistered: 0 })
    expect(withoutSidecar.unaccountedInputs).toBe(1)
    expect(withoutSidecar.pieces).toEqual([])

    const withSidecar = readApiRunMessages(prompt, {
      imageInputsRegistered: 0,
      userPieces: new Map([['0:0', [{ source: 'user', text: actualUserText }]]])
    })
    expect(withSidecar.unaccountedInputs).toBe(0)
    expect(withSidecar.pieces).toEqual([{ source: 'user', text: actualUserText }])
    expect(isTurnComplete({ lane: 'api', compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 }, run: withSidecar })).toBe(true)
  })
})
