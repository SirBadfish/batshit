/**
 * Bug C and Bug Q (2026-09-18) through the path a live tool result takes to storage: the lane's
 * event adapter (or the API lane's native bash step), send-routed's live zip step
 * (`cliStepForZip`), `adaptCoolToolsToZipSystem`, the real `generateZipDescription`, and the AI
 * view the compiler builds from the stored zip.
 *
 * Bug C: over 30,000 bytes, Claude Code answers a Bash call with a `<persisted-output>` notice in
 * place of the output, and the read lane stored that notice as the file. Bug Q: a sed whose quoted
 * script only contains ` -i ` was stored as an edit of the file it only printed.
 */
import { describe, it, expect, vi } from 'vitest'
import { adaptCoolToolsToZipSystem } from '../coolToolZipAdapter'
import { createZipFromContent } from '../zipService'
import {
  buildCoolToolAiContent,
  parseCoolToolPayload,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import {
  apiShellStep,
  claudeBashEvents,
  cliStepForZip,
  codexCommandEvents
} from '$lib/test-utils/shell-command-steps'
import { ClaudeEventAdapter } from '$lib/server/services/claudeEventAdapter'
import { CodexEventAdapter } from '$lib/server/services/codexEventAdapter'

vi.mock('../zipService', async () => {
  const actual = await vi.importActual<typeof import('../zipService')>('../zipService')
  return {
    ...actual,
    createZipFromContent: vi.fn().mockImplementation((content, type, _sessionId, _messageId, metadata, options) => {
      const zipId = options?.zipId || `${type}_bug_c_mock`
      const description = actual.generateZipDescription(content, type, metadata)
      return Promise.resolve({ zipId, reference: `{{batshit-zip:${zipId}:::${description}}}` })
    })
  }
})

const sessionId = 'session-bug-c'
const NOTICE_PATH = '/Users/example/.claude/projects/-Users-example-hello/0000/tool-results/b0000.txt'

function request(): any {
  return {
    sessionId,
    messageId: 'msg-bug-c',
    agentId: 'agent-bug-c',
    userId: 'user-bug-c',
    model: 'cli',
    messages: [{ role: 'user', content: 'Read the file' }],
    availableTools: [],
    maxToolRounds: 1
  }
}

/** 67 bytes a line with its newline, as in the live capture, so Claude's cut falls inside row 448. */
function rows(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    `entry line ${String(index + 1).padStart(4, '0')} — ünïcödé ✓ abcdefghijabcdefghijabcdefghij`
  ).join('\n')
}

/** Claude Code's answer to a Bash call whose output is over 30,000 bytes (see claudeEventAdapter.test.ts). */
function persistedBashEvents(command: string, output: string): any[] {
  const preview = output.split('\n').slice(0, 33).join('\n')
  const size = `${(Buffer.byteLength(output) / 1024).toFixed(1)}KB`
  return claudeBashEvents({
    id: `toolu_big_${command.length}`,
    command,
    isError: false,
    content: `<persisted-output>\nOutput too large (${size}). Full output saved to: ${NOTICE_PATH}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`,
    toolUseResult: {
      stdout: Buffer.from(output, 'utf8').subarray(0, 30_000).toString('utf8'),
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      persistedOutputPath: NOTICE_PATH,
      persistedOutputSize: Buffer.byteLength(output)
    }
  })
}

async function toolResultChunk(adapter: ClaudeEventAdapter | CodexEventAdapter, events: any[]) {
  async function* stream() {
    yield* events
  }
  for await (const chunk of adapter.stream(stream() as any)) {
    if ((chunk as any).type === 'tool-result') return chunk as any
  }
  throw new Error('no tool-result chunk')
}

/** The stored main payload, its description, and the AI view the compiler builds from it. */
async function storeStep(step: Record<string, any>) {
  vi.mocked(createZipFromContent).mockClear()
  await adaptCoolToolsToZipSystem([step], sessionId, 'msg-bug-c', {})
  const calls = vi.mocked(createZipFromContent).mock.calls
  const main = calls.find((entry) => entry[1] === 'cool_tool') as any
  const raw = calls.find((entry) => entry[1] === 'tool_raw') as any
  const content = main[0] as string
  const metadata = main[4]
  const payload = JSON.parse(content)
  const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
  const rawContent = raw ? (raw[0] as string) : null
  const compiled =
    rawContent && shouldPreferRawSidecarForAiExpansion(payload) ? parseCoolToolPayload(rawContent) || payload : payload
  return {
    payload,
    content,
    description: generateZipDescription(content, 'cool_tool', metadata),
    aiView: buildCoolToolAiContent('zip_bug_c', { content, metadata }, compiled)
  }
}

async function storeClaude(events: any[]) {
  const adapter = new ClaudeEventAdapter({ request: request(), transport: 'cli' })
  const chunk = await toolResultChunk(adapter, events)
  return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
}

const OUTPUT = `${rows(900)}\n`
const CUT_LINE = '[Output cut here by Claude Code: 29,948 of 60,300 bytes kept.]'

describe('a managed Claude Bash output too large to show (Bug C)', () => {
  it("stores the lines Claude kept and where it cut them, never Claude's notice", async () => {
    const stored = await storeClaude(persistedBashEvents('cat /tmp/big.txt', OUTPUT))

    expect(stored.payload.operationKind).toBe('read_file')
    expect(stored.payload.toolResult.content).toBe(`${rows(447)}\n${CUT_LINE}`)
    expect(stored.description).toBe('read_file: /tmp/big.txt - 448 lines')
    expect(stored.content).not.toContain('persisted-output')
    expect(stored.content).not.toContain('Output too large')
    expect(stored.aiView).toContain(`entry line 0447 — ünïcödé ✓ abcdefghijabcdefghijabcdefghij\n${CUT_LINE}\n`)
    expect(stored.aiView).not.toContain('persisted-output')
  })

  it('stores a write the same way', async () => {
    const stored = await storeClaude(
      persistedBashEvents('cat /tmp/big.txt > /tmp/copy.txt && cat /tmp/copy.txt', OUTPUT)
    )

    expect(stored.payload.operationKind).toBe('write_file')
    expect(stored.payload.toolResult.content).toBe(`${rows(447)}\n${CUT_LINE}`)
    expect(stored.aiView).not.toContain('persisted-output')
  })

  it('never lists half a line as an entry', async () => {
    const stored = await storeClaude(persistedBashEvents('ls -1 /tmp/tree', OUTPUT))
    const names = (stored.payload.toolResult.files as any[]).map((entry) => entry.name ?? entry.path ?? entry)

    expect(stored.payload.operationKind).toBe('list_files')
    expect(stored.description).toBe('list_files: /tmp/tree - 447 entries')
    expect(names.every((name: string) => /^entry line \d{4} — ünïcödé ✓ (?:abcdefghij){3}$/.test(name))).toBe(true)
    expect(stored.content).not.toContain('persisted-output')
    expect(stored.content).not.toContain('Output cut here')
  })
})

describe('a quoted sed script that only contains ` -i ` (Bug Q)', () => {
  const NOTES = '/tmp/batshit-example/notes.md'
  const COMMAND = `sed 's/ -i / x /' ${NOTES}`
  const PRINTED = '# Notes\n\nuse sed x to edit a file in place\nabc line two'

  it.each([
    [
      'the managed Claude lane',
      async () =>
        storeClaude(
          claudeBashEvents({
            id: 'toolu_quoted_sed',
            command: COMMAND,
            isError: false,
            content: PRINTED,
            toolUseResult: { stdout: PRINTED, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
          })
        )
    ],
    [
      'the managed Codex lane',
      async () => {
        const adapter = new CodexEventAdapter({ request: request(), transport: 'cli' })
        const chunk = await toolResultChunk(
          adapter,
          codexCommandEvents({ id: 'cx_quoted_sed', command: COMMAND, output: `${PRINTED}\n`, exitCode: 0, status: 'completed' })
        )
        return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
      }
    ],
    [
      'the API lane',
      async () => storeStep(apiShellStep({ id: 'api_quoted_sed', command: COMMAND, stdout: `${PRINTED}\n`, exitCode: 0 }))
    ]
  ])('is stored as a read of the file on %s', async (_lane, store) => {
    const stored = await store()

    expect(stored.payload.operationKind).toBe('read_file')
    expect(stored.payload.toolResult.content.trimEnd()).toBe(PRINTED)
    expect(stored.description).toMatch(/^read_file: \/tmp\/batshit-example\/notes\.md - \d+ lines$/)
    expect(stored.aiView).not.toContain('Diff unavailable')
  })
})
