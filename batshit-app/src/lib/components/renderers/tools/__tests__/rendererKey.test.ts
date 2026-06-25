import { describe, it, expect } from 'vitest'
import { buildRendererKey } from '../rendererKey'

describe('buildRendererKey', () => {
  it('uses toolCallId when present', () => {
    const key = buildRendererKey({
      intermediateStep: { toolCallId: 'call_123', error: false },
      toolName: 'batshit_server_read_file'
    })
    expect(key).toBe('ok|call_123||')
  })

  it('falls back to toolId then toolName', () => {
    const key = buildRendererKey({ toolId: 'abc', toolName: 'my_tool' })
    expect(key).toBe('ok|abc||')

    const key2 = buildRendererKey({ toolName: 'my_tool' })
    expect(key2).toBe('ok|my_tool||')
  })

  it('marks pending status', () => {
    const key = buildRendererKey({ isPending: true, toolName: 'pending_tool' })
    expect(key).toBe('pending|pending_tool||')
  })

  it('marks error status', () => {
    const key = buildRendererKey({ intermediateStep: { id: 'step1', error: 'boom' }, toolName: 't' })
    expect(key).toBe('error|step1||')
  })

  it('is stable for same inputs', () => {
    const input = { intermediateStep: { toolCallId: 'call_same' }, toolName: 'same' }
    const k1 = buildRendererKey(input)
    const k2 = buildRendererKey({ ...input, intermediateStep: { toolCallId: 'call_same' } })
    expect(k1).toBe(k2)
  })
})
