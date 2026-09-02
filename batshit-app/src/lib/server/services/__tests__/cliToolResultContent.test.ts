/**
 * SA-105 P3 — the managed CLI helper bridge's MCP content shape (DL-105-09).
 *
 * The bridge itself (`scripts/mode4-controls-mcp.cjs`) parses argv and starts a
 * stdio server at import time, so it cannot be required from a test. Its content
 * shaping therefore lives in `scripts/lib/cli-tool-result-content.cjs`, and these
 * tests pin the two upstream facts that decide it:
 *   - Codex accepts MCP `image` blocks, but drops `content[]` entirely if the
 *     result also carries `structuredContent` (openai/codex#10334).
 *   - Claude Code stores MCP `ImageContent` as text at 10-20x the token cost
 *     (anthropic/claude-code#31208, closed not-planned), so it gets none.
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const bridge = require(
  path.resolve(process.cwd(), 'scripts/lib/cli-tool-result-content.cjs')
) as typeof import('../../../../../scripts/lib/cli-tool-result-content.cjs')

const {
  normalizeCliRuntime,
  isRecallPayloadWithMedia,
  buildCallToolContent,
  attachMediaDeliveryError,
  MEMORY_RECALL_CONTROL_ID
} = bridge as any

describe('normalizeCliRuntime', () => {
  it('accepts exactly the two managed runtimes', () => {
    expect(normalizeCliRuntime('codex')).toBe('codex')
    expect(normalizeCliRuntime('claude')).toBe('claude')
    expect(normalizeCliRuntime(' Codex ')).toBe('codex')
  })

  it('returns null for anything else, so an unknown runtime delivers no images', () => {
    // Guessing is the failure this story removes: a wrong guess either hands a
    // model base64 it cannot read, or promises an image that never arrives.
    expect(normalizeCliRuntime(undefined)).toBeNull()
    expect(normalizeCliRuntime('')).toBeNull()
    expect(normalizeCliRuntime('gemini-cli')).toBeNull()
    expect(normalizeCliRuntime(42 as any)).toBeNull()
  })
})

describe('isRecallPayloadWithMedia', () => {
  const withMedia = (idKey: 'target' | 'controlId') => ({
    [idKey]: MEMORY_RECALL_CONTROL_ID,
    result: { recalled: [{ id: 'mem-1', media: [{ media_id: 'm1' }] }] }
  })

  it('matches through both broker (`target`) and direct fabric (`controlId`) shapes', () => {
    expect(isRecallPayloadWithMedia(withMedia('target'))).toBe(true)
    expect(isRecallPayloadWithMedia(withMedia('controlId'))).toBe(true)
  })

  it('skips every other tool result so the bridge does not post them over HTTP', () => {
    expect(isRecallPayloadWithMedia(null)).toBe(false)
    expect(isRecallPayloadWithMedia('text')).toBe(false)
    expect(isRecallPayloadWithMedia({ target: 'sys.artifact.update', result: {} })).toBe(false)
    expect(
      isRecallPayloadWithMedia({
        target: MEMORY_RECALL_CONTROL_ID,
        result: { recalled: [{ id: 'mem-1' }] }
      })
    ).toBe(false)
  })
})

describe('buildCallToolContent', () => {
  const payload = { success: true, result: { recalled: [] } }

  it('emits the JSON text block and NEVER structuredContent', () => {
    const result = buildCallToolContent(payload, [])

    expect(Object.keys(result)).toEqual(['content'])
    expect('structuredContent' in result).toBe(false)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify(payload, null, 2)
    })
  })

  it('appends MCP image blocks after the text block when images are delivered (Codex)', () => {
    const result = buildCallToolContent(payload, [
      { mediaType: 'image/png', data: 'AAAA', filename: 'maggie.png' },
      { mediaType: 'image/jpeg', data: 'BBBB' }
    ])

    expect(result.content).toHaveLength(3)
    expect(result.content[0].type).toBe('text')
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    expect(result.content[2]).toEqual({ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' })
    expect('structuredContent' in result).toBe(false)
  })

  it('emits no image block when the lane returned none (Claude)', () => {
    // The Claude lane's route call returns zero images, so the bridge produces
    // exactly the text-only result it produced before SA-105.
    for (const images of [[], undefined, null]) {
      const result = buildCallToolContent(payload, images as any)
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
    }
  })

  it('drops a malformed image rather than emitting an invalid MCP block', () => {
    const result = buildCallToolContent(payload, [
      { mediaType: 'image/png' },
      { data: 'AAAA' },
      null,
      { mediaType: 'image/png', data: 'CCCC' }
    ] as any)

    expect(result.content).toHaveLength(2)
    expect(result.content[1]).toEqual({ type: 'image', data: 'CCCC', mimeType: 'image/png' })
  })
})

describe('attachMediaDeliveryError', () => {
  it('tells the agent in its own payload when delivery failed — no silent drop', () => {
    const result = attachMediaDeliveryError({ success: true }, 'delivery request failed with status 500')

    expect(result.success).toBe(true)
    expect(result.batshitMediaDeliveryError).toContain('could not be delivered this turn')
    expect(result.batshitMediaDeliveryError).toContain('status 500')
  })

  it('leaves a non-object payload alone', () => {
    expect(attachMediaDeliveryError('raw text', 'boom')).toBe('raw text')
  })
})
