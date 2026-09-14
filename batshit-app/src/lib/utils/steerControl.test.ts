import { describe, expect, it } from 'vitest'
import {
  buildSteerInjectionText,
  buildSteerPlaceholder,
  busySendModeLabel,
  DEFAULT_BUSY_SEND_MODE,
  extractSteerPlaceholderIds,
  formatSteerForModel,
  hasSteerPlaceholder,
  isSteerDeliver,
  isValidSteerId,
  MAX_PENDING_STEERS,
  normalizeGlobalChatSettings,
  otherBusySendMode,
  resolveBusySendActions,
  readMessageSteers,
  resolveBusySendMode,
  resolveQueuedSendAfterWait,
  resolveSteerability,
  resolveStopInterruptionStamp,
  STEER_TEXT_MAX_CHARS,
  STEER_WRAPPER_GUIDANCE_EXAMPLES,
  QUEUED_AFTER_REPLY_SENTENCE,
  QUEUED_WITH_FILES_SENTENCE,
  QUEUE_ONE_AT_A_TIME_SENTENCE,
  classifySteerRefusal,
  type BusySendMode,
  type DeliveredSteer
} from './steerControl'

/**
 * SA-114 — the shared steer rules, in one browser-safe module so the route, the registry,
 * both compile twins, and (from P3) the client all read the same ones.
 */

const steer = (overrides: Partial<DeliveredSteer> = {}): DeliveredSteer => ({
  steerId: 'steer_abc',
  messageId: 'msg_1',
  text: 'also run the tests',
  at: '2026-09-10T12:00:00.000Z',
  source: 'user',
  step: 1,
  lane: 'api',
  ...overrides
})

describe('steer ids and placeholders', () => {
  it('accepts only ids that are safe inside the stored marker', () => {
    for (const ok of ['a', 'steer_abc', 'STEER-1', 'x'.repeat(64)]) {
      expect(isValidSteerId(ok)).toBe(true)
    }
    for (const bad of ['', 'x'.repeat(65), 'has space', 'has:colon', 'closes}}', '{{open', null, 7]) {
      expect(isValidSteerId(bad)).toBe(false)
    }
  })

  it('round-trips a marker', () => {
    const content = `before ${buildSteerPlaceholder('steer_abc')} after`
    expect(hasSteerPlaceholder(content)).toBe(true)
    expect(extractSteerPlaceholderIds(content)).toEqual(['steer_abc'])
  })

  it('is a separate family from zip and clip references', () => {
    expect(hasSteerPlaceholder('{{batshit-zip:cool_tool_1_abc}}')).toBe(false)
    expect(hasSteerPlaceholder('{{batshit-clip:clip_1}}')).toBe(false)
    expect(hasSteerPlaceholder('nothing here')).toBe(false)
    expect(hasSteerPlaceholder(null)).toBe(false)
  })

  it('finds every marker even after a previous scan', () => {
    const content = `${buildSteerPlaceholder('a')} ${buildSteerPlaceholder('b')}`
    // A shared module-level /g regex carries `lastIndex` between calls, so a `test()` here
    // would make `matchAll` below start mid-string and miss the first marker. Caught live
    // while writing this suite; the helpers build a fresh regex per call.
    expect(hasSteerPlaceholder(content)).toBe(true)
    expect(hasSteerPlaceholder(content)).toBe(true)
    expect(extractSteerPlaceholderIds(content)).toEqual(['a', 'b'])
  })
})

describe('readMessageSteers', () => {
  it('reads a well-formed list', () => {
    expect(readMessageSteers({ metadata: { steers: [steer()] } })).toHaveLength(1)
  })

  it('never throws on a malformed record', () => {
    for (const message of [null, {}, { metadata: {} }, { metadata: { steers: 'nope' } }]) {
      expect(readMessageSteers(message)).toEqual([])
    }
    expect(
      readMessageSteers({ metadata: { steers: [null, { steerId: 'ok' }, { text: 'no id' }] } })
    ).toEqual([])
  })
})

describe('formatSteerForModel (DL-118-07)', () => {
  it('gives the user’s words the spelling the guidance teaches', () => {
    expect(formatSteerForModel(steer())).toBe('[The user said, mid-reply: also run the tests]')
  })

  it('marks a DM as NOT from the user, with a fallback name', () => {
    expect(formatSteerForModel(steer({ source: 'dm', label: 'Cooper' }))).toBe(
      '[Agent DM — from Cooper, not from the user, delivered mid-reply: also run the tests]'
    )
    expect(formatSteerForModel(steer({ source: 'dm' }))).toContain(
      'from another agent, not from the user'
    )
  })

  it('publishes the two shapes the guidance quotes, with `...` for the words', () => {
    // The guidance is BUILT from these, so this is the whole anti-drift contract in one
    // place: change the wrapper and this test names the new text the prompts must carry.
    expect(STEER_WRAPPER_GUIDANCE_EXAMPLES.user).toBe('[The user said, mid-reply: ...]')
    expect(STEER_WRAPPER_GUIDANCE_EXAMPLES.dm).toBe(
      '[Agent DM — from <name>, not from the user, delivered mid-reply: ...]'
    )
  })
})

describe('buildSteerInjectionText', () => {
  it('sends the live delivery in the SAME wrapper the replay uses (DL-118-07)', () => {
    // PR #106 review F-15: this used to be `[Steer — from the user, mid-reply]\n…`, a
    // second spelling no surface ever taught the model. The live delivery and the history
    // replay are now one function, so a wrapper can never again be introduced in only one.
    expect(buildSteerInjectionText([steer()])).toBe(formatSteerForModel(steer()))
    expect(buildSteerInjectionText([steer()])).not.toContain('[Steer —')
  })

  it('marks a DM as NOT from the user, with a fallback name', () => {
    expect(buildSteerInjectionText([steer({ source: 'dm', label: 'Cooper' })])).toContain(
      'from Cooper, not from the user'
    )
    expect(buildSteerInjectionText([steer({ source: 'dm' })])).toContain(
      'from another agent, not from the user'
    )
  })

  it('joins several arrivals as one interruption, in order', () => {
    const text = buildSteerInjectionText([
      steer({ steerId: 'a', text: 'first' }),
      steer({ steerId: 'b', text: 'second' })
    ])
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
    expect(text.split('[The user said, mid-reply:')).toHaveLength(3)
  })
})

describe('resolveSteerability (DL-114-09)', () => {
  it('steers API primaries', () => {
    expect(resolveSteerability({ primaryAgentType: 'api', isGroupSession: false })).toEqual({
      steerable: true,
      lane: 'api'
    })
  })

  it('refuses groups first, whatever the agent is', () => {
    const verdict = resolveSteerability({ primaryAgentType: 'api', isGroupSession: true })
    expect(verdict.steerable).toBe(false)
    if (verdict.steerable) throw new Error('expected a refusal')
    expect(verdict.reason).toContain('Group chats cannot be steered')
  })

  it('steers a managed Codex run on the app-server transport (P2, DL-114-06)', () => {
    expect(
      resolveSteerability({
        primaryAgentType: 'cli',
        isGroupSession: false,
        cli: { provider: 'codex', configScope: 'managed', codexTransport: 'app-server' }
      })
    ).toEqual({ steerable: true, lane: 'codex' })
  })

  it('steers a managed Claude run (P2, DL-114-08)', () => {
    expect(
      resolveSteerability({
        primaryAgentType: 'cli',
        isGroupSession: false,
        cli: { provider: 'claude', configScope: 'managed' }
      })
    ).toEqual({ steerable: true, lane: 'claude' })
  })

  it('refuses the Codex exec transport, which closed its stdin after the prompt', () => {
    const verdict = resolveSteerability({
      primaryAgentType: 'cli',
      isGroupSession: false,
      cli: { provider: 'codex', configScope: 'managed', codexTransport: 'exec' }
    })
    expect(verdict.steerable).toBe(false)
    if (verdict.steerable) throw new Error('expected a refusal')
    expect(verdict.reason).toContain('exec transport')
    // F-P1-2: it used to end "Your message interrupts instead". DL-119-07 took that branch
    // away, so the sentence now says what actually happens.
    expect(verdict.reason).toContain('queues and sends when the reply ends')
  })

  /**
   * The transport lane is not derivable from the agent record — `BATSHIT_CODEX_TRANSPORT`
   * decides it at run time — so a Codex verdict with no lane supplied must refuse rather
   * than assume the steerable one. A wrong "yes" takes the user's words into a transport
   * with no channel to carry them.
   */
  it('refuses a Codex run whose transport is unknown', () => {
    for (const codexTransport of [null, undefined]) {
      expect(
        resolveSteerability({
          primaryAgentType: 'cli',
          isGroupSession: false,
          cli: { provider: 'codex', configScope: 'managed', codexTransport }
        }).steerable
      ).toBe(false)
    }
  })

  it('refuses a CLI profile Batshit does not manage (DL-114-09)', () => {
    for (const provider of ['codex', 'claude'] as const) {
      const verdict = resolveSteerability({
        primaryAgentType: 'cli',
        isGroupSession: false,
        cli: { provider, configScope: 'global', codexTransport: 'app-server' }
      })
      expect(verdict.steerable).toBe(false)
      if (verdict.steerable) throw new Error('expected a refusal')
      expect(verdict.reason).toContain('your own CLI profile')
    }
  })

  it('refuses a CLI primary whose runtime could not be resolved', () => {
    for (const cli of [null, undefined, { provider: null, configScope: 'managed' } as const]) {
      const verdict = resolveSteerability({
        primaryAgentType: 'cli',
        isGroupSession: false,
        cli
      })
      expect(verdict.steerable).toBe(false)
    }
  })

  it('refuses a group before it looks at the CLI runtime at all', () => {
    const verdict = resolveSteerability({
      primaryAgentType: 'cli',
      isGroupSession: true,
      cli: { provider: 'claude', configScope: 'managed' }
    })
    expect(verdict.steerable).toBe(false)
    if (verdict.steerable) throw new Error('expected a refusal')
    expect(verdict.reason).toContain('Group chats cannot be steered')
  })

  it('refuses an unreadable or retired record rather than assuming it is steerable', () => {
    for (const type of [null, undefined, '', 'n8n', 'nonsense']) {
      expect(
        resolveSteerability({ primaryAgentType: type, isGroupSession: false }).steerable
      ).toBe(false)
    }
  })
})

describe('the caps', () => {
  it('holds five waiting steers and caps text at the DM body size (AMD-114-03)', () => {
    expect(MAX_PENDING_STEERS).toBe(5)
    expect(STEER_TEXT_MAX_CHARS).toBe(40_000)
  })
})

/**
 * SA-114 P3 (DL-114-01) — the busy-send mode.
 *
 * One rule answers for the send button's label, the shortcut's opposite, and the branch
 * `handleSendMessage` takes. These pin the two things that would break that: a default
 * that is not steer, and a reader that throws on a settings record nobody has written.
 */
describe('resolveBusySendMode', () => {
  it('defaults to steer, which is the product decision', () => {
    expect(DEFAULT_BUSY_SEND_MODE).toBe('steer')
    expect(resolveBusySendMode(null)).toBe('steer')
    expect(resolveBusySendMode(undefined)).toBe('steer')
    expect(resolveBusySendMode({})).toBe('steer')
    expect(resolveBusySendMode({ global_chat_settings: {} })).toBe('steer')
  })

  it('reads a stored choice back, both ways', () => {
    expect(resolveBusySendMode({ global_chat_settings: { busy_send_mode: 'queue' } })).toBe('queue')
    expect(resolveBusySendMode({ global_chat_settings: { busy_send_mode: 'steer' } })).toBe('steer')
  })

  /**
   * SA-119 (DL-119-01) — the migration, and why it is a READ rather than a write.
   *
   * "Interrupt and send" is retired as a mode: Stop then Enter is that job now. A record
   * written before this story still says `interrupt`, and the honest answer for it is the
   * default — not a refusal, and not a silent write-back, because nothing is stored until
   * the user saves the panel themselves.
   */
  it('reads a stored `interrupt` as steer (DL-119-01)', () => {
    expect(resolveBusySendMode({ global_chat_settings: { busy_send_mode: 'interrupt' } })).toBe(
      'steer'
    )
  })

  it('falls back rather than throwing on anything unreadable', () => {
    for (const value of [
      { global_chat_settings: { busy_send_mode: 'wait' } },
      { global_chat_settings: { busy_send_mode: 7 } },
      { global_chat_settings: 'queue' },
      'queue',
      42
    ]) {
      expect(resolveBusySendMode(value)).toBe('steer')
    }
  })
})

describe('otherBusySendMode', () => {
  it('is "the other one" (DL-119-01, DL-119-02)', () => {
    // Cmd/Ctrl+Enter has to reach whichever mode Enter is not, or the shortcut is dead for
    // exactly the people who changed the setting.
    expect(otherBusySendMode('steer')).toBe('queue')
    expect(otherBusySendMode('queue')).toBe('steer')
  })

  it('has no third word left to answer for (DL-119-07)', () => {
    // P2 deleted `EffectiveBusySendMode`. Two modes in, two modes out, and the `queue` a
    // held-for-files send takes is the SAME queue the badge offers — not a third state
    // with its own opposite, which is how "Send after reply" came to live behind a hover.
    for (const mode of ['steer', 'queue'] as BusySendMode[]) {
      expect(otherBusySendMode(otherBusySendMode(mode))).toBe(mode)
    }
  })
})

describe('busySendModeLabel', () => {
  it('uses the product words (DL-119-01)', () => {
    expect(busySendModeLabel('steer')).toBe('Steer')
    expect(busySendModeLabel('queue')).toBe('Queue')
  })

  it('names only the two badges the composer draws (DL-119-01, DL-119-03)', () => {
    // The label is what a badge says. There is no third label because there is no third
    // badge: a send that carries files is a Queue, said in the queue's own words.
    const labels = (['steer', 'queue'] as BusySendMode[]).map(busySendModeLabel)
    expect(labels).toEqual(['Steer', 'Queue'])
    expect(labels.join(' ')).not.toMatch(/interrupt/i)
  })
})

describe('normalizeGlobalChatSettings', () => {
  it('stores one of exactly two words and drops anything else (DL-119-01)', () => {
    expect(normalizeGlobalChatSettings({ busy_send_mode: 'queue' })).toEqual({
      busy_send_mode: 'queue'
    })
    // The retired mode normalises rather than sticking around as a third value.
    expect(normalizeGlobalChatSettings({ busy_send_mode: 'interrupt' })).toEqual({
      busy_send_mode: 'steer'
    })
    expect(normalizeGlobalChatSettings({ busy_send_mode: 'steer', junk: true })).toEqual({
      busy_send_mode: 'steer'
    })
    expect(normalizeGlobalChatSettings(null)).toEqual({ busy_send_mode: 'steer' })
  })
})

/**
 * SA-119 (DL-119-02) — THE rule for the two badges beside Stop.
 *
 * Every cell of default x steerable x clips x mentions is pinned, because this one function
 * answers for which badge is filled, what Enter does, what Cmd/Ctrl+Enter does, whether
 * Steer is even clickable, and the sentence shown beside it when it is not. A table with a
 * hole in it is how the filled badge would come to promise something the key does not do.
 */
describe('resolveBusySendActions (DL-119-02)', () => {
  const NOTE_CLIPS = 'Won’t include the file — it stays here.'
  const NOTE_MENTIONS = 'Mentions can’t steer.'
  const SERVER_REASON = 'Group chats cannot be steered.'

  /**
   * All sixteen rows, written out rather than generated: a generated table would restate
   * the rule it is meant to check, and then both could be wrong together.
   */
  const rows: Array<{
    mode: BusySendMode
    steerable: boolean
    hasClips: boolean
    hasMentions: boolean
    enter: 'steer' | 'queue'
    other: 'steer' | 'queue'
    steerEnabled: boolean
    note: string | null
  }> = [
    // --- default steer, reply can be steered ---
    { mode: 'steer', steerable: true, hasClips: false, hasMentions: false, enter: 'steer', other: 'queue', steerEnabled: true, note: null },
    { mode: 'steer', steerable: true, hasClips: true, hasMentions: false, enter: 'queue', other: 'steer', steerEnabled: true, note: NOTE_CLIPS },
    { mode: 'steer', steerable: true, hasClips: false, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: NOTE_MENTIONS },
    { mode: 'steer', steerable: true, hasClips: true, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: NOTE_MENTIONS },
    // --- default steer, reply cannot be steered: the server's verdict wins over everything ---
    { mode: 'steer', steerable: false, hasClips: false, hasMentions: false, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON },
    { mode: 'steer', steerable: false, hasClips: true, hasMentions: false, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON },
    { mode: 'steer', steerable: false, hasClips: false, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON },
    { mode: 'steer', steerable: false, hasClips: true, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON },
    // --- default queue, reply can be steered ---
    { mode: 'queue', steerable: true, hasClips: false, hasMentions: false, enter: 'queue', other: 'steer', steerEnabled: true, note: null },
    { mode: 'queue', steerable: true, hasClips: true, hasMentions: false, enter: 'queue', other: 'steer', steerEnabled: true, note: NOTE_CLIPS },
    { mode: 'queue', steerable: true, hasClips: false, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: NOTE_MENTIONS },
    { mode: 'queue', steerable: true, hasClips: true, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: NOTE_MENTIONS },
    // --- default queue, reply cannot be steered ---
    { mode: 'queue', steerable: false, hasClips: false, hasMentions: false, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON },
    { mode: 'queue', steerable: false, hasClips: true, hasMentions: false, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON },
    { mode: 'queue', steerable: false, hasClips: false, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON },
    { mode: 'queue', steerable: false, hasClips: true, hasMentions: true, enter: 'queue', other: 'queue', steerEnabled: false, note: SERVER_REASON }
  ]

  it('has one row per cell of the table', () => {
    expect(rows).toHaveLength(16)
    expect(new Set(rows.map((row) => JSON.stringify([row.mode, row.steerable, row.hasClips, row.hasMentions]))).size).toBe(16)
  })

  for (const row of rows) {
    const name = `${row.mode} default, ${row.steerable ? 'steerable' : 'not steerable'}, ${row.hasClips ? 'clips' : 'no clips'}, ${row.hasMentions ? 'mentions' : 'no mentions'}`
    it(`${name} -> Enter ${row.enter}, other ${row.other}, Steer ${row.steerEnabled ? 'on' : 'off'}`, () => {
      const actions = resolveBusySendActions({
        mode: row.mode,
        steerable: row.steerable,
        steerReason: SERVER_REASON,
        hasClips: row.hasClips,
        hasMentions: row.hasMentions
      })
      expect(actions.enter).toBe(row.enter)
      expect(actions.other).toBe(row.other)
      expect(actions.steer.enabled).toBe(row.steerEnabled)
      expect(actions.steer.note).toBe(row.note)
      // Queue is the one thing that is always available: it is what "nothing you typed is
      // lost" rests on, and DL-119-05/06 give it a path for every message.
      expect(actions.queue.enabled).toBe(true)
    })
  }

  it('treats "not told yet" as steerable, because the route is the backstop', () => {
    for (const steerable of [null, undefined]) {
      const actions = resolveBusySendActions({ mode: 'steer', steerable, hasClips: false, hasMentions: false })
      expect(actions.enter).toBe('steer')
      expect(actions.steer.enabled).toBe(true)
      expect(actions.steer.note).toBeNull()
    }
  })

  it('shows the server’s own reason, and a plain one when it sent none', () => {
    expect(
      resolveBusySendActions({ mode: 'steer', steerable: false, steerReason: '  Groups cannot be steered.  ', hasClips: false, hasMentions: false }).steer.note
    ).toBe('Groups cannot be steered.')
    const noReason = resolveBusySendActions({ mode: 'steer', steerable: false, hasClips: false, hasMentions: false })
    expect(noReason.steer.note).toBe('This reply can’t take a steer.')
    expect(noReason.steer.note).not.toContain('interrupt')
  })

  it('never offers a key that does nothing: `other` is always a mode Enter is not, or queue', () => {
    for (const row of rows) {
      if (row.steerEnabled) expect(row.other).not.toBe(row.enter)
      else expect(row.other).toBe('queue')
    }
  })
})

/**
 * SA-119 P2 (DL-119-07, F-P1-2) — the words a refused Steer shows the user.
 *
 * These four sentences are the server's own "why not", and DL-119-03 puts them on screen as
 * plain text beside a Steer badge that cannot be pressed. Every one of them used to end
 * "Your message interrupts instead", which stopped being TRUE the moment interrupt-and-send
 * was retired: the message now queues and goes when the reply ends. A sentence that
 * describes a branch the app no longer has is worse than no sentence, because the user acts
 * on it.
 */
describe('the refusal sentences (F-P1-2)', () => {
  const refusals = [
    resolveSteerability({ primaryAgentType: 'api', isGroupSession: true }),
    resolveSteerability({ primaryAgentType: 'cli', isGroupSession: false, cli: null }),
    resolveSteerability({
      primaryAgentType: 'cli',
      isGroupSession: false,
      cli: { provider: 'codex', configScope: 'user', codexTransport: 'app-server' }
    }),
    resolveSteerability({
      primaryAgentType: 'cli',
      isGroupSession: false,
      cli: { provider: 'codex', configScope: 'managed', codexTransport: 'exec' }
    })
  ].map((verdict) => {
    expect(verdict.steerable).toBe(false)
    return verdict.steerable === false ? verdict.reason : ''
  })

  it('never promises an interrupt that no longer exists', () => {
    expect(refusals).toHaveLength(4)
    for (const reason of refusals) {
      expect(reason.length).toBeGreaterThan(0)
      expect(reason).not.toMatch(/interrupt/i)
    }
  })

  it('says what WILL happen instead, in the queue’s own words', () => {
    for (const reason of refusals) {
      expect(reason.toLowerCase()).toContain('queue')
    }
  })

  it('is still four different sentences, one per reason', () => {
    expect(new Set(refusals).size).toBe(4)
  })
})

/**
 * SA-119 P2 (DL-119-05, DL-119-06) — one promise, said in one place.
 *
 * Queue has two mechanisms under it: the server holds a text-only message and promotes it
 * when the reply ends, and the browser holds one that carries files. The USER is told the
 * same thing either way, and the bubble, the badge and the toast all read these constants
 * rather than spelling the promise out three times.
 */
describe('the queued sentences (DL-119-05, DL-119-06)', () => {
  it('says when the message will go, not merely that it is waiting', () => {
    expect(QUEUED_AFTER_REPLY_SENTENCE).toBe('Queued — sends after this reply')
    expect(QUEUED_WITH_FILES_SENTENCE).toBe('Queued — sends after this reply (with files)')
  })

  it('names the files case as a variation of the same promise, not a different one', () => {
    expect(QUEUED_WITH_FILES_SENTENCE.startsWith(QUEUED_AFTER_REPLY_SENTENCE)).toBe(true)
  })

  it('refuses a second file message honestly, and says what to do (DL-119-06)', () => {
    expect(QUEUE_ONE_AT_A_TIME_SENTENCE).toBe(
      'One queued message with files at a time — send it after this one'
    )
  })

  it('never uses the retired word', () => {
    for (const sentence of [
      QUEUED_AFTER_REPLY_SENTENCE,
      QUEUED_WITH_FILES_SENTENCE,
      QUEUE_ONE_AT_A_TIME_SENTENCE
    ]) {
      expect(sentence).not.toMatch(/interrupt/i)
    }
  })
})

/**
 * SA-119 (DL-119-05) — `deliver` is a two-word field, validated in one place.
 *
 * The route refuses anything else rather than coercing it: a steer stored with a `deliver`
 * nobody chose would either land mid-reply when the user asked it to wait, or wait when
 * they asked it to land — and both look like Batshit ignoring the button they pressed.
 */
describe('isSteerDeliver (DL-119-05)', () => {
  it('accepts exactly the two words', () => {
    expect(isSteerDeliver('now')).toBe(true)
    expect(isSteerDeliver('end')).toBe(true)
  })

  it('rejects everything else, including the near misses', () => {
    for (const value of ['END', 'Now', 'queue', 'later', '', ' now', null, undefined, 1, {}, ['end']]) {
      expect(isSteerDeliver(value)).toBe(false)
    }
  })
})

describe('classifySteerRefusal (PR #106 review, F-4; DL-119-07)', () => {
  it('lets only the two escalating refusals escalate', () => {
    expect(classifySteerRefusal(409, { code: 'not_steerable', reason: 'x', refusal: 'reply_finished' })).toBe(
      'already_finished'
    )
    expect(classifySteerRefusal(409, { code: 'not_steerable', reason: 'That reply already finished. Send it.' })).toBe(
      'already_finished'
    )
    // DL-119-07: a reply that cannot take a steer at all no longer interrupts — the words
    // queue through the client wait and go the moment the reply ends.
    expect(
      classifySteerRefusal(409, { code: 'not_steerable', reason: 'This agent cannot be steered mid-reply.' })
    ).toBe('queue')
  })

  it('lets the tag win over the sentence', () => {
    // The tag is the contract and the sentence is for people: a refusal carrying
    // `reply_finished` is "too late", whatever words came with it.
    expect(
      classifySteerRefusal(409, {
        code: 'not_steerable',
        refusal: 'reply_finished',
        reason: 'This agent cannot be steered mid-reply.'
      })
    ).toBe('already_finished')
  })

  it('refuses — never queues — for the cap, a waiting DM, a bad request, and a lost server', () => {
    expect(classifySteerRefusal(409, { code: 'steer_inbox_full', reason: '5 messages are already waiting' })).toBe(
      'refused'
    )
    expect(classifySteerRefusal(409, { code: 'steer_dm_pending', reason: 'a DM is waiting' })).toBe('refused')
    expect(classifySteerRefusal(400, { code: 'invalid_input', error: 'A steer needs some text.' })).toBe('refused')
    expect(classifySteerRefusal(401, { error: 'Unauthorized' })).toBe('refused')
    expect(classifySteerRefusal(500, null)).toBe('refused')
    expect(classifySteerRefusal(null, undefined)).toBe('refused')
  })
})

/**
 * SA-119 P2b (F-P2-7) — the interruption note after Stop, then Enter.
 *
 * `send-routed` builds the model's `==== INTERRUPTION NOTE ====` from
 * `metadata.interruption`; DL-119-07 deleted the branch that was its only writer, so
 * between the packets the model stopped being told that the user cut a reply short. Stop's
 * record is the only source now, and this is the whole decision about what it becomes.
 */
describe('resolveStopInterruptionStamp (SA-119 P2b)', () => {
  const record = { messageId: 'msg_assistant_1', interruptedAt: '2026-09-13T20:00:00.000Z' }

  it('stamps the send that follows a Stop', () => {
    expect(
      resolveStopInterruptionStamp({
        record,
        browserQueued: false,
        latestAssistantMessageId: 'msg_assistant_1'
      })
    ).toEqual({
      previousMessageId: 'msg_assistant_1',
      interruptedAt: '2026-09-13T20:00:00.000Z',
      reason: 'user'
    })
  })

  it('says nothing when there was no Stop', () => {
    expect(
      resolveStopInterruptionStamp({
        record: null,
        browserQueued: false,
        latestAssistantMessageId: 'msg_assistant_1'
      })
    ).toBeNull()
  })

  it('says nothing when the browser was holding this message (DL-119-06)', () => {
    // The case the packet row called impossible. A steer and a server-held queue return
    // before the ordinary send path, but a browser-held queue falls through into it — and
    // it is waiting for "the reply ends", which is exactly what Stop makes happen. Without
    // this the model is told the user cut short a reply the user chose to wait behind.
    expect(
      resolveStopInterruptionStamp({
        record,
        browserQueued: true,
        latestAssistantMessageId: 'msg_assistant_1'
      })
    ).toBeNull()
  })

  it('says nothing once another turn has landed on top of the stopped one', () => {
    expect(
      resolveStopInterruptionStamp({
        record,
        browserQueued: false,
        latestAssistantMessageId: 'msg_assistant_2'
      })
    ).toBeNull()
  })

  it('says nothing when the chat has no assistant message to name', () => {
    for (const latest of [null, undefined, '', '   ']) {
      expect(
        resolveStopInterruptionStamp({
          record,
          browserQueued: false,
          latestAssistantMessageId: latest
        })
      ).toBeNull()
    }
  })

  it('refuses a half-written record rather than completing it', () => {
    // A fabricated timestamp would be a silent fallback inside a note whose entire job is
    // to be true about one specific message.
    expect(
      resolveStopInterruptionStamp({
        record: { messageId: 'msg_assistant_1', interruptedAt: '' },
        browserQueued: false,
        latestAssistantMessageId: 'msg_assistant_1'
      })
    ).toBeNull()
    expect(
      resolveStopInterruptionStamp({
        record: { messageId: '  ', interruptedAt: '2026-09-13T20:00:00.000Z' },
        browserQueued: false,
        latestAssistantMessageId: 'msg_assistant_1'
      })
    ).toBeNull()
  })

  it('matches the ids it was given, whitespace and all', () => {
    expect(
      resolveStopInterruptionStamp({
        record: { messageId: ' msg_assistant_1 ', interruptedAt: ' 2026-09-13T20:00:00.000Z ' },
        browserQueued: false,
        latestAssistantMessageId: ' msg_assistant_1 '
      })
    ).toEqual({
      previousMessageId: 'msg_assistant_1',
      interruptedAt: '2026-09-13T20:00:00.000Z',
      reason: 'user'
    })
  })
})

/**
 * SA-119 P3 (AMD-119-04) — Stop stops everything.
 *
 * Josh's decision, 2026-09-13. A browser-held queued message waits for the reply to END,
 * and a Stop is one of the ways a reply ends — so before this rule the page read
 * `replyEnded` and sent, while `settleSteerBubblesForMessage` had already drawn the
 * receipt. The user was shown *Not sent — you stopped the reply* about a message that then
 * sent, and a SERVER-held queued message in the same situation really was dropped.
 */
describe('resolveQueuedSendAfterWait (SA-119 P3)', () => {
  it('sends when the reply simply ended', () => {
    expect(resolveQueuedSendAfterWait({ stoppedDuringWait: false, replyEnded: true })).toBe('send')
  })

  it('keeps the words when the ceiling was hit and the reply is still going (F-P2-1)', () => {
    expect(resolveQueuedSendAfterWait({ stoppedDuringWait: false, replyEnded: false })).toBe(
      'still-running'
    )
  })

  it('drops the message when the user stopped the reply', () => {
    expect(resolveQueuedSendAfterWait({ stoppedDuringWait: true, replyEnded: false })).toBe(
      'dropped-by-stop'
    )
  })

  it('reads the Stop FIRST, because a Stop also makes the reply end', () => {
    // The whole rule is this row. A Stop sets `replyEnded` as surely as a finished answer
    // does, so an implementation that tested `replyEnded` first would send every stopped
    // message — which is exactly what the page did before AMD-119-04.
    expect(resolveQueuedSendAfterWait({ stoppedDuringWait: true, replyEnded: true })).toBe(
      'dropped-by-stop'
    )
  })

  it('answers one of exactly three things, and never anything else', () => {
    const seen = new Set<string>()
    for (const stoppedDuringWait of [true, false]) {
      for (const replyEnded of [true, false]) {
        seen.add(resolveQueuedSendAfterWait({ stoppedDuringWait, replyEnded }))
      }
    }
    expect([...seen].sort()).toEqual(['dropped-by-stop', 'send', 'still-running'])
  })
})
