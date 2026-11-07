// @vitest-environment node
/**
 * SA-139 P2: the Claude plan connection's pure rules (tool naming, MCP answers, the opening
 * prompt, finish reasons and usage). No process, socket or model call.
 */
import { getErrorMessage, type LanguageModelV4Prompt } from '@ai-sdk/provider'
import { detectMediaType } from '@ai-sdk/provider-utils'
import { describe, expect, it, vi } from 'vitest'

import {
  ClaudePlanRunError,
  buildClaudePlanOpening,
  claudePlanDescriptionLimit,
  claudePlanFinishReason,
  claudePlanResultFailure,
  claudePlanRunHttpStatus,
  claudePlanSdkErrorAnswer,
  claudePlanUsage,
  mapClaudePlanWireName,
  claudeCodeNoSuchToolText,
  claudePlanUnlistedCallFailure,
  claudePlanUnlistedToolNote,
  prepareClaudePlanToolAnswer,
  prepareClaudePlanTools,
  recordedClaudePlanToolAnswer,
  sameClaudePlanToolAnswer,
  toClaudePlanToolAnswer,
  toMcpToolListing,
  type ClaudePlanToolAnswer
} from '../claudePlanProtocol'
import { isContextExhaustedStreamFailure } from '../streamFailureEvidence'

const fn = (name: string, description = 'Does a thing.') =>
  ({ type: 'function', name, description, inputSchema: { type: 'object', properties: {} } }) as any

function code(run: () => unknown): string | undefined {
  try { run() } catch (error) { return error instanceof ClaudePlanRunError ? error.code : `other:${String(error)}` }
  return undefined
}

async function codeAsync(run: () => Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  try { await run() } catch (error) {
    return error instanceof ClaudePlanRunError ? { code: error.code, message: error.message } : { code: `other:${String(error)}`, message: String(error) }
  }
  return { code: undefined, message: '' }
}

const bytes = (...values: number[]) => new Uint8Array(values)
// The 8-byte PNG signature followed by a few bytes: all the SDK's detector needs.
const PNG_BYTES = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4)
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64')
// Bytes the detector does not recognize as any image.
const PLAIN_BYTES = bytes(1, 2, 3, 4)
const PLAIN_BASE64 = Buffer.from(PLAIN_BYTES).toString('base64')
const text = (value: string): ClaudePlanToolAnswer['content'][number] => ({ type: 'text', text: value })
const image = (mimeType: string, data = 'AAA'): ClaudePlanToolAnswer['content'][number] => ({ type: 'image', data, mimeType })
const answer = (content: ClaudePlanToolAnswer['content'], isError = false): ClaudePlanToolAnswer => ({ isError, content })
const user = (...content: any[]): LanguageModelV4Prompt[number] => ({ role: 'user', content })
const file = (mediaType: string, data: Uint8Array | string) => ({ type: 'file', mediaType, data: { type: 'data', data } })

describe('prepareClaudePlanTools', () => {
  it('names a function tool mcp__batshit__<name>', () => {
    const [tool] = prepareClaudePlanTools([fn('get_weather')])
    expect(tool.wireName).toBe('mcp__batshit__get_weather')
    expect(tool.name).toBe('get_weather')
  })

  it('refuses a provider tool as unsupported_tool', () => {
    expect(code(() => prepareClaudePlanTools([{ type: 'provider', id: 'x.web_search', name: 'web_search', args: {} } as any]))).toBe('unsupported_tool')
  })

  it('refuses a name with a character outside letters, digits, _ and -', () => {
    for (const name of ['bad.name', 'bad name', 'bad/name', 'naïve', '']) {
      expect(code(() => prepareClaudePlanTools([fn(name)])), name).toBe('unsupported_tool')
    }
  })

  it('allows a 114-character name and refuses 115 (wire name over 128)', () => {
    expect(prepareClaudePlanTools([fn('a'.repeat(114))])[0].wireName).toHaveLength(128)
    expect(code(() => prepareClaudePlanTools([fn('a'.repeat(115))]))).toBe('unsupported_tool')
  })

  it('marks read-only only the tools the caller names (registration, never the bare name)', () => {
    const prepared = prepareClaudePlanTools([fn('read_file'), fn('write_file'), fn('get_weather')], new Set(['read_file']))
    expect(prepared.map(tool => tool.readOnly)).toEqual([true, false, false])
    expect(prepareClaudePlanTools([fn('read_file')]).map(tool => tool.readOnly)).toEqual([false])
  })
})

describe('tool listing and names', () => {
  it('lists readOnlyHint and the max result size', () => {
    const [read, write] = prepareClaudePlanTools([fn('read_file'), fn('run_it')], new Set(['read_file']))
    expect(toMcpToolListing(read).annotations).toEqual({ readOnlyHint: true })
    expect(toMcpToolListing(write).annotations).toEqual({ readOnlyHint: false })
    expect(toMcpToolListing(read)._meta['anthropic/maxResultSizeChars']).toBe(500000)
  })

  it('lifts the description limit to at least 8192, and to longest + 1024 when larger', () => {
    expect(claudePlanDescriptionLimit([])).toBe(8192)
    expect(claudePlanDescriptionLimit(prepareClaudePlanTools([fn('a', 'x'.repeat(100))]))).toBe(8192)
    expect(claudePlanDescriptionLimit(prepareClaudePlanTools([fn('a', 'x'.repeat(10_000)), fn('b', 'y')]))).toBe(11_024)
  })

  it('maps a streamed wire name only on an exact match', () => {
    const tools = prepareClaudePlanTools([fn('get_weather')])
    expect(mapClaudePlanWireName('mcp__batshit__get_weather', tools)?.name).toBe('get_weather')
    for (const wrong of ['get_weather', 'mcp__batshit__get_weather ', 'mcp__batshit__GET_WEATHER', 'mcp__other__get_weather', 'mcp__batshit__get']) {
      expect(mapClaudePlanWireName(wrong, tools), wrong).toBeNull()
    }
  })

  it('BL-2368: Claude Code\'s own answer to an unlisted name, exactly as the pin records it (recorded/misnamed)', () => {
    expect(claudeCodeNoSuchToolText('batshit__batshit__get_weather')).toBe('<tool_use_error>Error: No such tool available: batshit__batshit__get_weather</tool_use_error>')
  })

  it('BL-2368: the note names the form tools take here and the likely meaning, one line per name', () => {
    const tools = prepareClaudePlanTools([fn('get_weather'), fn('native_batshit_tool_use'), fn('tool_use')])
    const note = claudePlanUnlistedToolNote(['batshit__batshit__native_batshit_tool_use', 'something_else', 'x'.repeat(200)], tools)
    const [first, second, third] = note.split('\n')
    expect(first).toBe('Batshit: no tool is named batshit__batshit__native_batshit_tool_use, so that call ran nothing. Batshit\'s tools are listed here as mcp__batshit__<name>; call one by its exact listed name (perhaps mcp__batshit__native_batshit_tool_use).')
    expect(second).not.toContain('perhaps')
    expect(third).toContain(`${'x'.repeat(128)}…`)
    expect(third).not.toContain('x'.repeat(129))
    expect(claudePlanUnlistedCallFailure('get_weather')).toMatch(/get_weather.*mcp__batshit__<name>.*ran nothing/)
  })

  it('BL-2368 review: the guess needs a name boundary; each name once, at most five, so the note stays small', () => {
    const tools = prepareClaudePlanTools([fn('use'), fn('tool_use'), fn('get_weather')])
    expect(claudePlanUnlistedToolNote(['batshit__tool_use'], tools)).toContain('(perhaps mcp__batshit__tool_use)')
    expect(claudePlanUnlistedToolNote(['batshit_reuse'], tools)).not.toContain('perhaps')
    expect(claudePlanUnlistedToolNote(['get_weather'], tools)).toContain('(perhaps mcp__batshit__get_weather)')
    const names = ['a1', 'a2', 'a3', 'a1', 'a4', 'a5', 'a6', 'a7', 'a2']
    const lines = claudePlanUnlistedToolNote(names, tools).split('\n')
    expect(lines.slice(0, 5).map(line => line.match(/no tool is named (\S+),/)?.[1])).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
    expect(lines[5]).toBe('Batshit: 2 more wrong names; their calls ran nothing too.')
    expect(lines).toHaveLength(6)
    expect(claudePlanUnlistedToolNote(Array.from({ length: 40 }, (_, i) => `${'n'.repeat(200)}${i}`), tools).length).toBeLessThan(3000)
  })
})

describe('toClaudePlanToolAnswer', () => {
  it('passes text through', () => {
    expect(toClaudePlanToolAnswer({ type: 'text', value: 'sunny' })).toEqual({ isError: false, content: [{ type: 'text', text: 'sunny' }] })
  })

  it('stringifies json', () => {
    expect(toClaudePlanToolAnswer({ type: 'json', value: { a: [1, 'b'] } })).toEqual({ isError: false, content: [{ type: 'text', text: '{"a":[1,"b"]}' }] })
  })

  it('marks error-text and error-json as errors', () => {
    expect(toClaudePlanToolAnswer({ type: 'error-text', value: 'no' })).toEqual({ isError: true, content: [{ type: 'text', text: 'no' }] })
    expect(toClaudePlanToolAnswer({ type: 'error-json', value: { code: 7 } })).toEqual({ isError: true, content: [{ type: 'text', text: '{"code":7}' }] })
  })

  it('says why an execution was denied, or just that it was not run', () => {
    expect(toClaudePlanToolAnswer({ type: 'execution-denied', reason: 'Josh said no' })).toEqual({ isError: true, content: [{ type: 'text', text: 'The call was not run: Josh said no' }] })
    expect(toClaudePlanToolAnswer({ type: 'execution-denied' })).toEqual({ isError: true, content: [{ type: 'text', text: 'The call was not run.' }] })
  })

  it('maps content text and image bytes to base64, keeping an existing base64 string', () => {
    const answer = toClaudePlanToolAnswer({
      type: 'content',
      value: [
        { type: 'text', text: 'see image' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: bytes(1, 2, 3) } },
        { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'QUJD' } }
      ]
    } as any)
    expect(answer).toEqual({
      isError: false,
      content: [
        { type: 'text', text: 'see image' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
        { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }
      ]
    })
  })

  it('pins the fixture bytes: the SDK detector reads them as png and the plain bytes as nothing', () => {
    expect(detectMediaType({ data: PNG_BYTES, topLevelType: 'image' })).toBe('image/png')
    expect(detectMediaType({ data: PNG_BASE64, topLevelType: 'image' })).toBe('image/png')
    expect(detectMediaType({ data: PLAIN_BYTES, topLevelType: 'image' })).toBeUndefined()
  })

  it('releases a real png declared as jpeg as image/png: the SDK detection wins', () => {
    for (const data of [PNG_BYTES, PNG_BASE64]) {
      const result = toClaudePlanToolAnswer({ type: 'content', value: [{ type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data } }] } as any)
      expect(result.content).toEqual([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }])
    }
  })

  it('keeps the declared type for bytes the detector does not recognize', () => {
    const result = toClaudePlanToolAnswer({ type: 'content', value: [{ type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: PLAIN_BYTES } }] } as any)
    expect(result.content).toEqual([{ type: 'image', data: PLAIN_BASE64, mimeType: 'image/jpeg' }])
  })

  it('refuses an image given as a data: string as unsupported_input', () => {
    expect(code(() => toClaudePlanToolAnswer({
      type: 'content',
      value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: `data:image/png;base64,${PNG_BASE64}` } }]
    } as any))).toBe('unsupported_input')
  })

  it('maps a text file part to text', () => {
    const answer = toClaudePlanToolAnswer({ type: 'content', value: [{ type: 'file', mediaType: 'text/plain', data: { type: 'text', text: 'notes' } }] } as any)
    expect(answer.content).toEqual([{ type: 'text', text: 'notes' }])
  })

  it('refuses a part it cannot hand over as unsupported_input', () => {
    expect(code(() => toClaudePlanToolAnswer({ type: 'content', value: [file('application/pdf', bytes(1))] } as any))).toBe('unsupported_input')
    expect(code(() => toClaudePlanToolAnswer({ type: 'content', value: [{ type: 'image-url', url: 'https://x/y.png' }] } as any))).toBe('unsupported_input')
    expect(code(() => toClaudePlanToolAnswer({ type: 'mystery' } as any))).toBe('unsupported_input')
  })

  it('turns an SDK error into the SDK error text, marked as an error', () => {
    const answer = claudePlanSdkErrorAnswer(new Error('boom'))
    expect(answer.isError).toBe(true)
    expect(answer.content).toEqual([{ type: 'text', text: getErrorMessage(new Error('boom')) }])
  })
})

describe('prepareClaudePlanToolAnswer', () => {
  const url = new URL('https://example.com/a.png')
  const linked = (mediaType: string) => ({ type: 'file', mediaType, data: { type: 'url', url } })
  const downloadOf = (result: Array<{ data: Uint8Array; mediaType?: string } | null>) => vi.fn(async () => result)

  it('downloads a linked image once, through the SDK contract, and releases the downloaded bytes with the detected type', async () => {
    const download = downloadOf([{ data: PNG_BYTES, mediaType: 'image/jpeg' }])
    const result = await prepareClaudePlanToolAnswer({ type: 'content', value: [{ type: 'text', text: 'look' }, linked('image/*')] } as any, download)
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith([{ url, isUrlSupportedByModel: false }])
    expect(result).toEqual({ isError: false, content: [text('look'), { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] })
  })

  it('takes the downloaded media type for a partial declared one when the bytes name no image type', async () => {
    const result = await prepareClaudePlanToolAnswer({ type: 'content', value: [linked('image/*')] } as any, downloadOf([{ data: PLAIN_BYTES, mediaType: 'image/webp' }]))
    expect(result.content).toEqual([{ type: 'image', data: PLAIN_BASE64, mimeType: 'image/webp' }])
  })

  it('keeps a declared full media type over the downloaded one unless the bytes say otherwise', async () => {
    const plain = await prepareClaudePlanToolAnswer({ type: 'content', value: [linked('image/png')] } as any, downloadOf([{ data: PLAIN_BYTES, mediaType: 'image/jpeg' }]))
    expect(plain.content).toEqual([{ type: 'image', data: PLAIN_BASE64, mimeType: 'image/png' }])
    const sniffed = await prepareClaudePlanToolAnswer({ type: 'content', value: [linked('image/jpeg')] } as any, downloadOf([{ data: PNG_BYTES, mediaType: 'image/jpeg' }]))
    expect(sniffed.content).toEqual([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }])
  })

  it('refuses a link the download returns null for, naming the URL', async () => {
    const download = downloadOf([null])
    const { code: refused, message } = await codeAsync(() => prepareClaudePlanToolAnswer({ type: 'content', value: [linked('image/*')] } as any, download))
    expect(refused).toBe('unsupported_input')
    expect(message).toContain('https://example.com/a.png')
  })

  it('matches each link to its own download result, in order', async () => {
    const second = new URL('https://example.com/b.png')
    const download = downloadOf([{ data: PNG_BYTES }, { data: PLAIN_BYTES, mediaType: 'image/gif' }])
    const result = await prepareClaudePlanToolAnswer({
      type: 'content',
      value: [linked('image/*'), { type: 'text', text: 'between' }, { type: 'file', mediaType: 'image/*', data: { type: 'url', url: second } }]
    } as any, download)
    expect(download).toHaveBeenCalledWith([{ url, isUrlSupportedByModel: false }, { url: second, isUrlSupportedByModel: false }])
    expect(result.content).toEqual([
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      text('between'),
      { type: 'image', data: PLAIN_BASE64, mimeType: 'image/gif' }
    ])
  })

  it('returns what toClaudePlanToolAnswer returns, and never downloads, for an output without links', async () => {
    const download = downloadOf([])
    const outputs = [
      { type: 'text', value: 'sunny' },
      { type: 'error-json', value: { code: 7 } },
      { type: 'content', value: [{ type: 'text', text: 'see' }, { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: PNG_BYTES } }] }
    ] as any[]
    for (const output of outputs) {
      expect(await prepareClaudePlanToolAnswer(output, download)).toEqual(toClaudePlanToolAnswer(output))
    }
    expect(download).not.toHaveBeenCalled()
  })
})

describe('sameClaudePlanToolAnswer', () => {
  it('matches equal text answers and refuses different text', () => {
    expect(sameClaudePlanToolAnswer(answer([text('a')]), answer([text('a')]))).toBe(true)
    expect(sameClaudePlanToolAnswer(answer([text('a')]), answer([text('b')]))).toBe(false)
  })

  it('refuses a different error flag', () => {
    expect(sameClaudePlanToolAnswer(answer([text('a')], true), answer([text('a')], false))).toBe(false)
    expect(sameClaudePlanToolAnswer(answer([text('a')], true), answer([text('a')], true))).toBe(true)
  })

  it('matches images by count and media type, ignoring bytes', () => {
    expect(sameClaudePlanToolAnswer(answer([image('image/png', 'AAA')]), answer([image('image/png', 'BBB')]))).toBe(true)
    expect(sameClaudePlanToolAnswer(answer([image('image/png')]), answer([image('image/jpeg')]))).toBe(false)
    expect(sameClaudePlanToolAnswer(answer([image('image/png')]), answer([image('image/png'), image('image/png')]))).toBe(false)
  })

  it('refuses an image against text at the same index', () => {
    expect(sameClaudePlanToolAnswer(answer([text('a'), image('image/png')]), answer([text('a'), text('image/png')]))).toBe(false)
    expect(sameClaudePlanToolAnswer(answer([image('image/png')]), answer([text('')]))).toBe(false)
  })

  it('matches when one side names no image media type', () => {
    expect(sameClaudePlanToolAnswer(answer([image('')]), answer([image('image/png')]))).toBe(true)
    expect(sameClaudePlanToolAnswer(answer([image('image/png')]), answer([image('')]))).toBe(true)
  })

  it('ignores empty text items on both sides', () => {
    expect(sameClaudePlanToolAnswer(answer([text(''), text('a')]), answer([text('a')]))).toBe(true)
    expect(sameClaudePlanToolAnswer(answer([text('a')]), answer([text('a'), text('')]))).toBe(true)
    expect(sameClaudePlanToolAnswer(answer([text('')]), answer([]))).toBe(true)
  })
})

describe('recordedClaudePlanToolAnswer', () => {
  it('turns a string content into one text item', () => {
    expect(recordedClaudePlanToolAnswer({ content: 'sunny' })).toEqual({ isError: false, content: [text('sunny')] })
  })

  it('maps text and a base64 image block', () => {
    const recorded = recordedClaudePlanToolAnswer({
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
      ]
    })
    expect(recorded.content).toEqual([text('see'), { type: 'image', data: 'AAA', mimeType: 'image/png' }])
  })

  it('reads is_error true as an error and an absent flag as not an error', () => {
    expect(recordedClaudePlanToolAnswer({ content: 'no', is_error: true }).isError).toBe(true)
    expect(recordedClaudePlanToolAnswer({ content: 'yes' }).isError).toBe(false)
    expect(recordedClaudePlanToolAnswer({ content: 'yes', is_error: 'true' }).isError).toBe(false)
  })

  it('reads missing or unusable content as empty', () => {
    expect(recordedClaudePlanToolAnswer({}).content).toEqual([])
    expect(recordedClaudePlanToolAnswer(null).content).toEqual([])
  })

  it('records an unknown item type as something that matches no plain text answer', () => {
    const recorded = recordedClaudePlanToolAnswer({ content: [{ type: 'document' }] })
    expect(recorded.content).toHaveLength(1)
    expect(sameClaudePlanToolAnswer(recorded, answer([text('document')]))).toBe(false)
  })

  it('agrees with a released answer: the same conversion on both sides matches', () => {
    const released = toClaudePlanToolAnswer({ type: 'content', value: [{ type: 'text', text: 'see' }, { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: PNG_BYTES } }] } as any)
    const recorded = recordedClaudePlanToolAnswer({
      content: [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } }]
    })
    expect(sameClaudePlanToolAnswer(released, recorded)).toBe(true)
  })
})

describe('buildClaudePlanOpening', () => {
  it('joins system entries with blank lines and keeps user text', () => {
    const opening = buildClaudePlanOpening([
      { role: 'system', content: 'One.' },
      { role: 'system', content: 'Two.' },
      user({ type: 'text', text: 'Hello' })
    ])
    expect(opening.systemPrompt).toBe('One.\n\nTwo.')
    expect(opening.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('carries a PNG as an image block and a PDF as a document block', () => {
    const { content } = buildClaudePlanOpening([user(file('image/png', bytes(1, 2, 3)), file('application/pdf', 'JVBERg=='))])
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' } }
    ])
  })

  it('carries a text file as a text block', () => {
    const { content } = buildClaudePlanOpening([user({ type: 'file', mediaType: 'text/markdown', data: { type: 'text', text: '# Notes' } })])
    expect(content).toEqual([{ type: 'text', text: '# Notes' }])
  })

  it('concatenates two user messages in order', () => {
    const { content } = buildClaudePlanOpening([user({ type: 'text', text: 'first' }), user({ type: 'text', text: 'second' })])
    expect(content).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])
  })

  it('refuses an assistant message as unsupported_resume', () => {
    const prompt: LanguageModelV4Prompt = [user({ type: 'text', text: 'hi' }), { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] }]
    expect(code(() => buildClaudePlanOpening(prompt))).toBe('unsupported_resume')
  })

  it('refuses a system entry after the user turn', () => {
    const prompt: LanguageModelV4Prompt = [user({ type: 'text', text: 'hi' }), { role: 'system', content: 'late' }]
    expect(code(() => buildClaudePlanOpening(prompt))).toBe('unsupported_input')
  })

  it('refuses an attachment type it cannot carry, and a prompt with no user turn', () => {
    expect(code(() => buildClaudePlanOpening([user(file('audio/wav', bytes(1)))]))).toBe('unsupported_input')
    expect(code(() => buildClaudePlanOpening([{ role: 'system', content: 'only system' }]))).toBe('unsupported_input')
  })
})

describe('claudePlanFinishReason', () => {
  it('maps Claude stop reasons and keeps the raw one', () => {
    expect(claudePlanFinishReason('tool_use')).toEqual({ unified: 'tool-calls', raw: 'tool_use' })
    expect(claudePlanFinishReason('end_turn')).toEqual({ unified: 'stop', raw: 'end_turn' })
    expect(claudePlanFinishReason('stop_sequence')).toEqual({ unified: 'stop', raw: 'stop_sequence' })
    expect(claudePlanFinishReason('max_tokens')).toEqual({ unified: 'length', raw: 'max_tokens' })
    expect(claudePlanFinishReason('refusal')).toEqual({ unified: 'content-filter', raw: 'refusal' })
    // As the API lane's Anthropic provider reads it.
    expect(claudePlanFinishReason('model_context_window_exceeded')).toEqual({ unified: 'length', raw: 'model_context_window_exceeded' })
  })

  it('reads anything else as other', () => {
    expect(claudePlanFinishReason('pause_turn')).toEqual({ unified: 'other', raw: 'pause_turn' })
    expect(claudePlanFinishReason(undefined)).toEqual({ unified: 'other', raw: undefined })
    expect(claudePlanFinishReason(7)).toEqual({ unified: 'other', raw: undefined })
  })
})

describe('claudePlanUsage', () => {
  const start = { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 1 }

  it('totals noCache + cacheRead + cacheWrite when all three are known', () => {
    const usage = claudePlanUsage(start, { output_tokens: 42 })
    expect(usage.inputTokens).toEqual({ total: 240, noCache: 10, cacheRead: 200, cacheWrite: 30 })
    expect(usage.outputTokens.total).toBe(42)
  })

  it('leaves the total unknown, never zero, when one input count is missing', () => {
    const usage = claudePlanUsage({ input_tokens: 10, cache_read_input_tokens: 200 }, { output_tokens: 5 })
    expect(usage.inputTokens.total).toBeUndefined()
    expect(usage.inputTokens.cacheWrite).toBeUndefined()
    expect(usage.inputTokens.noCache).toBe(10)
  })

  it('takes output only from message_delta: a count seen only at message_start stays unknown', () => {
    expect(claudePlanUsage(start, { output_tokens: 42 }).outputTokens.total).toBe(42)
    const startOnly = claudePlanUsage(start, {})
    expect(startOnly.outputTokens.total).toBeUndefined()
    expect(startOnly.outputTokens.text).toBeUndefined()
    expect(startOnly.outputTokens.reasoning).toBeUndefined()
  })

  it('splits output into reasoning and text when the delta names thinking tokens', () => {
    const usage = claudePlanUsage(start, { output_tokens: 42, output_tokens_details: { thinking_tokens: 12 } })
    expect(usage.outputTokens).toEqual({ total: 42, text: 30, reasoning: 12 })
  })

  it('leaves text and reasoning unknown, not zero, without thinking_tokens', () => {
    const usage = claudePlanUsage(start, { output_tokens: 42 })
    expect(usage.outputTokens.total).toBe(42)
    expect(usage.outputTokens.text).toBeUndefined()
    expect(usage.outputTokens.reasoning).toBeUndefined()
  })

  it('reads null inputs as all unknown', () => {
    const usage = claudePlanUsage(null, null)
    expect(usage.inputTokens).toEqual({ total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined })
    expect(usage.outputTokens.total).toBeUndefined()
  })
})

describe('sameClaudePlanToolAnswer imageTypes option (Faye S8)', () => {
  it('compares recorded images by count only when imageTypes is false', () => {
    const sent = { isError: false, content: [{ type: 'image' as const, data: 'a', mimeType: 'image/png' }] }
    const resized = { isError: false, content: [{ type: 'image' as const, data: 'b', mimeType: 'image/jpeg' }] }
    expect(sameClaudePlanToolAnswer(sent, resized)).toBe(false)
    expect(sameClaudePlanToolAnswer(sent, resized, { imageTypes: false })).toBe(true)
    expect(sameClaudePlanToolAnswer(sent, { isError: false, content: [] }, { imageTypes: false })).toBe(false)
    expect(sameClaudePlanToolAnswer(sent, { isError: false, content: [{ type: 'text', text: 'x' }] }, { imageTypes: false })).toBe(false)
  })
})

describe('claudePlanResultFailure (P3, D7, Faye S2)', () => {
  const apiError = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: true, result: text, ...extra })

  it('a plan usage limit (typed) is its own failure, in Batshit\'s words, and never reads as context exhaustion', () => {
    const failure = claudePlanResultFailure(apiError('You\'ve hit your limit · resets 3pm (America/New_York)', { api_error: 'usage_limit_reached', api_error_status: 429 }))
    expect(failure.code).toBe('plan_limit')
    expect(failure.message).toMatch(/^Your Claude plan's usage limit is reached/)
    expect(failure.message).toContain('resets 3pm (America/New_York)')
    expect(isContextExhaustedStreamFailure(failure)).toBe(false)
  })

  it('an untyped 429 under a rejected rate-limit state, with no extra usage in play, is the plan limit; words that read as a context overflow are left out', () => {
    const failure = claudePlanResultFailure(apiError('Limit reached: the prompt is too long for what is left', { api_error_status: 429 }), { status: 'rejected', isUsingOverage: false })
    expect(failure.code).toBe('plan_limit')
    expect(failure.message).not.toMatch(/prompt is too long/i)
    expect(isContextExhaustedStreamFailure(failure)).toBe(false)
  })

  it('review A1, B S1: a rejected state is not the plan limit when extra usage served the request, the error is typed otherwise, or it is no 429', () => {
    // Extra usage: the pin marks a served request "rejected" with isUsingOverage true.
    expect(claudePlanResultFailure(apiError('Repeated 529 Overloaded errors', { api_error_status: 529 }), { status: 'rejected', isUsingOverage: true }).code).toBe('run_failed')
    expect(claudePlanResultFailure(apiError('Rate limited', { api_error_status: 429 }), { status: 'rejected', isUsingOverage: true }).code).toBe('run_failed')
    expect(claudePlanResultFailure(apiError('Rate limited', { api_error_status: 429 }), { status: 'rejected', overageStatus: 'allowed' }).code).toBe('run_failed')
    // A typed kind wins: 1M-context credits is a 429 of its own, with its own remedy in Claude Code's words.
    const credits = claudePlanResultFailure(apiError('API Error: Usage credits required for 1M context', { api_error_status: 429, api_error: 'long_context_credits_required' }), { status: 'rejected', isUsingOverage: false })
    expect(credits.code).toBe('run_failed')
    expect(credits.message).toContain('Usage credits required for 1M context')
    // Not a 429, or an allowed state.
    expect(claudePlanResultFailure(apiError('Credit balance is too low', { api_error_status: 400 }), { status: 'rejected', isUsingOverage: false }).code).toBe('run_failed')
    expect(claudePlanResultFailure(apiError('Rate limited', { api_error_status: 429 }), { status: 'allowed' }).code).toBe('run_failed')
    // A rejected state never turns a result that is not an error into a limit.
    expect(claudePlanResultFailure({ type: 'result', subtype: 'success', is_error: false, result: 'done', api_error_status: 429 }, { status: 'rejected' }).code).toBe('run_failed')
  })

  it('review A4: Claude Code\'s words are cut before they are classified, so what is kept is what matched', () => {
    const late = claudePlanResultFailure(apiError(`${'x'.repeat(320)} prompt is too long`))
    expect(late.code).toBe('run_failed')
    expect(isContextExhaustedStreamFailure(late)).toBe(false)
  })

  it('context exhaustion keeps Claude Code\'s words, which the API lane\'s classifier continues', () => {
    const failure = claudePlanResultFailure(apiError('Prompt is too long: 210000 tokens > 200000 maximum', { api_error_status: 400 }))
    expect(failure.code).toBe('context_exhausted')
    expect(failure.message).toContain('Prompt is too long: 210000 tokens > 200000 maximum')
    expect(isContextExhaustedStreamFailure(failure)).toBe(true)
  })

  it('any other error keeps Claude Code\'s words and never reads as context exhaustion', () => {
    const failure = claudePlanResultFailure(apiError('Credit balance is too low', { api_error_status: 400 }))
    expect(failure.code).toBe('run_failed')
    expect(failure.message).toContain('Credit balance is too low')
    expect(isContextExhaustedStreamFailure(failure)).toBe(false)
    expect(claudePlanResultFailure(apiError('')).message).toBe('Claude Code reported an error and ended the run. The reply stopped here, and nothing more ran.')
    expect(claudePlanResultFailure(apiError('x'.repeat(1000))).message.length).toBeLessThan(450)
  })

  it('each error subtype has its own named sentence; errors[] (stacks, paths) is never shown', () => {
    const errors = ['[ede_diagnostic] result_type=x', 'Error: /Users/someone/secret.ts:1 Prompt is too long']
    const seen = new Set<string>()
    for (const subtype of ['error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries', 'error_brand_new']) {
      const failure = claudePlanResultFailure({ type: 'result', subtype, is_error: true, errors })
      expect(failure.code).toBe('run_failed')
      expect(failure.message).toContain(`(${subtype})`)
      expect(failure.message).not.toMatch(/secret|ede_diagnostic|Prompt is too long/)
      expect(isContextExhaustedStreamFailure(failure)).toBe(false)
      seen.add(failure.message)
    }
    expect(seen.size).toBe(5)
  })

  it('a result that is no error, while a step is still open, still ends the run by name', () => {
    expect(claudePlanResultFailure({ type: 'result', subtype: 'success', is_error: false, result: '' }).message).toBe('Claude Code ended the run before this step finished. The reply stopped here, and nothing more ran.')
  })
})

describe('claudePlanRunHttpStatus (Faye S14)', () => {
  it('a plan limit answers 429, as the ChatGPT plan\'s limit does; other run failures keep the stream\'s own answer', () => {
    expect(claudePlanRunHttpStatus(new ClaudePlanRunError('plan_limit', 'limit'))).toBe(429)
    for (const code of ['run_failed', 'context_exhausted', 'integrity', 'run_ended'] as const) {
      expect(claudePlanRunHttpStatus(new ClaudePlanRunError(code, 'x'))).toBeNull()
    }
    expect(claudePlanRunHttpStatus(Object.assign(new Error('limit'), { code: 'plan_limit' }))).toBeNull()
  })
})
