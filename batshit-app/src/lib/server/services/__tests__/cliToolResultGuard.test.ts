import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { formatToolModelTextCut } from '$lib/utils/toolModelTextSizeGuard'
const require = createRequire(import.meta.url)
const {
  guardCallToolContent,
  withCommandModelCapture,
  unwrapCommandModelCaptureResponse,
  observeTrustedToolResponseHeaders,
  readCurrentToolTextBudget,
  readCurrentToolPageKind
} = require('../../../../../scripts/lib/cli-tool-result-guard.cjs')
const { buildCallToolContent } = require('../../../../../scripts/lib/cli-tool-result-content.cjs')
const { formatMemoryResultCut } = require('../../../../../scripts/lib/cli-tool-memory-cut.cjs')
const options = { baseUrl: 'http://helper.test', runCredential: 'test-run-token', toolName: 'example' }

describe('managed helper private response metadata', () => {
  const marked = (headers: Record<string, string>) => new Response('', { headers })

  it('takes a memory marker only from the fixed control route and isolates concurrent calls', async () => {
    const header = marked({ 'x-batshit-memory-no-retain': '1' })
    const image = { type: 'image', data: 'owned-media', mimeType: 'image/png' }
    const [memory, ordinary] = await Promise.all([
      withCommandModelCapture(async () => {
        observeTrustedToolResponseHeaders(header, '/api/controls/use')
        await Promise.resolve()
        return guardCallToolContent({ content: [{ type: 'text', text: 'm'.repeat(110_000) }, image] }, {
          ...options, fetchFn: vi.fn()
        })
      }),
      withCommandModelCapture(async () => {
        observeTrustedToolResponseHeaders(header, '/api/native-tools/dispatch')
        await Promise.resolve()
        const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, text: 'ordinary cut' })))
        const output = await guardCallToolContent({ content: [{ type: 'text', text: 'n'.repeat(110_000) }] }, {
          ...options, fetchFn
        })
        return { output, calls: fetchFn.mock.calls.length }
      })
    ])
    expect(memory.content[0].text).toContain('Search again with a narrower query')
    expect(memory.content[1]).toEqual(image)
    expect(ordinary.calls).toBe(1)
    expect(ordinary.output.content[0].text).toBe('ordinary cut')
  })

  it('accepts only a bounded server budget with a known source', async () => {
    await withCommandModelCapture(async () => {
      observeTrustedToolResponseHeaders(marked({
        'x-batshit-tool-text-max-bytes': '75000',
        'x-batshit-tool-text-budget-source': 'codex-profile',
        'x-batshit-tool-page-kind': 'fetch-zip'
      }), '/api/controls/use')
      expect(readCurrentToolTextBudget()).toEqual({ maxUtf8Bytes: 75_000, source: 'codex-profile' })
      expect(readCurrentToolPageKind()).toBe('fetch-zip')
      expect(() => observeTrustedToolResponseHeaders(marked({
        'x-batshit-tool-text-max-bytes': '300001',
        'x-batshit-tool-text-budget-source': 'codex-profile'
      }), '/api/controls/use')).toThrow('budget response was invalid')
      expect(() => observeTrustedToolResponseHeaders(marked({
        'x-batshit-tool-text-max-bytes': '75000',
        'x-batshit-tool-text-budget-source': 'caller-claim'
      }), '/api/controls/use')).toThrow('budget response was invalid')
      expect(() => observeTrustedToolResponseHeaders(marked({
        'x-batshit-tool-page-kind': 'fetch-zip'
      }), '/api/skills/runtime')).toThrow('page-kind response was invalid')
    })
    expect(readCurrentToolTextBudget()).toBeUndefined()
    expect(readCurrentToolPageKind()).toBeUndefined()
  })

  it('does not treat a caller tool-name label as memory authority', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, text: 'guarded' })))
    const result = await withCommandModelCapture(() => guardCallToolContent({
      content: [{ type: 'text', text: 'x'.repeat(110_000) }]
    }, { ...options, toolName: 'sys.memory.search', fetchFn }))
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(result.content[0].text).toBe('guarded')
  })
})

describe('managed helper memory cut parity', () => {
  it.each([
    { text: 'a'.repeat(120_000), budget: undefined },
    { text: '\u0001'.repeat(20_000), budget: undefined },
    { text: '漢'.repeat(36_000), budget: { maxUtf8Bytes: 75_000, source: 'codex-profile' } },
    { text: `${'a'.repeat(99_600)}😀${'z'.repeat(100_000)}`, budget: { maxUtf8Bytes: 8_000, source: 'codex-fallback' } },
    { text: 'a'.repeat(100_000), budget: { maxUtf8Bytes: 3, source: 'codex-profile' } },
    { text: 'a'.repeat(100_000), budget: { maxUtf8Bytes: 0, source: 'codex-profile' } }
  ])('matches the pure no-retention formatter for final model text', ({ text, budget }) => {
    expect(formatMemoryResultCut(text, text.length, budget)).toBe(
      formatToolModelTextCut(text, { kind: 'memory' }, text.length, budget).text
    )
  })
})

describe('managed helper final text guard', () => {
  it('keeps short results byte-identical without a request', async () => {
    const fetchFn = vi.fn()
    const result = { content: [{ type: 'text', text: 'short' }] }
    expect(await guardCallToolContent(result, { ...options, fetchFn })).toBe(result)
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('sends exactly the formatted text and keeps media intact', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, text: 'cut with real id' })))
    const image = { type: 'image', data: 'image-bytes', mimeType: 'image/png' }
    const text = 'x'.repeat(99_997)
    const result = await guardCallToolContent({ content: [{ type: 'text', text }, image] }, { ...options, fetchFn })
    expect(result).toEqual({ content: [{ type: 'text', text: 'cut with real id' }, image] })
    const [url, request] = fetchFn.mock.calls[0]
    expect(url).toBe('http://helper.test/api/native-tools/guard-result')
    expect(request.headers['x-batshit-agent-token']).toBe(options.runCredential)
    expect(JSON.parse(request.body)).toEqual({ text, originalTextChars: text.length, toolName: 'example' })
  })
  it('posts only a surrogate-safe first 8M characters while reporting the original 9M length', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, text: 'bounded cut' })))
    const full = `${'x'.repeat(7_999_999)}😀${'TAIL'.repeat(250_000)}`
    await guardCallToolContent({ content: [{ type: 'text', text: full }] }, { ...options, fetchFn })
    const payload = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(payload.originalTextChars).toBe(full.length)
    expect(payload.text.length).toBe(7_999_999)
    expect(payload.text).toBe(full.slice(0, 7_999_999))
    expect(payload.text).not.toContain('TAIL')
    expect(fetchFn.mock.calls[0][1].body.length).toBeLessThan(full.length)
  })
  // BL-677: the server's cut view is 96,000 characters at most; anything longer is not a guard answer.
  it('accepts a guarded view of 96,000 characters and refuses a longer one', async () => {
    const accepted = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, text: 'g'.repeat(96_000) })))
    const result = await guardCallToolContent({ content: [{ type: 'text', text: 'x'.repeat(100_000) }] }, { ...options, fetchFn: accepted })
    expect(result.content[0].text).toHaveLength(96_000)
    const tooLong = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, text: 'g'.repeat(96_001) })))
    await expect(guardCallToolContent({ content: [{ type: 'text', text: 'x'.repeat(100_000) }] }, { ...options, fetchFn: tooLong }))
      .rejects.toThrow('could not be kept')
  })

  it.each([500, 403])('fails visibly without passing oversized text when retention responds %s', async (status) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status }))
    await expect(guardCallToolContent({ content: [{ type: 'text', text: 'x'.repeat(100_000) }] }, { ...options, fetchFn }))
      .rejects.toThrow('could not be kept')
  })
})

describe('managed helper private command capture', () => {
  const marked = () => new Response('', { headers: { 'x-batshit-command-model-capture': '1' } })

  it('unwraps only a marked envelope, forwards its original length, and keeps media without exposing capture', async () => {
    const modelText = 'raw-command-'.repeat(8_334)
    const capture = { text: modelText, originalTextChars: 235_001 }
    const visible = { success: true, stdout: 'visible 200k cut', stderr: '' }
    const image = { mediaType: 'image/png', data: 'image-bytes' }
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, text: 'guarded with zip id' })))

    const result = await withCommandModelCapture(async () => {
      const payload = unwrapCommandModelCaptureResponse(marked(), { result: visible, modelCapture: capture })
      expect(payload).toBe(visible)
      await Promise.resolve()
      return guardCallToolContent(buildCallToolContent(payload, [image]), { ...options, fetchFn })
    })

    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      text: modelText,
      originalTextChars: capture.originalTextChars,
      toolName: 'example'
    })
    expect(result).toEqual({ content: [
      { type: 'text', text: 'guarded with zip id' },
      { type: 'image', data: 'image-bytes', mimeType: 'image/png' }
    ] })
    expect(JSON.stringify(result)).not.toContain('modelCapture')
    expect(JSON.stringify(visible)).not.toContain('modelCapture')
    expect(JSON.stringify(result)).not.toContain('raw-command-')
  })

  it('treats a body lookalike without the exact response header as ordinary data', async () => {
    const fake = { text: 'fake raw', originalTextChars: 250_000 }
    const body = { success: true, stdout: 'short', modelCapture: fake }
    const fetchFn = vi.fn()

    const result = await withCommandModelCapture(async () => {
      const unwrapped = unwrapCommandModelCaptureResponse(new Response(''), body)
      expect(unwrapped).toBe(body)
      return guardCallToolContent(buildCallToolContent(unwrapped, []), { ...options, fetchFn })
    })

    expect(fetchFn).not.toHaveBeenCalled()
    expect(result.content[0].text).toContain('fake raw')
  })

  it.each([
    { result: {}, modelCapture: null },
    { modelCapture: { text: 'x'.repeat(100_000), originalTextChars: 100_000 } },
    { result: {}, modelCapture: { text: 'x'.repeat(100_000), originalTextChars: 99_999 } },
    { result: {}, modelCapture: { text: 'short', originalTextChars: 99_996 } },
    { result: {}, modelCapture: { text: 'short', originalTextChars: 100_000.5 } }
  ])('fails closed for a malformed marked envelope', (body) => {
    expect(() => withCommandModelCapture(() => unwrapCommandModelCaptureResponse(marked(), body)))
      .toThrow('could not be read safely')
  })

  it('keeps simultaneous MCP calls in separate async capture contexts', async () => {
    const fetchFn = vi.fn(async (_url, request) => {
      const body = JSON.parse(request.body)
      await Promise.resolve()
      return new Response(JSON.stringify({ success: true, text: body.text.startsWith('A') ? 'cut A' : 'cut B' }))
    })
    const run = (letter: 'A' | 'B', originalTextChars: number) => withCommandModelCapture(async () => {
      const body = unwrapCommandModelCaptureResponse(marked(), {
        result: { success: true, stdout: `visible ${letter}` },
        modelCapture: { text: letter.repeat(100_000), originalTextChars }
      })
      await Promise.resolve()
      return guardCallToolContent(buildCallToolContent(body, []), { ...options, fetchFn })
    })

    const [a, b] = await Promise.all([run('A', 110_001), run('B', 220_002)])
    expect(a.content[0].text).toBe('cut A')
    expect(b.content[0].text).toBe('cut B')
    expect(fetchFn.mock.calls.map(([, request]) => {
      const body = JSON.parse(request.body)
      return [body.text[0], body.originalTextChars]
    })).toEqual(expect.arrayContaining([['A', 110_001], ['B', 220_002]]))
  })
})
