import { describe, expect, it } from 'vitest'
import { applyApiPromptCachePolicy, placeToolLoopTailMarker, splitCompiledHistoryText } from '../apiPromptCachePolicy'
import { compiledConversation, compiledElement } from '$lib/utils/compiledChatTags'

/**
 * History cache blocks (2026-10-21, Josh: "why is chat history not being cached?").
 *
 * Anthropic's prompt cache matches at content-block boundaries, and the compiler sends the whole
 * chat as ONE text part that changes every turn, so every turn's first call read only the system
 * prompt back (SA-126 Set 10: 10,063 tokens on all 80 compiles). On direct Anthropic the policy now
 * sends the compiled chat as one text part per history turn plus a tail part, bytes unchanged, and
 * puts a cache point on the last history part, so the next turn reads every earlier turn back.
 */

const at = (day: number) => [['time', `Monday, October ${day}, 2026 at 9:00 AM`]] as Array<[string, string]>
const user = (text: string, day = 20) => compiledElement('user', text, at(day))
const reply = (text: string) => compiledElement('assistant', text)

/** The compiled user text the compiler builds: history, the zip index, the new message, the DCM. */
function compiledText(history: string[], current = 'Now add a slider.') {
  const conversation = compiledConversation(history)
  const tail = [
    compiledElement('zip_index', 'cool_tool_1 | open'),
    compiledElement('user', current, at(21)),
    compiledElement('dynamic_info', 'project_path: /tmp/probe'),
  ].join('\n\n')
  return conversation ? `${conversation}\n\n${tail}` : tail
}

const TURN_1 = [user('Build me a tip calculator.'), reply('Done: tip.js. A pasted <user>tag</user> stays text.')]
const TURN_2 = [user('Round to cents.'), reply('Rounded.')]
const TURN_3 = [user('Add tests.'), reply('Added 4 tests.')]

const anthropicDirect = {
  modelId: 'claude-sonnet-5',
  providerId: 'anthropic',
  connection: { type: 'direct', service: 'anthropic', id: 'direct:anthropic' } as any,
  userId: 'user-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
}

const SYSTEM = { role: 'system', content: 'Stable Batshit API agent prompt.' }

function countExplicitCachePoints(messages: any[]): number {
  const has = (options: any) => Boolean(options?.anthropic?.cacheControl || options?.openrouter?.cacheControl)
  let count = 0
  for (const message of messages) {
    if (has(message?.providerOptions)) count += 1
    if (Array.isArray(message?.content)) for (const part of message.content) if (has(part?.providerOptions)) count += 1
  }
  return count
}

const joined = (message: any) =>
  typeof message.content === 'string' ? message.content : message.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')

describe('splitCompiledHistoryText', () => {
  it('joins back to the exact text, one part per user turn, then the tail', () => {
    const text = compiledText([...TURN_1, ...TURN_2, ...TURN_3])
    const split = splitCompiledHistoryText(text)!
    expect(split.history).toHaveLength(3)
    expect([...split.history, split.tail].join('')).toBe(text)
    expect(split.history[0].startsWith('<conversation>\n<user time=')).toBe(true)
    for (const part of split.history.slice(1)) expect(part.startsWith('\n\n<user time=')).toBe(true)
    // The tail holds the four pieces that change every turn.
    expect(split.tail.startsWith('\n</conversation>\n\n<zip_index>')).toBe(true)
    expect(split.tail).toContain('Now add a slider.')
    expect(split.tail).toContain('<dynamic_info>')
    // A disarmed tag inside content is never a boundary.
    expect(split.history[0]).toContain('&lt;user>tag&lt;/user>')
  })

  it('a history part written on one turn is byte-identical on the next (the cache can match it)', () => {
    const turn2 = splitCompiledHistoryText(compiledText([...TURN_1], 'Round to cents.'))!
    const turn3 = splitCompiledHistoryText(compiledText([...TURN_1, ...TURN_2], 'Add tests.'))!
    const turn4 = splitCompiledHistoryText(compiledText([...TURN_1, ...TURN_2, ...TURN_3]))!
    expect(turn3.history.slice(0, 1)).toEqual(turn2.history)
    expect(turn4.history.slice(0, 2)).toEqual(turn3.history)
  })

  it('a group chat groups every reply, another agent and a note under the user turn before them', () => {
    const history = [
      compiledElement('note', 'Compact summary of earlier work.'),
      user('Plan the release.'),
      reply('Here is the plan.'),
      compiledElement('agent', 'I agree.', [['name', 'Ashe']]),
      compiledElement('note', 'Woken by a schedule.'),
      user('Ship it.'),
      reply('Shipped.'),
    ]
    const split = splitCompiledHistoryText(compiledText(history))!
    expect(split.history).toHaveLength(3)
    expect(split.history[0]).toBe('<conversation>\n' + history[0])
    expect(split.history[1]).toBe('\n\n' + history.slice(1, 5).join('\n\n'))
    expect(split.history[2]).toBe('\n\n' + history.slice(5).join('\n\n'))
  })

  it('is null for a text that is not the compiled chat shape', () => {
    expect(splitCompiledHistoryText(compiledText([]))).toBeNull()
    expect(splitCompiledHistoryText('==== PREVIOUS CONVERSATION ====\n(none)')).toBeNull()
    expect(splitCompiledHistoryText('<conversation>\n<user>\nno close\n</user>')).toBeNull()
  })
})

describe('history cache blocks in the policy (direct Anthropic)', () => {
  const text = compiledText([...TURN_1, ...TURN_2])

  it('sends the compiled chat as history parts plus a tail, with one point on the last history part', () => {
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages: [SYSTEM, { role: 'user', content: text }] as any })
    const message = result.messages[1] as any
    expect(message.content.map((part: any) => part.type)).toEqual(['text', 'text', 'text'])
    expect(joined(message)).toBe(text)
    expect(message.content[0].providerOptions).toBeUndefined()
    expect(message.content[1].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    expect(message.content[2].providerOptions).toBeUndefined()
    expect(message.content[2].text.startsWith('\n</conversation>')).toBe(true)
    // The same lifetime as the system point.
    expect((result.messages[0] as any).providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    expect(result.metadata.applied).toContain('anthropic.history.cacheControl')
    expect(result.metadata.historyParts).toBe(2)
    expect(result.metadata.cacheTtl).toBe('5m')
    // System + history + the tool loop's request-level point.
    expect(countExplicitCachePoints(result.messages) + 1).toBe(3)
  })

  it('a first turn (no history) keeps its one part and gets no history point', () => {
    const first = compiledText([])
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages: [SYSTEM, { role: 'user', content: first }] as any })
    expect((result.messages[1] as any).content).toBe(first)
    expect(result.metadata.historyParts).toBe(0)
    expect(result.metadata.applied).not.toContain('anthropic.history.cacheControl')
  })

  it('keeps the standing media first: system + standing media + history + tail is exactly four', () => {
    const content = [
      { type: 'text', text: '<awareness_media>\n- a.png\n</awareness_media>' },
      { type: 'image', image: 'data:image/png;base64,AAAA' },
      { type: 'text', text },
      { type: 'image', image: 'data:image/png;base64,BBBB' },
    ]
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages: [SYSTEM, { role: 'user', content }] as any })
    const parts = (result.messages[1] as any).content
    expect(parts.map((p: any) => p.type)).toEqual(['text', 'image', 'text', 'text', 'text', 'image'])
    expect(parts[1].providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral' })
    expect(parts[3].providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral' })
    expect(parts.slice(2, 5).map((p: any) => p.text).join('')).toBe(text)
    expect(result.stepProviderOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    expect(countExplicitCachePoints(result.messages) + 1).toBe(4)
  })

  it("a preset's 1-hour TTL: the history point is on one hour too, and the preset's point stays the tail", () => {
    const result = applyApiPromptCachePolicy({
      ...anthropicDirect,
      messages: [SYSTEM, { role: 'user', content: text }] as any,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    })
    const parts = (result.messages[1] as any).content
    expect(parts[1].providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect((result.messages[0] as any).providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(result.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(result.stepProviderOptions).toBeUndefined()
    expect(result.metadata.cacheTtl).toBe('1h')
  })

  it('no history point when it would leave no slot for the tail point; the tail point still goes on', () => {
    const marked = (n: number) => ({ type: 'text', text: `pinned ${n}`, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } })
    const content = [marked(1), marked(2), { type: 'text', text }]
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages: [SYSTEM, { role: 'user', content }] as any })
    expect(result.metadata.historyParts).toBe(0)
    expect(result.metadata.omitted.map((o) => o.option)).toContain('anthropic.history.cacheControl')
    expect((result.messages[1] as any).content[2]).toEqual({ type: 'text', text })
    expect(result.stepProviderOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
  })

  it('a compiled part that already carries provider options is left whole', () => {
    const content = [{ type: 'text', text, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }]
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages: [SYSTEM, { role: 'user', content }] as any })
    expect((result.messages[1] as any).content).toEqual(content)
    expect(result.metadata.preserved).toContain('anthropic.history.cacheControl')
  })

  it('every other lane keeps the one part: connection-less Claude, connection-less OpenRouter, a non-Claude OpenRouter model, the gateway, OpenAI', () => {
    const lanes = [
      { modelId: 'claude-sonnet-5', providerId: 'anthropic' },
      { modelId: 'anthropic/claude-sonnet-5', providerId: 'openrouter' },
      { modelId: 'openai/gpt-5.5', providerId: 'openrouter', connection: { id: 'openrouter', type: 'openrouter' } as any },
      { modelId: 'anthropic/claude-sonnet-5', providerId: 'vercel-gateway', connection: { id: 'vercel-gateway', type: 'vercel-gateway' } as any },
      { modelId: 'gpt-5.5', providerId: 'openai', connection: { id: 'direct:openai', type: 'direct', service: 'openai' } as any },
    ]
    for (const lane of lanes) {
      const result = applyApiPromptCachePolicy({ ...lane, messages: [SYSTEM, { role: 'user', content: text }] as any })
      expect((result.messages.at(-1) as any).content, lane.providerId).toBe(text)
      expect(result.metadata.historyParts, lane.providerId).toBe(0)
    }
  })

  it('on an approval resume only the compiled message is split; replayed messages are untouched', () => {
    const replayed = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'a1', approved: true }] },
    ]
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages: [SYSTEM, { role: 'user', content: text }, ...replayed] as any })
    expect(result.metadata.historyParts).toBe(2)
    expect(result.messages.slice(2)).toEqual(replayed)
  })
})

describe('history cache blocks on OpenRouter with a Claude model (2026-10-21, second commit)', () => {
  const text = compiledText([...TURN_1, ...TURN_2])
  const openRouter = {
    modelId: 'anthropic/claude-sonnet-5',
    providerId: 'openrouter',
    connection: { id: 'openrouter', type: 'openrouter' } as any,
    userId: 'user-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
  }

  it('the same parts, the marker in the openrouter namespace, and the tail marker still handed to the hook', () => {
    const result = applyApiPromptCachePolicy({ ...openRouter, messages: [SYSTEM, { role: 'user', content: text }] as any })
    const parts = (result.messages[1] as any).content
    expect(parts.map((p: any) => p.text).join('')).toBe(text)
    expect(parts).toHaveLength(3)
    expect(parts[1].providerOptions).toEqual({ openrouter: { cacheControl: { type: 'ephemeral' } } })
    expect(parts[0].providerOptions).toBeUndefined()
    expect(parts[2].providerOptions).toBeUndefined()
    expect(result.metadata.applied).toEqual(expect.arrayContaining(['openrouter.cache_control', 'openrouter.history.cacheControl', 'openrouter.toolLoop.cache_control.lastMessage.fromStep1']))
    expect(result.metadata.historyParts).toBe(2)
    expect(result.toolLoopTailMarker).toEqual({ namespace: 'openrouter', cacheControl: { type: 'ephemeral' } })
    // System + history, plus the hook's one tail marker: three of four.
    expect(countExplicitCachePoints(result.messages) + 1).toBe(3)
  })

  it("BL-1976's first-step marker goes on the step-start message's LAST part beside the history point; the next step puts the original back", () => {
    const result = applyApiPromptCachePolicy({ ...openRouter, messages: [SYSTEM, { role: 'user', content: text }] as any })
    const compiled = result.messages
    const stepStart = compiled[1]
    const marker = result.toolLoopTailMarker!
    const first = placeToolLoopTailMarker(compiled, 2, marker, stepStart)
    const firstParts = (first[1] as any).content
    expect(firstParts[1].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
    expect(firstParts[2].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
    expect(countExplicitCachePoints(first)).toBe(3)
    const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: {} }] } as any
    const results = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'echo', output: { type: 'json', value: {} } }] } as any
    const second = placeToolLoopTailMarker([...first, call, results], 2, marker, stepStart)
    expect(second[1]).toBe(stepStart)
    expect((second[1] as any).content[1].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
    expect((second[3] as any).content[0].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
    expect(countExplicitCachePoints(second)).toBe(3)
  })

  it("a preset's request-level setting takes the tail slot; the history point still goes on, same lifetime", () => {
    const result = applyApiPromptCachePolicy({
      ...openRouter,
      messages: [SYSTEM, { role: 'user', content: text }] as any,
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    })
    expect((result.messages[1] as any).content[1].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(result.toolLoopTailMarker).toBeUndefined()
  })
})

/**
 * BL-1991 (Josh, 2026-10-21: "We need each turn to be separated"). OpenAI's implicit caching puts one
 * breakpoint at the end of the latest eligible message, so the one compiled user message read back only
 * the developer message on every turn start (SA-126 Sol and Luna: 6,073 tokens). On direct OpenAI with
 * GPT-5.6 and later the policy sends the same history parts, with an explicit `promptCacheBreakpoint` on
 * the last history part and the one before it: OpenAI reads an entry back only at a breakpoint the
 * request carries (live, GPT-6 Luna: one breakpoint on the last part read nothing back on turn 3).
 */
describe('history cache blocks on direct OpenAI, GPT-5.6 and later (BL-1991)', () => {
  const text = compiledText([...TURN_1, ...TURN_2, ...TURN_3])
  const openAi = (modelId = 'gpt-6.1-sol') => ({
    modelId,
    providerId: 'openai',
    connection: { id: 'direct:openai', type: 'direct', service: 'openai' } as any,
    userId: 'user-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
  })
  const BREAKPOINT = { openai: { promptCacheBreakpoint: { mode: 'explicit' } } }

  it('history parts plus the tail, bytes unchanged; breakpoints on the last two history parts only', () => {
    const result = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: text }] as any })
    const parts = (result.messages[1] as any).content
    expect(parts).toHaveLength(4)
    expect(parts.map((p: any) => p.text).join('')).toBe(text)
    expect(parts[0].providerOptions).toBeUndefined()
    expect(parts[1].providerOptions).toEqual(BREAKPOINT)
    expect(parts[2].providerOptions).toEqual(BREAKPOINT)
    expect(parts[3].providerOptions).toBeUndefined()
    expect(parts[3].text.startsWith('\n</conversation>')).toBe(true)
    expect(result.metadata.historyParts).toBe(3)
    expect(result.metadata.applied).toEqual(expect.arrayContaining(['openai.promptCacheKey', 'openai.history.promptCacheBreakpoint']))
    // No Anthropic-family marker on an OpenAI request, no tail point for a hook, the system message untouched.
    expect(countExplicitCachePoints(result.messages)).toBe(0)
    expect(result.stepProviderOptions).toBeUndefined()
    expect(result.toolLoopTailMarker).toBeUndefined()
    expect(result.messages[0]).toBe(SYSTEM)
    expect(result.metadata.cacheTtl).toBeNull()
  })

  it('one history turn: one part with the breakpoint (nothing before it to mark); a first turn keeps its one part', () => {
    const one = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: compiledText([...TURN_1]) }] as any })
    const parts = (one.messages[1] as any).content
    expect(parts).toHaveLength(2)
    expect(parts[0].providerOptions).toEqual(BREAKPOINT)
    expect(parts[1].providerOptions).toBeUndefined()
    const first = compiledText([])
    const none = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: first }] as any })
    expect((none.messages[1] as any).content).toBe(first)
    expect(none.metadata.historyParts).toBe(0)
    expect(none.metadata.applied).not.toContain('openai.history.promptCacheBreakpoint')
  })

  it('GPT-5.6 and later only: gpt-5.6, gpt-5-6, gpt-6-luna and gpt-6.1-sol split; gpt-5.5, gpt-5, a dated gpt-5 and gpt-4.1 keep one part', () => {
    for (const modelId of ['gpt-5.6', 'gpt-5-6', 'gpt-5.6-codex', 'gpt-5.10', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-sol-2026-10-01', 'ft:gpt-6-luna:org::abc', 'gpt-7']) {
      const result = applyApiPromptCachePolicy({ ...openAi(modelId), messages: [SYSTEM, { role: 'user', content: text }] as any })
      expect(result.metadata.historyParts, modelId).toBe(3)
    }
    for (const modelId of ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5', 'gpt-5-2026-08-07', 'gpt-5-mini', 'gpt-5.1-codex-max', 'gpt-4.1', 'chatgpt-4o-latest', 'gpt-oss-120b', 'o4-mini']) {
      const result = applyApiPromptCachePolicy({ ...openAi(modelId), messages: [SYSTEM, { role: 'user', content: text }] as any })
      expect((result.messages[1] as any).content, modelId).toBe(text)
      expect(result.metadata.historyParts, modelId).toBe(0)
      expect(result.metadata.applied, modelId).toContain('openai.promptCacheKey')
    }
  })

  it('only when the CONNECTION names direct OpenAI: a model name alone, the gateway and an OpenAI-compatible service keep one part (OpenRouter: Part B below)', () => {
    const lanes = [
      { modelId: 'gpt-6.1-sol', providerId: 'openai' },
      { modelId: 'openai/gpt-6.1-sol', providerId: 'vercel-gateway', connection: { id: 'vercel-gateway', type: 'vercel-gateway' } as any },
      { modelId: 'gpt-6.1-sol', providerId: 'openai', connection: { id: 'direct:qwencloud', type: 'direct', service: 'qwencloud' } as any },
    ]
    for (const lane of lanes) {
      const result = applyApiPromptCachePolicy({ ...lane, messages: [SYSTEM, { role: 'user', content: text }] as any })
      expect((result.messages[1] as any).content, JSON.stringify(lane.connection ?? null)).toBe(text)
      expect(result.metadata.historyParts).toBe(0)
    }
  })

  it('the four-write cap: two breakpoints already there leave no room while implicit mode is on; explicit mode frees the slot', () => {
    const carried = { role: 'user', content: [{ type: 'text', text: 'earlier', providerOptions: BREAKPOINT }, { type: 'text', text: 'note', providerOptions: BREAKPOINT }] }
    const messages = [{ ...SYSTEM }, carried, { role: 'assistant', content: 'ok' }, { role: 'user', content: text }] as any
    const blocked = applyApiPromptCachePolicy({ ...openAi(), messages })
    expect((blocked.messages[3] as any).content).toBe(text)
    expect(blocked.metadata.omitted.map((o) => o.option)).toContain('openai.history.promptCacheBreakpoint')
    const explicitMode = applyApiPromptCachePolicy({ ...openAi(), messages, providerOptions: { openai: { promptCacheOptions: { mode: 'explicit' } } } })
    expect((explicitMode.messages[3] as any).content).toHaveLength(4)
    expect(explicitMode.providerOptions?.openai?.promptCacheOptions).toEqual({ mode: 'explicit' })
  })

  it('the cap at its edge: one breakpoint already there plus the two history ones is three, allowed while implicit mode is on', () => {
    const carried = { role: 'user', content: [{ type: 'text', text: 'earlier', providerOptions: BREAKPOINT }] }
    const result = applyApiPromptCachePolicy({ ...openAi(), messages: [{ ...SYSTEM }, carried, { role: 'assistant', content: 'ok' }, { role: 'user', content: text }] as any })
    expect((result.messages[3] as any).content).toHaveLength(4)
    expect(result.metadata.omitted).toEqual([])
  })

  it('each marked part carries its own breakpoint object', () => {
    const result = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: text }] as any })
    const parts = (result.messages[1] as any).content
    expect(parts[1].providerOptions.openai.promptCacheBreakpoint).not.toBe(parts[2].providerOptions.openai.promptCacheBreakpoint)
  })

  it('a compiled part that already carries provider options is left whole', () => {
    const content = [{ type: 'text', text, providerOptions: BREAKPOINT }]
    const result = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content }] as any })
    expect((result.messages[1] as any).content).toEqual(content)
    expect(result.metadata.preserved).toContain('openai.history.promptCacheBreakpoint')
  })

  it('on an approval resume only the compiled message is split; replayed messages are untouched', () => {
    const replayed = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'a1', approved: true }] },
    ]
    const result = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: text }, ...replayed] as any })
    expect(result.metadata.historyParts).toBe(3)
    expect(result.messages.slice(2)).toEqual(replayed)
  })

  it('a delegated run whose prompt has no compiled chat (a Subagent task) is left as it is', () => {
    const task = 'Summarize the attached notes in five bullet points.'
    const result = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: task }] as any })
    expect((result.messages[1] as any).content).toBe(task)
    expect(result.metadata.historyParts).toBe(0)
  })

  it('a history part written on one turn carries the same bytes on the next, and its breakpoint moves one part on', () => {
    const turn3 = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: compiledText([...TURN_1, ...TURN_2], 'Add tests.') }] as any })
    const turn4 = applyApiPromptCachePolicy({ ...openAi(), messages: [SYSTEM, { role: 'user', content: text }] as any })
    const p3 = (turn3.messages[1] as any).content
    const p4 = (turn4.messages[1] as any).content
    // Turn 3 marked parts 0 and 1; turn 4 marks parts 1 and 2, so its part 1 breakpoint is where turn 3 wrote one.
    expect(p4[0].text).toBe(p3[0].text)
    expect(p4[1].text).toBe(p3[1].text)
    expect(p3[1].providerOptions).toEqual(BREAKPOINT)
    expect(p4[1].providerOptions).toEqual(BREAKPOINT)
    expect(p4[0].providerOptions).toBeUndefined()
  })
})

/**
 * BL-1991 Part B: an OpenAI GPT-5.6+ model through OpenRouter. OpenRouter turns a part's `cache_control`
 * into OpenAI's `prompt_cache_breakpoint`, so the same two history marks go on in the `openrouter`
 * namespace (live, GPT-6 Luna through OpenRouter: turn 3's first call read 6,109 before, 6,415 after).
 */
describe('history cache blocks on OpenRouter with an OpenAI GPT-5.6+ model (BL-1991 Part B)', () => {
  const text = compiledText([...TURN_1, ...TURN_2, ...TURN_3])
  const viaOpenRouter = (modelId = 'openai/gpt-6.1-sol') => ({
    modelId,
    providerId: 'openrouter',
    connection: { id: 'openrouter', type: 'openrouter' } as any,
    userId: 'user-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
  })
  const MARK = { openrouter: { cacheControl: { type: 'ephemeral' } } }

  it('history parts plus the tail; openrouter cache_control on the last two history parts; no tail marker for a hook', () => {
    const result = applyApiPromptCachePolicy({ ...viaOpenRouter(), messages: [SYSTEM, { role: 'user', content: text }] as any })
    const parts = (result.messages[1] as any).content
    expect(parts).toHaveLength(4)
    expect(parts.map((p: any) => p.text).join('')).toBe(text)
    expect(parts[0].providerOptions).toBeUndefined()
    expect(parts[1].providerOptions).toEqual(MARK)
    expect(parts[2].providerOptions).toEqual(MARK)
    expect(parts[3].providerOptions).toBeUndefined()
    expect(result.metadata.applied).toEqual(expect.arrayContaining(['openrouter.session_id', 'openrouter.history.cacheControl.openai']))
    expect(result.metadata.historyParts).toBe(3)
    expect(result.toolLoopTailMarker).toBeUndefined()
    expect(result.stepProviderOptions).toBeUndefined()
    // No system point: that is the Claude-family rule; OpenAI caches the developer message itself.
    expect(result.messages[0]).toBe(SYSTEM)
  })

  it('only OpenAI GPT-5.6+ models through OpenRouter, only when the connection names it', () => {
    for (const modelId of [
      'openai/gpt-5.5',
      'openai/gpt-4.1',
      'openai/gpt-oss-120b',
      'openai/o4-mini',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-chat',
      'z-ai/glm-5.3',
      'x-ai/grok-5',
    ]) {
      const result = applyApiPromptCachePolicy({ ...viaOpenRouter(modelId), messages: [SYSTEM, { role: 'user', content: text }] as any })
      expect((result.messages[1] as any).content, modelId).toBe(text)
      expect(result.metadata.historyParts, modelId).toBe(0)
    }
    // OpenRouter's variant suffixes name the same model.
    for (const modelId of ['openai/gpt-6.1-sol:nitro', 'openai/gpt-6-luna:free']) {
      const result = applyApiPromptCachePolicy({ ...viaOpenRouter(modelId), messages: [SYSTEM, { role: 'user', content: text }] as any })
      expect(result.metadata.historyParts, modelId).toBe(3)
    }
    const connectionless = applyApiPromptCachePolicy({ modelId: 'openai/gpt-6.1-sol', providerId: 'openrouter', messages: [SYSTEM, { role: 'user', content: text }] as any })
    expect((connectionless.messages[1] as any).content).toBe(text)
  })

  it('the cap: two markers already there leave no room for two more under OpenAI implicit mode', () => {
    const carried = { role: 'user', content: [{ type: 'text', text: 'earlier', providerOptions: MARK }, { type: 'text', text: 'note', providerOptions: MARK }] }
    const result = applyApiPromptCachePolicy({ ...viaOpenRouter(), messages: [{ ...SYSTEM }, carried, { role: 'assistant', content: 'ok' }, { role: 'user', content: text }] as any })
    expect((result.messages[3] as any).content).toBe(text)
    expect(result.metadata.omitted.map((o) => o.option)).toContain('openrouter.history.cacheControl.openai')
  })

  it('a request-level cache_control is recorded and counted as one point', () => {
    const requestLevel = { openrouter: { cacheControl: { type: 'ephemeral' } } }
    const result = applyApiPromptCachePolicy({
      ...viaOpenRouter(),
      providerOptions: requestLevel,
      messages: [SYSTEM, { role: 'user', content: text }] as any,
    })
    expect(result.metadata.preserved).toContain('openrouter.cacheControl.automatic')
    expect(result.metadata.historyParts).toBe(3)

    // With one carried marker too, two history marks no longer fit under the cap.
    const carried = { role: 'user', content: [{ type: 'text', text: 'earlier', providerOptions: MARK }] }
    const full = applyApiPromptCachePolicy({
      ...viaOpenRouter(),
      providerOptions: requestLevel,
      messages: [{ ...SYSTEM }, carried, { role: 'assistant', content: 'ok' }, { role: 'user', content: text }] as any,
    })
    expect((full.messages[3] as any).content).toBe(text)
    expect(full.metadata.omitted.map((o) => o.option)).toContain('openrouter.history.cacheControl.openai')
  })
})
