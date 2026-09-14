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
  resolveEffectiveBusySendMode,
  readMessageSteers,
  resolveBusySendMode,
  resolveSteerability,
  STEER_TEXT_MAX_CHARS,
  STEER_WRAPPER_GUIDANCE_EXAMPLES,
  WAIT_SEND_SENTENCE,
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
    expect(verdict.reason).toContain('interrupts instead')
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

  it('offers steer as the other way out of a held send (legacy `wait`)', () => {
    // `wait` is the old word for "queue, held in the browser because this send carries
    // files" (DL-119-06). The other key then offers to steer — which now keeps the file in
    // the composer instead of throwing it away (DL-119-04).
    expect(otherBusySendMode('wait')).toBe('steer')
  })
})

describe('busySendModeLabel', () => {
  it('uses the product words (DL-119-01)', () => {
    expect(busySendModeLabel('steer')).toBe('Steer')
    expect(busySendModeLabel('queue')).toBe('Queue')
  })

  it('says what a held send will do, not what it wishes it did (DL-118-09)', () => {
    expect(busySendModeLabel('wait')).toBe('Send after reply')
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
 * SA-114 P3 (DL-114-01 + DL-114-09), superseded by DL-119-02.
 *
 * This is now a thin derivation of `resolveBusySendActions` kept only so the composer and
 * the page keep compiling between P1 and P2; P2 deletes it with its callers. `interrupt` is
 * gone from it (DL-119-07) — a refusal now queues.
 */
describe('resolveEffectiveBusySendMode (legacy shim, deleted in P2)', () => {
  it('queues instead of interrupting on a known refusal (DL-119-07)', () => {
    expect(resolveEffectiveBusySendMode({ mode: 'steer', steerable: false })).toBe('queue')
  })

  it('treats "not told yet" as steerable, because the route is the backstop', () => {
    expect(resolveEffectiveBusySendMode({ mode: 'steer', steerable: null })).toBe('steer')
    expect(resolveEffectiveBusySendMode({ mode: 'steer' })).toBe('steer')
    expect(resolveEffectiveBusySendMode({ mode: 'steer', steerable: true })).toBe('steer')
  })

  it('never turns a queue setting into a steer', () => {
    for (const steerable of [true, false, null, undefined]) {
      expect(resolveEffectiveBusySendMode({ mode: 'queue', steerable })).toBe('queue')
    }
  })

  it('says wait when the composer carries files', () => {
    expect(
      resolveEffectiveBusySendMode({ mode: 'steer', steerable: true, carriesAttachments: true })
    ).toBe('wait')
    expect(
      resolveEffectiveBusySendMode({ mode: 'steer', steerable: null, carriesAttachments: true })
    ).toBe('wait')
  })

  it('keeps steer when the composer carries nothing', () => {
    expect(
      resolveEffectiveBusySendMode({ mode: 'steer', steerable: true, carriesAttachments: false })
    ).toBe('steer')
  })

  it('lets a refusal beat wait', () => {
    // The order `+page.svelte` takes: a reply the server says cannot take a steer has no
    // inside to wait in, so the composer's contents cannot change the answer.
    expect(
      resolveEffectiveBusySendMode({ mode: 'steer', steerable: false, carriesAttachments: true })
    ).toBe('queue')
  })

  it('is byte-identical to the old rule when nothing is attached (the send path)', () => {
    // `+page.svelte` never passes `carriesAttachments`. If omitting it ever started
    // producing `wait`, the page's `=== 'steer'` test would go false and the clips-wait
    // branch would quietly stop running.
    for (const steerable of [true, false, null, undefined]) {
      const withoutFlag = resolveEffectiveBusySendMode({ mode: 'steer', steerable })
      const explicitlyEmpty = resolveEffectiveBusySendMode({
        mode: 'steer',
        steerable,
        carriesAttachments: false
      })
      expect(withoutFlag).toBe(explicitlyEmpty)
      expect(withoutFlag).not.toBe('wait')
    }
  })

  it('reads the SAME rule the badges read (DL-119-02)', () => {
    // One rule, two readers. The shim exists to keep two call sites compiling, not to be a
    // second opinion about what a send does.
    for (const mode of ['steer', 'queue'] as BusySendMode[]) {
      for (const steerable of [true, false]) {
        const shim = resolveEffectiveBusySendMode({ mode, steerable })
        const actions = resolveBusySendActions({ mode, steerable, hasClips: false, hasMentions: false })
        expect(shim).toBe(actions.enter)
      }
    }
  })
})

describe('WAIT_SEND_SENTENCE (DL-118-09)', () => {
  it('is the one sentence the bubble and the button both use', () => {
    expect(WAIT_SEND_SENTENCE).toBe('With files: waits for the reply to finish')
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
