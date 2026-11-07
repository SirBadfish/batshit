/**
 * Bug Q (2026-09-18) through the path a live tool result takes to storage: the API lane's native
 * bash step, `adaptCoolToolsToZipSystem`, the real `generateZipDescription`, and the AI view the
 * compiler builds from the stored zip. A sed whose quoted script only contains ` -i ` was stored as
 * an edit of the file it only printed.
 *
 * SA-139 R5: the managed Claude Code lane's cases went with the Claude Code CLI Subagent (its event
 * adapter was their only producer; the Claude plan runs Claude Code with no tools of its own, so it
 * never sends a `<persisted-output>` notice). Bug C and BL-8 were that lane's. A stored step that
 * already carries an `outputCut` stays readable (`coolToolAiContent.test.ts`,
 * `toolActivityContract.test.ts`).
 */
import { describe, it, expect, vi } from 'vitest'
import { adaptCoolToolsToZipSystem } from '../coolToolZipAdapter'
import { createZipFromContent } from '../zipService'
import {
  buildCoolToolAiContent,
  parseCoolToolPayload,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import { apiShellStep } from '$lib/test-utils/shell-command-steps'

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

describe('a quoted sed script that only contains ` -i ` (Bug Q)', () => {
  const NOTES = '/tmp/batshit-example/notes.md'
  const COMMAND = `sed 's/ -i / x /' ${NOTES}`
  const PRINTED = '# Notes\n\nuse sed x to edit a file in place\nabc line two'

  it('is stored as a read of the file on the API lane', async () => {
    const stored = await storeStep(apiShellStep({ id: 'api_quoted_sed', command: COMMAND, stdout: `${PRINTED}\n`, exitCode: 0 }))

    expect(stored.payload.operationKind).toBe('read_file')
    expect(stored.payload.toolResult.content.trimEnd()).toBe(PRINTED)
    expect(stored.description).toMatch(/^read_file: \/tmp\/batshit-example\/notes\.md - \d+ lines$/)
    expect(stored.aiView).not.toContain('Diff unavailable')
  })
})
