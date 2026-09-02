import { describe, expect, it } from 'vitest'
import {
  EPHEMERAL_IMAGE_MESSAGE_MARKER,
  MAX_TOOL_RESULT_IMAGES,
  MAX_TOOL_RESULT_IMAGE_BYTES,
  admitToolResultImages,
  buildEphemeralImageMessageText,
  buildOmittedImageNote,
  buildToolResultImageContentOutput,
  buildToolResultImageDeliveryPayload,
  isSupportedToolResultImageMimeType,
  resolveToolResultImageDelivery,
  stripEphemeralImagesFromProviderMessages,
  stripMcpImageContentBlocks
} from '../toolResultImageDelivery'

/**
 * SA-105 P1. Every lane assertion below mirrors a live obedience probe run on
 * 2026-09-02, where a model was asked to name four quadrant colours
 * only the image could reveal. Where a row says `tool_result`, a real model
 * answered 4/4; where it says `synthetic_user`, a real model returned the
 * canonical "red, green, blue, yellow" guess instead.
 */
describe('resolveToolResultImageDelivery', () => {
  it('puts direct Anthropic on the native tool-result lane', () => {
    expect(resolveToolResultImageDelivery({ providerId: 'anthropic' })).toEqual({
      lane: 'tool_result',
      reason: 'provider_anthropic_native_tool_result_images'
    })
  })

  it('puts direct OpenAI on the tool-result lane, and its chat mode on the synthetic lane', () => {
    // The cleanest control in the P0 run: same model, same image, only apiMode
    // differs, and vision flips.
    expect(resolveToolResultImageDelivery({ providerId: 'openai' }).lane).toBe('tool_result')
    expect(resolveToolResultImageDelivery({ providerId: 'openai', apiMode: 'chat' }).lane).toBe(
      'synthetic_user'
    )
  })

  it('puts ANY vision-capable Gemini on the tool-result lane, not just 3-series', () => {
    // AMD-105-01: the story originally deferred pre-Gemini-3 to the text lane.
    // The legacy converter still pushes a real inlineData part, and
    // gemini-2.5-flash answered 4/4 live.
    expect(resolveToolResultImageDelivery({ providerId: 'google', modelId: 'gemini-3.5-flash' }).lane).toBe(
      'tool_result'
    )
    expect(resolveToolResultImageDelivery({ providerId: 'google', modelId: 'gemini-2.5-flash' }).lane).toBe(
      'tool_result'
    )
  })

  it('puts xAI on the tool-result lane because Batshit builds it with createXai', () => {
    // AMD-105-13. @ai-sdk/xai carries two converters; Batshit's default factory
    // is the Responses model, which maps images. Probing it through
    // createOpenAICompatible measured a path Batshit never takes.
    expect(resolveToolResultImageDelivery({ providerId: 'xai' }).lane).toBe('tool_result')
  })

  it('resolves the Vercel gateway per underlying model, never as one row', () => {
    // AMD-105-02. This is Bob's shape: a gateway-routed Qwen.
    expect(
      resolveToolResultImageDelivery({
        providerId: 'vercel-gateway',
        modelId: 'anthropic/claude-sonnet-4.5'
      }).lane
    ).toBe('tool_result')
    expect(
      resolveToolResultImageDelivery({ providerId: 'vercel-gateway', modelId: 'openai/gpt-5.5' }).lane
    ).toBe('tool_result')
    expect(
      resolveToolResultImageDelivery({
        providerId: 'vercel-gateway',
        modelId: 'alibaba/qwen3-vl-instruct'
      }).lane
    ).toBe('synthetic_user')
  })

  it('falls back to the text-safe lane for an unparseable or unknown gateway model id', () => {
    expect(
      resolveToolResultImageDelivery({ providerId: 'vercel-gateway', modelId: 'no-slash-here' })
    ).toEqual({ lane: 'synthetic_user', reason: 'gateway_model_id_unparseable' })
    expect(
      resolveToolResultImageDelivery({ providerId: 'vercel-gateway', modelId: 'brandnew/model-1' }).lane
    ).toBe('synthetic_user')
  })

  it.each([
    'togetherai',
    'fireworks',
    'deepinfra',
    'baseten',
    'cerebras',
    'groq',
    'mistral',
    'cohere',
    'deepseek',
    'alibaba',
    'qwencloud',
    'qwen_token_plan',
    'zai',
    'moonshot',
    'minimax',
    'stepfun',
    'openrouter'
  ])('puts %s on the synthetic lane', (providerId) => {
    expect(resolveToolResultImageDelivery({ providerId }).lane).toBe('synthetic_user')
  })

  it('defaults an unknown or missing provider to the text-safe lane, never tool_result', () => {
    // The failure mode of a wrong tool_result guess is not a missing image, it
    // is a megabyte of base64 in the model's text context.
    expect(resolveToolResultImageDelivery({ providerId: 'some_future_provider' }).lane).toBe(
      'synthetic_user'
    )
    expect(resolveToolResultImageDelivery({ providerId: null }).lane).toBe('synthetic_user')
    expect(resolveToolResultImageDelivery({}).lane).toBe('synthetic_user')
    expect(resolveToolResultImageDelivery({ providerId: 'custom_my_endpoint' }).lane).toBe(
      'synthetic_user'
    )
  })

  it('returns none when the model is saved as text-only', () => {
    expect(
      resolveToolResultImageDelivery({ providerId: 'anthropic', capabilities: { vision: false } as any })
    ).toEqual({ lane: 'none', reason: 'model_capabilities_vision_false' })
  })

  it('treats unknown capabilities as allowed, matching the attached-clip posture', () => {
    expect(resolveToolResultImageDelivery({ providerId: 'anthropic', capabilities: null }).lane).toBe(
      'tool_result'
    )
    expect(resolveToolResultImageDelivery({ providerId: 'anthropic', capabilities: {} as any }).lane).toBe(
      'tool_result'
    )
  })

  it('splits the two managed CLI runtimes: Codex delivers in-turn, Claude never does', () => {
    // Claude is blocked upstream, not by us — Claude Code stores MCP
    // ImageContent as text at 10-20x the token cost
    // (anthropic/claude-code#31208, closed not-planned 2026-03).
    expect(resolveToolResultImageDelivery({ providerId: 'anthropic', runtime: 'claude' })).toEqual({
      lane: 'none',
      reason: 'claude_cli_stores_mcp_images_as_text'
    })
    // Codex renders MCP image blocks (openai/codex#4819, closed by PR #5600).
    expect(resolveToolResultImageDelivery({ providerId: 'openai', runtime: 'codex' })).toEqual({
      lane: 'tool_result',
      reason: 'codex_cli_mcp_image_content'
    })
  })

  it('lets the CLI runtime decide the lane regardless of the API provider row', () => {
    // A managed CLI run has no Batshit provider preset; the runtime alone
    // decides. Proving this both ways stops a future edit from accidentally
    // making a CLI lane inherit an API provider's answer.
    expect(resolveToolResultImageDelivery({ providerId: 'alibaba', runtime: 'codex' }).lane).toBe(
      'tool_result'
    )
    expect(resolveToolResultImageDelivery({ providerId: 'anthropic', runtime: 'claude' }).lane).toBe(
      'none'
    )
    expect(resolveToolResultImageDelivery({ runtime: 'codex' }).lane).toBe('tool_result')
  })

  it('still refuses a CLI runtime when capabilities say the model is text-only', () => {
    // The capability gate runs before the runtime split, so an explicitly
    // text-only model cannot be handed images by either CLI.
    expect(
      resolveToolResultImageDelivery({
        runtime: 'codex',
        capabilities: { vision: false } as any
      })
    ).toEqual({ lane: 'none', reason: 'model_capabilities_vision_false' })
  })
})

describe('buildToolResultImageContentOutput', () => {
  it('emits the current AI SDK 7 file shape and never a deprecated shim', () => {
    const output = buildToolResultImageContentOutput({
      text: 'Here is the photo.',
      images: [{ mediaType: 'image/png', data: 'BASE64' }]
    })

    expect(output).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Here is the photo.' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'BASE64' } }
      ]
    })

    const serialized = JSON.stringify(output)
    for (const deprecated of ['image-data', 'image-url', 'image-file-id']) {
      expect(serialized).not.toContain(deprecated)
    }
  })

  it('supports URL-sourced images and carries an optional filename', () => {
    const output = buildToolResultImageContentOutput({
      text: 'Screenshot:',
      images: [{ mediaType: 'image/png', url: 'https://example.test/a.png', filename: 'a.png' }]
    })
    // The SDK's file-url variant takes a real URL instance; providers call
    // .toString() on it.
    expect(output.value[1]).toEqual({
      type: 'file',
      mediaType: 'image/png',
      filename: 'a.png',
      data: { type: 'url', url: new URL('https://example.test/a.png') }
    })
  })

  it('drops a malformed URL rather than throwing mid-send', () => {
    const output = buildToolResultImageContentOutput({
      text: 'Screenshot:',
      images: [{ mediaType: 'image/png', url: 'not a url' }]
    })
    expect(output.value).toHaveLength(1)
  })

  it('drops an image that carries neither bytes nor a URL rather than emitting a broken part', () => {
    const output = buildToolResultImageContentOutput({
      text: 'Nothing here.',
      images: [{ mediaType: 'image/png' }]
    })
    expect(output.value).toHaveLength(1)
    expect(output.value[0]).toEqual({ type: 'text', text: 'Nothing here.' })
  })
})

describe('caps and MIME gate', () => {
  it('accepts exactly the four MIME types every tool_result lane accepts', () => {
    for (const ok of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'IMAGE/PNG']) {
      expect(isSupportedToolResultImageMimeType(ok)).toBe(true)
    }
    for (const bad of ['image/svg+xml', 'image/bmp', 'application/pdf', 'text/plain', '', null]) {
      expect(isSupportedToolResultImageMimeType(bad)).toBe(false)
    }
  })

  it('defers with a specific reason rather than silently dropping', () => {
    const result = admitToolResultImages(
      [
        { id: 'ok', mediaType: 'image/png', bytes: 1024 },
        { id: 'huge', mediaType: 'image/png', bytes: MAX_TOOL_RESULT_IMAGE_BYTES + 1 },
        { id: 'pdf', mediaType: 'application/pdf', bytes: 10 }
      ],
      { lane: 'tool_result' }
    )

    expect(result.admitted.map((c) => c.id)).toEqual(['ok'])
    expect(result.deferred).toEqual([
      { candidate: expect.objectContaining({ id: 'huge' }), reason: 'over_size' },
      { candidate: expect.objectContaining({ id: 'pdf' }), reason: 'unsupported_mime' }
    ])
  })

  it('caps the in-turn image count and reports the overflow', () => {
    const many = Array.from({ length: MAX_TOOL_RESULT_IMAGES + 2 }, (_, i) => ({
      id: `img_${i}`,
      mediaType: 'image/png',
      bytes: 10
    }))
    const result = admitToolResultImages(many, { lane: 'tool_result' })
    expect(result.admitted).toHaveLength(MAX_TOOL_RESULT_IMAGES)
    expect(result.deferred).toHaveLength(2)
    expect(result.deferred.every((d) => d.reason === 'over_count')).toBe(true)
  })

  it('defers everything with lane_none when the model cannot take images', () => {
    const result = admitToolResultImages([{ id: 'a', mediaType: 'image/png', bytes: 10 }], {
      lane: 'none'
    })
    expect(result.admitted).toHaveLength(0)
    expect(result.deferred[0]?.reason).toBe('lane_none')
  })

  it('admits an image whose size is unknown rather than guessing it is too large', () => {
    const result = admitToolResultImages([{ id: 'a', mediaType: 'image/png', bytes: null }], {
      lane: 'tool_result'
    })
    expect(result.admitted).toHaveLength(1)
  })
})

describe('stripMcpImageContentBlocks', () => {
  it('replaces MCP image blocks with the same neutral note the API lanes use', () => {
    const stripped = stripMcpImageContentBlocks({
      content: [
        { type: 'text', text: '{"recalled":[]}' },
        { type: 'image', data: 'BASE64BYTES', mimeType: 'image/png' }
      ]
    })

    expect(stripped.content).toEqual([
      { type: 'text', text: '{"recalled":[]}' },
      { type: 'text', text: buildOmittedImageNote('in-turn image') }
    ])
    expect(JSON.stringify(stripped)).not.toContain('BASE64BYTES')
  })

  it('leaves a result with no image blocks byte-identical', () => {
    const result = { content: [{ type: 'text', text: 'hello' }] }
    expect(stripMcpImageContentBlocks(result)).toBe(result)

    const noContent = { output: 'plain' }
    expect(stripMcpImageContentBlocks(noContent)).toBe(noContent)
    expect(stripMcpImageContentBlocks(null)).toBeNull()
    expect(stripMcpImageContentBlocks('text')).toBe('text')
  })

  it('does not mutate the object it was handed', () => {
    const result = {
      content: [{ type: 'image', data: 'BASE64BYTES', mimeType: 'image/png' }]
    }
    stripMcpImageContentBlocks(result)
    expect(result.content[0]).toEqual({ type: 'image', data: 'BASE64BYTES', mimeType: 'image/png' })
  })

  it('stays narrow: a resource block carrying a blob is left alone', () => {
    // Nothing in Batshit emits one, and widening on speculation risks eating a
    // legitimate result.
    const result = {
      content: [{ type: 'resource', resource: { uri: 'file://x.png', blob: 'BASE64BYTES' } }]
    }
    expect(stripMcpImageContentBlocks(result)).toBe(result)
  })
})

describe('stripEphemeralImagesFromProviderMessages', () => {
  const imageFilePart = { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'BASE64' } }

  it('strips a tool-result image no matter which tool produced it', () => {
    // AMD-105-04: the old strip keyed on two Agent Browser tool names, so a
    // memory recall arriving as batshit_tool_use would never have matched.
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'batshit_tool_use',
            output: { type: 'content', value: [{ type: 'text', text: 'ok' }, imageFilePart] }
          }
        ]
      }
    ]

    const [sanitized] = stripEphemeralImagesFromProviderMessages(messages as any)
    expect((sanitized as any).content[0].output).toEqual({
      type: 'text',
      value: '[Image omitted from persisted provider context after this loop: in-turn image]'
    })
    expect(JSON.stringify(sanitized)).not.toContain('BASE64')
  })

  it('still strips the deprecated shim shapes an unmigrated caller could emit', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'native_bash_execute',
            output: { type: 'content', value: [{ type: 'image-data', data: 'BASE64', mediaType: 'image/png' }] }
          }
        ]
      }
    ]
    expect(JSON.stringify(stripEphemeralImagesFromProviderMessages(messages as any))).not.toContain('BASE64')
  })

  it('strips images from the synthetic user message on text-only lanes', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildEphemeralImageMessageText('sys.memory.recall', 'recalled media') },
          imageFilePart
        ]
      }
    ]

    const [sanitized] = stripEphemeralImagesFromProviderMessages(messages as any)
    const content = (sanitized as any).content
    expect(content.some((p: any) => p.type === 'file')).toBe(false)
    expect(content.at(-1).text).toContain('Image omitted from persisted provider context')
    expect(JSON.stringify(sanitized)).not.toContain('BASE64')
  })

  it('leaves an ordinary user image message alone', () => {
    // An attached clip is persisted context by design; only marked ephemeral
    // deliveries are stripped.
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'look at this' }, imageFilePart] }]
    const result = stripEphemeralImagesFromProviderMessages(messages as any)
    expect(result).toBe(messages)
    expect(JSON.stringify(result)).toContain('BASE64')
  })

  it('returns the original array identity when nothing needed stripping', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolName: 'native_bash_execute', output: { type: 'text', value: 'ok' } }
        ]
      }
    ]
    expect(stripEphemeralImagesFromProviderMessages(messages as any)).toBe(messages)
  })

  it('does not mutate the messages it was given', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'batshit_tool_use',
            output: { type: 'content', value: [imageFilePart] }
          }
        ]
      }
    ]
    const before = JSON.stringify(messages)
    stripEphemeralImagesFromProviderMessages(messages as any)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('tolerates malformed messages without throwing', () => {
    const messages = [null, undefined, 'text-content', { role: 'user', content: 'plain string' }]
    expect(() => stripEphemeralImagesFromProviderMessages(messages as any)).not.toThrow()
  })
})

describe('neutral delivery vocabulary', () => {
  it('marks in-turn deliveries model-visible and never retained in history', () => {
    // Agent Browser used to own these words. The helper owns them now, so
    // removing Agent Browser cannot take the vocabulary with it (AMD-105-14).
    expect(
      buildToolResultImageDeliveryPayload({ lane: 'tool_result', reason: 'provider_anthropic_native_tool_result_images' })
    ).toEqual({
      modelVisibleInLoop: true,
      historyRetention: 'none',
      lane: 'tool_result',
      reason: 'provider_anthropic_native_tool_result_images'
    })
  })

  it('marks a none lane as not model-visible', () => {
    const payload = buildToolResultImageDeliveryPayload({
      lane: 'none',
      reason: 'model_capabilities_vision_false'
    })
    expect(payload.modelVisibleInLoop).toBe(false)
    expect(payload.historyRetention).toBe('none')
  })

  it('names the source in the ephemeral message text and carries the marker', () => {
    const text = buildEphemeralImageMessageText('sys.memory.recall', 'recalled memory media')
    expect(text).toContain(EPHEMERAL_IMAGE_MESSAGE_MARKER)
    expect(text).toContain('sys.memory.recall')
    expect(text).toContain('recalled memory media')
  })
})
