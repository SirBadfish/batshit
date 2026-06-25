import { describe, it, expect } from 'vitest'
import {
  StreamEventAdapter,
  type CanonicalStreamEvent
} from '../streamEventAdapter'

describe('StreamEventAdapter', () => {
  it('merges voice metadata into start and end events', async () => {
    const emitted: CanonicalStreamEvent[] = []

    const adapter = new StreamEventAdapter({
      sessionId: 'session-1',
      forward: (event) => {
        emitted.push(event)
      }
    })

    adapter.setVoiceMetadata({
      tts: true,
      stt: false,
      voiceMode: 'voice'
    })

    await adapter.emitStart({ messageId: 'msg-1' })
    await adapter.emitChunk({ content: 'Hello' })
    await adapter.emitEnd({ content: 'Hello world' })

    expect(emitted).toHaveLength(3)
    const startEvent = emitted[0]
    const endEvent = emitted[2]

    expect(startEvent.metadata?.voice?.tts).toBe(true)
    expect(startEvent.metadata?.voiceMode).toBe('voice')
    expect(endEvent.metadata?.voice?.tts).toBe(true)
    expect(endEvent.metadata?.voiceMode).toBe('voice')
  })

  it('reuses tool identifiers when metadata is missing', async () => {
    const emitted: CanonicalStreamEvent[] = []

    const adapter = new StreamEventAdapter({
      sessionId: 'session-2',
      forward: (event) => emitted.push(event)
    })

    adapter.setMessageId('msg-2')

    await adapter.emitToolStart({ toolCallId: 'tool-001', toolName: 'demo-tool' })
    await adapter.emitToolCall({
      toolCallId: 'tool-001',
      toolName: 'demo-tool',
      args: { foo: 'bar' }
    })
    await adapter.emitToolResult({
      toolCallId: 'tool-001',
      toolName: 'demo-tool',
      result: { ok: true }
    })
    await adapter.emitToolEnd({ toolCallId: 'tool-001' })

    const [start, call, result, end] = emitted
    expect(start.toolCallId).toBeDefined()
    expect(call.toolCallId).toBe(start.toolCallId)
    expect(result.toolCallId).toBe(start.toolCallId)
    expect(end.toolCallId).toBe(start.toolCallId)
    expect(call.placeholderId).toBe(start.placeholderId)
    expect(result.placeholderId).toBe(start.placeholderId)
  })

  it('emits thinking events with merged metadata', async () => {
    const events: CanonicalStreamEvent[] = []

    const adapter = new StreamEventAdapter({
      sessionId: 'sess-thinking',
      forward: (event) => events.push(event)
    })

    adapter.setVoiceMetadata({ voiceMode: 'text' })

    await adapter.emitThinking({
      content: 'Reasoning chunk',
      metadata: { provider: 'codex' }
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'thinking',
      content: 'Reasoning chunk'
    })
    expect(events[0].metadata?.provider).toBe('codex')
    expect(events[0].metadata?.voice?.voiceMode).toBe('text')
  })

  it('emits tool approval request events for live approval UI', async () => {
    const events: CanonicalStreamEvent[] = []

    const adapter = new StreamEventAdapter({
      sessionId: 'sess-approvals',
      forward: (event) => events.push(event)
    })
    adapter.setMessageId('msg-approvals')

    await adapter.emitToolApprovalRequest({
      approvalId: 'approval-123',
      toolCallId: 'call-123',
      toolName: 'native_bash_execute',
      input: { command: 'npm run build' },
      source: 'vercel'
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_approval_request',
      approvalId: 'approval-123',
      toolCallId: 'call-123',
      toolName: 'native_bash_execute',
      source: 'vercel'
    })
    expect(events[0].input).toEqual({ command: 'npm run build' })
  })
})
