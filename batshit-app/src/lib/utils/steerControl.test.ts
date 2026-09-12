import { describe, expect, it } from 'vitest'
import {
  buildSteerInjectionText,
  buildSteerPlaceholder,
  busySendModeLabel,
  DEFAULT_BUSY_SEND_MODE,
  extractSteerPlaceholderIds,
  hasSteerPlaceholder,
  isValidSteerId,
  MAX_PENDING_STEERS,
  normalizeGlobalChatSettings,
  otherBusySendMode,
  resolveEffectiveBusySendMode,
  readMessageSteers,
  resolveBusySendMode,
  resolveSteerability,
  STEER_TEXT_MAX_CHARS,
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

describe('buildSteerInjectionText', () => {
  it('wraps the user’s words so an agent honours them', () => {
    expect(buildSteerInjectionText([steer()])).toBe(
      '[Steer — from the user, mid-reply]\nalso run the tests'
    )
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
    expect(text.split('[Steer — from the user, mid-reply]')).toHaveLength(3)
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
    expect(resolveBusySendMode({ global_chat_settings: { busy_send_mode: 'interrupt' } })).toBe(
      'interrupt'
    )
    expect(resolveBusySendMode({ global_chat_settings: { busy_send_mode: 'steer' } })).toBe('steer')
  })

  it('falls back rather than throwing on anything unreadable', () => {
    for (const value of [
      { global_chat_settings: { busy_send_mode: 'queue' } },
      { global_chat_settings: { busy_send_mode: 7 } },
      { global_chat_settings: 'interrupt' },
      'interrupt',
      42
    ]) {
      expect(resolveBusySendMode(value)).toBe('steer')
    }
  })
})

describe('otherBusySendMode', () => {
  it('is "the other one", not "interrupt"', () => {
    // Cmd/Ctrl+Enter has to be able to STEER for someone whose default is interrupt, or
    // the shortcut is dead for exactly the people who changed the setting.
    expect(otherBusySendMode('steer')).toBe('interrupt')
    expect(otherBusySendMode('interrupt')).toBe('steer')
  })
})

describe('busySendModeLabel', () => {
  it('uses the product words', () => {
    expect(busySendModeLabel('steer')).toBe('Steer')
    expect(busySendModeLabel('interrupt')).toBe('Interrupt and send')
  })
})

describe('normalizeGlobalChatSettings', () => {
  it('stores one of exactly two words and drops anything else', () => {
    expect(normalizeGlobalChatSettings({ busy_send_mode: 'interrupt' })).toEqual({
      busy_send_mode: 'interrupt'
    })
    expect(normalizeGlobalChatSettings({ busy_send_mode: 'queue' })).toEqual({
      busy_send_mode: 'steer'
    })
    expect(normalizeGlobalChatSettings({ busy_send_mode: 'steer', junk: true })).toEqual({
      busy_send_mode: 'steer'
    })
    expect(normalizeGlobalChatSettings(null)).toEqual({ busy_send_mode: 'steer' })
  })
})

/**
 * SA-114 P3 (DL-114-01 + DL-114-09) — the setting meets the running reply.
 *
 * One rule, read by the send button's label AND by the branch `handleSendMessage` takes. A
 * button that says "Steer" over a send that interrupts is the exact failure this story
 * exists to remove, so these pin both directions of the meeting.
 */
describe('resolveEffectiveBusySendMode', () => {
  it('lets a known refusal beat the setting', () => {
    expect(resolveEffectiveBusySendMode({ mode: 'steer', steerable: false })).toBe('interrupt')
  })

  it('treats "not told yet" as steerable, because the route is the backstop', () => {
    expect(resolveEffectiveBusySendMode({ mode: 'steer', steerable: null })).toBe('steer')
    expect(resolveEffectiveBusySendMode({ mode: 'steer' })).toBe('steer')
    expect(resolveEffectiveBusySendMode({ mode: 'steer', steerable: true })).toBe('steer')
  })

  it('never turns an interrupt setting into a steer', () => {
    for (const steerable of [true, false, null, undefined]) {
      expect(resolveEffectiveBusySendMode({ mode: 'interrupt', steerable })).toBe('interrupt')
    }
  })
})
