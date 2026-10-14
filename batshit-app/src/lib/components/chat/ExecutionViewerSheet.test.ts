import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'

/**
 * BL-108: on a `CLI` run, the Request block (PA System Prompt, Compiled Messages) is what
 * Batshit handed Codex or Claude Code. The CLI adds its own layer before it calls the model
 * (its tools, project files such as AGENTS.md or CLAUDE.md, and for Codex its own
 * instructions), which Batshit cannot see, so the CLI's reported input is larger than what
 * the sheet shows. The sheet says so on CLI runs, and only there.
 *
 * The runtime blocks copy real snapshots from the native lane (a Codex app-server run, a
 * Claude CLI run, and an API run on Gemini), so the sheet decides from the same fields it
 * reads in the app: `runtime.runtimeId` first, then `agentType`.
 */

const NOTE_TEST_ID = 'execution-viewer-cli-request-note'

const ExecutionViewerSheet = (await import('./ExecutionViewerSheet.svelte')).default

// Opening the existing Collapsible invokes the browser's Animation API. jsdom has none;
// follow the neighboring Settings fixtures locally and restore the prototype after this file.
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => {
  if (typeof Element.prototype.animate !== 'function') Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null }),
  })
})
afterAll(() => {
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else delete (Element.prototype as any).animate
})

function snapshot(overrides: Record<string, unknown>) {
  return {
    id: 'msg_zbtext_0002',
    sessionId: 'zbtext-session',
    userId: 'josh',
    agentId: 'zbtext-agent',
    agentName: 'zbtext agent',
    agentType: 'api',
    createdAt: '2026-09-22T12:00:00.000Z',
    userMessage: 'hello',
    structuredInput: {},
    primarySystemPrompt: 'You are a Batshit agent.',
    compiledMessages: [
      { role: 'system', content: 'You are a Batshit agent.' },
      { role: 'user', content: '<user time="12:00 PM">\nhello\n</user>' }
    ],
    ...overrides
  }
}

const CODEX_RUN = snapshot({
  agentName: 'CLI Codex',
  agentType: 'cli',
  runtime: {
    runtimeId: 'codex',
    providerId: 'openai-codex',
    transport: 'codex-app-server',
    modelName: 'gpt-5.5',
    status: 'succeeded'
  }
})

const CLAUDE_RUN = snapshot({
  agentName: 'CLI Claude',
  agentType: 'cli',
  runtime: {
    runtimeId: 'claude',
    providerId: 'anthropic-claude-cli',
    transport: 'claude-cli',
    modelName: 'opus',
    status: 'succeeded'
  }
})

const API_RUN = snapshot({
  agentName: 'Lucy',
  agentType: 'api',
  runtime: {
    runtimeId: 'vercel',
    providerId: 'google',
    transport: 'vercel-sdk',
    modelName: 'gemini-3.5-flash',
    status: 'succeeded'
  }
})

function installFetch(entry: unknown) {
  // @ts-expect-error test override
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith('/execution-log') ? { entries: [entry] } : { approvals: [] }
    return { ok: true, status: 200, json: async () => body }
  })
}

async function openSheetOn(entry: { agentName: string }) {
  installFetch(entry)
  render(ExecutionViewerSheet, { props: { open: true, sessionId: 'zbtext-session' } })
  // Positive control: the run itself rendered, so an absent note is a real absence.
  await screen.findByText(entry.agentName)
  expect(screen.getByText('Compiled Messages')).toBeTruthy()
}

describe('ExecutionViewerSheet: what a CLI adds on top of the request (BL-108)', () => {
  it('keeps child partial evidence and malformed rows separate from known parent/sibling totals', async () => {
    const usage = { value: 22, confidence: 'exact' }
    const run = (name: string) => ({ kind: 'subagent', name, type: 'cli', model: 'gpt-5.4', provider: 'openai-codex', durationMs: 1000, status: 'failed', thread: 'fresh', usage: null })
    await openSheetOn(snapshot({ agentName: 'Parent with helper observations', delegated: {
      runs: [
        { ...run('Observed helper'), observedUsage: { completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { outputTokens: 0, cacheCreationInputTokens: 3 } }] } },
        { ...run('Invalid helper'), observedUsage: { completeness: 'partial', parts: [null] } },
        { ...run('Known helper'), status: 'completed', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } },
      ], totals: { runs: 3, completed: 1, failed: 2, timedOut: 0, usageKnownRuns: 1, usageUnknownRuns: 2, usage: { totalTokens: 22 } }
    }, responseSummary: { content: { value: 'Usable primary answer', confidence: 'exact' }, usage: { inputTokens: usage, outputTokens: usage, totalTokens: usage }, toolCallsCount: { value: 3, confidence: 'exact' } } }))
    await fireEvent.click(screen.getByRole('button', { name: /Delegated runs/ }))
    expect(await screen.findByText('Observed before this helper ended. Whole-run usage and cost are unknown; later work may be unreported.')).toBeTruthy()
    expect(screen.getByText('Observed helper portion 1')).toBeTruthy()
    expect(screen.getAllByText('Not reported in this portion.').length).toBeGreaterThan(0)
    expect(screen.getByText('Observed usage for this helper is unavailable because the saved partial evidence is invalid. No usage total or cost is inferred from it.')).toBeTruthy()
    expect(screen.getByText('Known helper')).toBeTruthy()
    expect(screen.getByText('Observed helper')).toBeTruthy(); expect(screen.getByText('Invalid helper')).toBeTruthy()
  })
  it.each([
    [null],
    [{ source: 'codex-app-server-progress' }],
    [{ source: 'codex-app-server-progress', counts: null }],
  ])('BL-1409 keeps the Viewer readable and explicitly marks malformed partial evidence unavailable (%j)', async (...parts) => {
    const unknown = { value: null, confidence: 'estimated' }
    await openSheetOn(snapshot({
      agentName: 'Codex invalid observation', agentType: 'cli', runtime: { runtimeId: 'codex', status: 'failed' },
      responseSummary: {
        content: { value: 'The saved reply is retained.', confidence: 'exact' },
        usage: { inputTokens: unknown, outputTokens: unknown, totalTokens: unknown },
        toolCallsCount: { value: 0, confidence: 'exact' },
        observedUsage: { completeness: 'partial', parts },
      },
    }))
    await fireEvent.click(screen.getByRole('button', { name: /Final Output/ }))
    expect(await screen.findByText('Observed usage is unavailable because the saved partial evidence is invalid. No usage total or cost is inferred from it.')).toBeTruthy()
    expect(screen.getByText('Compiled Messages')).toBeTruthy()
    expect(screen.getByText('Codex invalid observation')).toBeTruthy()
    expect(screen.getByText('The saved reply is retained.')).toBeTruthy()
    expect(screen.queryByText(/Observed Codex portion/)).toBeNull()
    expect(screen.queryByText(/Total: 0/)).toBeNull()
  })
  it('BL-1361 labels observed portions without putting a reported zero or partial aggregate in the whole-run header', async () => {
    const unknown = { value: null, confidence: 'estimated' as const }
    await openSheetOn(snapshot({
      agentName: 'Failed Codex', agentType: 'cli', runtime: { runtimeId: 'codex', providerId: 'openai-codex', transport: 'codex-app-server', modelName: 'synthetic', status: 'failed' },
      responseSummary: {
        content: { value: 'Partial words', confidence: 'exact' },
        usage: { inputTokens: unknown, outputTokens: unknown, totalTokens: unknown },
        toolCallsCount: { value: 0, confidence: 'exact' },
        observedUsage: { completeness: 'partial', parts: [
          { source: 'run-usage-prefix', counts: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } },
          { source: 'codex-app-server-progress', counts: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheCreationInputTokens: 0 } },
        ] },
      },
    }))
    expect(screen.queryByText('Total: 110')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: /Final Output/ }))
    expect(await screen.findByText('Observed before ending. Whole-run usage and cost are unknown; later work may be unreported.')).toBeTruthy()
    expect(screen.getByText('Recorded reply portion 1')).toBeTruthy()
    expect(screen.getByText('Observed Codex portion 2')).toBeTruthy()
    expect(screen.getByText('100')).toBeTruthy()
    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Not reported in this portion.').length).toBeGreaterThan(0)
    expect(screen.queryByText('Total: 110')).toBeNull()
  })
  it('explains a saved group skip as a judgment without inventing a speaker or provider call', async () => {
    installFetch(snapshot({ agentId: null, agentName: 'Group', agentType: 'group_speaker', structuredInput: null,
      compiledMessages: undefined, primarySystemPrompt: undefined,
      executionMetadata: { typesafeCalls: [{ feature: 'group_speaker', model: 'synthetic', status: 'ok',
        latencyMs: 1, usage: null, deadlineHit: false, questionCount: 4, at: '2026-10-11T05:00:00Z' }],
        groupChat: { groupTurnId: 'round1', eventIndex: 1, speakerSelection: { by: 'jev', reason: 'no_reply', noReplyConfidence: 0.93, skipped: [] } } } }))
    render(ExecutionViewerSheet, { props: { open: true, sessionId: 'zbtext-session' } })
    const explanation = await screen.findByTestId('execution-viewer-group-speaker-selection')
    expect(explanation.textContent).toBe('Reply skipped by Jev (93% confidence). No agent was run for this group turn.')
    expect(screen.queryByText(/Speaker picked by/)).toBeNull()
  })
  it('SA-120 P10a: names the judge that decided, in the group line and in the Judge Juice calls table', async () => {
    installFetch(snapshot({ agentId: null, agentName: 'Group', agentType: 'group_speaker', structuredInput: null,
      compiledMessages: undefined, primarySystemPrompt: undefined,
      executionMetadata: { typesafeCalls: [
        { feature: 'group_speaker', model: 'clef-flash', provider: { id: 'ollama-mac', kind: 'ollama', label: 'Ollama on this Mac' }, status: 'ok',
          latencyMs: 31, usage: { inputTokens: 154, outputTokens: 0 }, deadlineHit: false, questionCount: 4, at: '2026-10-12T20:00:00Z' },
        { feature: 'smart_zip', model: 'clef-flash', provider: { id: 'cf', kind: 'cloudflare', label: 'Cloudflare' }, status: 'unavailable', reason: 'provider_limit',
          detail: 'a Choice with 30 options; this judge takes at most 26', latencyMs: 0, usage: null, deadlineHit: false, questionCount: 2, at: '2026-10-12T20:00:01Z' },
        // A row from before P10a: no provider, TypeSafe.
        { feature: 'reply_check', model: 'jev-1.13.0', status: 'ok', latencyMs: 180, usage: null, deadlineHit: false, questionCount: 3, at: '2026-10-12T20:00:02Z' }
      ],
        groupChat: { groupTurnId: 'round1', eventIndex: 1, noReplyReceipt: 'refused', speakerSelection: { by: 'jev', reason: 'no_reply', noReplyConfidence: 0.93, skipped: [] } } } }))
    render(ExecutionViewerSheet, { props: { open: true, sessionId: 'zbtext-session' } })
    const explanation = await screen.findByTestId('execution-viewer-group-speaker-selection')
    expect(explanation.textContent).toBe('Reply skipped by Clef Flash (93% confidence). No agent was run for this group turn.')
    expect(document.body.textContent).toContain('Clef Flash proposed no reply, but Batshit refused to save the receipt.')
    const providers = screen.getAllByTestId('execution-viewer-jev-juice-provider').map((cell) => cell.textContent?.trim())
    expect(providers).toEqual(['clef-flash · Ollama on this Mac', 'clef-flash · Cloudflare', 'jev-1.13.0 · TypeSafe'])
    const table = screen.getByTestId('execution-viewer-jev-juice-table')
    expect(table.textContent).toContain('Jev')
    expect(table.textContent).toContain('The request was too large for this judge (Cloudflare), so Batshit did not send it.')
    expect(document.body.textContent).toContain('Typed judgments Batshit asked a judge for during this run')
  })
  it('SA-120 P10a round 1, S5: a row whose chosen judge was missing reads "No judge", never Jev, here and in the group line', async () => {
    installFetch(snapshot({ agentId: null, agentName: 'Group', agentType: 'group_speaker', structuredInput: null,
      compiledMessages: undefined, primarySystemPrompt: undefined,
      executionMetadata: { typesafeCalls: [
        { feature: 'group_speaker', model: null, chosenProviderId: 'deleted-judge', status: 'unavailable', reason: 'no_provider',
          latencyMs: 0, usage: null, deadlineHit: false, questionCount: 4, at: '2026-10-12T21:00:00Z' }
      ],
        groupChat: { groupTurnId: 'round2', eventIndex: 1, speakerSelection: { by: 'rules', reason: 'unavailable', skipped: [] } } } }))
    render(ExecutionViewerSheet, { props: { open: true, sessionId: 'zbtext-session' } })
    const explanation = await screen.findByTestId('execution-viewer-group-speaker-selection')
    expect(explanation.textContent).toBe('Speaker picked by the usual rules (no judge is set up for this feature).')
    const table = screen.getByTestId('execution-viewer-jev-juice-table')
    expect(table.textContent).toContain('No judge')
    expect(table.textContent).not.toContain('Jev')
    expect(screen.getByTestId('execution-viewer-jev-juice-provider').textContent?.trim()).toBe('chosen: deleted-judge')
    expect(table.textContent).toContain('The judge chosen for this feature is missing or not set up')
  })
  it('SA-120 P10a round 2: a damaged stored choice reads "a damaged choice", never the raw marker', async () => {
    await openSheetOn(snapshot({ executionMetadata: { typesafeCalls: [
      { feature: 'smart_zip', model: null, chosenProviderId: '__unreadable__', status: 'unavailable', reason: 'no_provider',
        latencyMs: 0, usage: null, deadlineHit: false, questionCount: 2, at: '2026-10-12T22:00:00Z' }
    ] } }))
    expect(screen.getByTestId('execution-viewer-jev-juice-provider').textContent?.trim()).toBe('chosen: a damaged choice')
    expect(document.body.textContent).not.toContain('__unreadable__')
  })
  it.each(['preset_rules', 'picked'])('labels %s judgments honestly, without per-agent false confidence', async (reason) => {
    await openSheetOn(snapshot({ executionMetadata: { groupChat: { groupTurnId: 'round', speakerSelection: {
      by: reason === 'picked' ? 'jev' : 'rules', reason, probability: 0.7, ...(reason === 'preset_rules' ? { noReplyConfidence: 0.9 } : {}), skipped: [{ agentName: 'Smart A', addsValue: 0.1 }]
    } } } }))
    const text = screen.getByTestId('execution-viewer-group-speaker-selection').textContent
    if (reason === 'preset_rules') {
      expect(text).toContain('own speaking preset rules')
      expect(text).toContain('no reply was needed (90% confidence)')
    } else expect(text).toContain('adding little or needing no reply on this follow-up')
    expect(text).not.toContain('10% confidence')
    if (reason === 'preset_rules') expect(text).not.toContain('picked by Jev')
  })

  it.each(['stopped', 'refused', 'unconfirmed'])('shows %s as a receipt outcome, without pretending a speaker ran', async (receipt) => {
    await openSheetOn(snapshot({ agentId: null, agentType: 'group_speaker', structuredInput: null,
      executionMetadata: { groupChat: { groupTurnId: 'round', noReplyReceipt: receipt } } }))
    expect(screen.queryByTestId('execution-viewer-group-speaker-selection')).toBeNull()
    expect(document.body.textContent).toContain(receipt === 'unconfirmed' ? 'without running an agent' : receipt === 'stopped' ? 'turn was stopped' : 'refused to save')
  })
  it('tells a Codex run that Codex adds instructions, tools, and AGENTS.md Batshit cannot see', async () => {
    await openSheetOn(CODEX_RUN)

    const note = screen.getByTestId(NOTE_TEST_ID)
    expect(note.textContent).toContain('Codex adds its own instructions, tools, and project files (such as AGENTS.md)')
    expect(note.textContent).toContain('Batshit cannot see')
    expect(note.textContent).toContain('the input Codex reports is larger than the request shown here')
    expect(note.className).toContain('execution-viewer-note')
  })

  it('tells a Claude Code run that Claude Code adds tools and CLAUDE.md Batshit cannot see', async () => {
    await openSheetOn(CLAUDE_RUN)

    const note = screen.getByTestId(NOTE_TEST_ID)
    expect(note.textContent).toContain('Claude Code adds its own tools and project files (such as CLAUDE.md)')
    expect(note.textContent).toContain('Batshit cannot see')
    expect(note.textContent).toContain('the input Claude Code reports is larger than the request shown here')
    expect(note.textContent).not.toContain('instructions')
  })

  it('says nothing of the kind on an API run, where the sheet shows the request the provider got', async () => {
    await openSheetOn(API_RUN)

    expect(screen.queryByTestId(NOTE_TEST_ID)).toBeNull()
    expect(document.body.textContent).not.toContain('Batshit cannot see')
  })
})
