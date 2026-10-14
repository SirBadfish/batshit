import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VercelAIBrain } from '../vercelBrain'
import { attachCommandModelCapture } from '../commandModelCapture'
import { guardToolModelText } from '../toolModelResultGuard'

vi.mock('../toolModelResultGuard', () => ({
  guardToolModelText: vi.fn(async () => '[cut with saved zip]')
}))

const context = {
  userId: 'user-1',
  sessionId: 'chat-1',
  messageId: 'reply-1',
  agentId: 'agent-1'
}

function wrap(tools: Record<string, any>, owner = context): Record<string, any> {
  return (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput(tools, owner)
}

describe('API model-facing tool result guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('leaves short default JSON and the raw execute result unchanged', async () => {
    const raw = { success: true, lines: ['one', 'two'] }
    const wrapped = wrap({ example: { execute: async () => raw } })
    const model = await wrapped.example.toModelOutput({
      toolCallId: 'call-1', input: {}, output: raw
    })
    expect(model).toEqual({ type: 'text', value: JSON.stringify(raw, null, 2) })
    expect(raw).toEqual({ success: true, lines: ['one', 'two'] })
    expect(guardToolModelText).not.toHaveBeenCalled()
  })

  it('guards the final custom text after its async conversion with the owning reply', async () => {
    const raw = { payload: 'raw card data' }
    const converted = 'x'.repeat(100_000)
    const custom = vi.fn(async () => ({ type: 'text', value: converted }))
    const wrapped = wrap({ example: { execute: async () => raw, toModelOutput: custom } })
    const model = await wrapped.example.toModelOutput({
      toolCallId: 'call-2', input: {}, output: raw
    })
    expect(custom).toHaveBeenCalledWith({ toolCallId: 'call-2', input: {}, output: raw })
    expect(guardToolModelText).toHaveBeenCalledWith(converted, { ...context, toolName: 'example' })
    expect(model).toEqual({ type: 'text', value: '[cut with saved zip]' })
    expect(raw).toEqual({ payload: 'raw card data' })
  })

  it('classifies only the server-owned native Fabric memory result as no-retention', async () => {
    const text = 'memory'.repeat(20_000)
    for (const [name, output, isMemory] of [
      ['native_batshit_tool_use', { family: 'fabric', target: 'sys.memory.search' }, true],
      ['external_mcp', { family: 'fabric', target: 'sys.memory.search' }, false],
      ['native_batshit_tool_use', { family: 'mcp', target: 'sys.memory.search' }, false],
      ['native_batshit_tool_use', { family: 'fabric', target: 'sys.dm.read' }, false]
    ] as const) {
      vi.clearAllMocks()
      const wrapped = wrap({ [name]: { toModelOutput: () => ({ type: 'text', value: text }) } })
      await wrapped[name].toModelOutput({ toolCallId: 'memory', input: {}, output })
      expect(guardToolModelText).toHaveBeenCalledWith(text, {
        ...context, toolName: name, ...(isMemory ? { memoryResult: true } : {})
      })
    }
  })

  it('guards returned error text while keeping its error type and options', async () => {
    const providerOptions = { test: { marker: true } }
    const wrapped = wrap({ example: {
      toModelOutput: () => ({ type: 'error-text', value: 'e'.repeat(100_000), providerOptions })
    } })
    const model = await wrapped.example.toModelOutput({ toolCallId: 'call-3', input: {}, output: null })
    expect(model).toEqual({ type: 'error-text', value: '[cut with saved zip]', providerOptions })
  })

  it('guards aggregate content text without serializing or dropping media', async () => {
    const image = { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'base64' } }
    const fileText = { type: 'file', mediaType: 'text/plain', data: { type: 'text', text: 'b'.repeat(50_000) } }
    const wrapped = wrap({ example: {
      toModelOutput: () => ({
        type: 'content',
        providerOptions: { test: { flag: true } },
        value: [{ type: 'text', text: 'a'.repeat(50_000) }, image, fileText]
      })
    } })
    const model = await wrapped.example.toModelOutput({ toolCallId: 'call-4', input: {}, output: null })
    expect(guardToolModelText).toHaveBeenCalledWith(
      `${'a'.repeat(50_000)}\n${'b'.repeat(50_000)}`,
      { ...context, toolName: 'example' }
    )
    expect(model).toEqual({
      type: 'content',
      providerOptions: { test: { flag: true } },
      value: [{ type: 'text', text: '[cut with saved zip]' }, image]
    })
  })

  it('uses private command text beyond card limits and preserves failure/media semantics', async () => {
    const capture = { text: 'raw'.repeat(100_000), originalTextChars: 300_000 }
    const output = attachCommandModelCapture({ success: false, stdout: 'visible prefix' }, capture)
    const image = { type: 'file-data', mediaType: 'image/png', data: 'base64' }
    const custom = vi.fn(async () => ({ type: 'content', value: [{ type: 'text', text: 'visible prefix' }, image] }))
    const tool = wrap({ command: { toModelOutput: custom } }).command
    const result = await tool.toModelOutput({ toolCallId: 'capture', input: {}, output: { data: output } })
    expect(custom).toHaveBeenCalledOnce()
    expect(guardToolModelText).toHaveBeenCalledWith(capture.text, {
      ...context, toolName: 'command', originalTextChars: capture.originalTextChars
    })
    expect(result).toEqual({ type: 'content', value: [{ type: 'text', text: '[cut with saved zip]' }, image] })
    expect(JSON.stringify(output)).toBe('{"success":false,"stdout":"visible prefix"}')
    const providerOptions = { test: { marker: true } }
    const error = wrap({ command: { toModelOutput: () => ({ type: 'error-text', value: 'failed', providerOptions }) } }).command
    expect(await error.toModelOutput({ toolCallId: 'error', input: {}, output })).toEqual({
      type: 'error-text', value: '[cut with saved zip]', providerOptions
    })
  })

  it('preserves a short mixed content result and propagates retention failure', async () => {
    const image = { type: 'file-data', mediaType: 'image/png', data: 'base64' }
    const small = { type: 'content', value: [{ type: 'text', text: 'hello' }, image] }
    const short = wrap({ example: { toModelOutput: () => small } })
    expect(await short.example.toModelOutput({ toolCallId: 'short', input: {}, output: null })).toBe(small)

    vi.mocked(guardToolModelText).mockRejectedValueOnce(new Error('raw zip unavailable'))
    const large = wrap({ example: { toModelOutput: () => ({ type: 'text', value: 'x'.repeat(100_000) }) } })
    await expect(large.example.toModelOutput({ toolCallId: 'large', input: {}, output: null }))
      .rejects.toThrow('raw zip unavailable')
  })
})
