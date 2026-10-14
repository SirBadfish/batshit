import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../../../routes/api/native-tools/guard-result/+server'
import { resolveNativeToolUser } from '../nativeToolAuth'
import { guardToolModelText } from '../toolModelResultGuard'
vi.mock('../nativeToolAuth', () => ({ resolveNativeToolUser: vi.fn() }))
vi.mock('../toolModelResultGuard', () => ({ guardToolModelText: vi.fn() }))
const auth = { auth: 'agent' as const, userId: 'owner', sessionId: 'chat', messageId: 'reply', agentId: 'actor', fetchZipAllowed: false }
const call = (body: unknown) => POST({ request: new Request('http://app.test/api/native-tools/guard-result', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}) } as any)
beforeEach(() => {
  vi.mocked(resolveNativeToolUser).mockResolvedValue(auth)
  vi.mocked(guardToolModelText).mockReset().mockResolvedValue('shortened')
})
describe('credential-bound final text guard', () => {
  it('takes the output limit only from the credential and ignores a forged memory exemption', async () => {
    vi.mocked(resolveNativeToolUser).mockResolvedValue({
      ...auth, runtime: 'codex', codexToolOutputTokenLimit: 2_000
    })
    const response = await call({
      text: 'output', originalTextChars: 6, toolName: 'sys.memory.search', memoryResult: true,
      runtime: 'claude', codexToolOutputTokenLimit: 75_000,
      modelTextBudget: { maxUtf8Bytes: 300_000 }
    })
    expect(response.status).toBe(200)
    expect(guardToolModelText).toHaveBeenCalledWith('output', {
      userId: 'owner', sessionId: 'chat', messageId: 'reply', agentId: 'actor', fetchZipAllowed: false,
      toolName: 'sys.memory.search', originalTextChars: 6,
      modelTextBudget: { maxUtf8Bytes: 8_000, source: 'codex-profile' }
    })
  })
  it('ignores forged owner, message, raw id and tool scope fields', async () => {
    const response = await call({ text: 'output', toolName: 'label only', userId: 'other', sessionId: 'other',
      messageId: 'other', agentId: 'other', zipId: 'invented', fetchZipAllowed: true, originalTextChars: 12 })
    expect(response.status).toBe(200)
    expect(guardToolModelText).toHaveBeenCalledWith('output', {
      userId: 'owner', sessionId: 'chat', messageId: 'reply', agentId: 'actor', fetchZipAllowed: false,
      toolName: 'label only', originalTextChars: 12
    })
  })
  it.each([
    { text: 'output' },
    { text: 'output', originalTextChars: 5 },
    { text: 'output', originalTextChars: '6' },
    { text: 'output', originalTextChars: 6.5 }
  ])('rejects missing or dishonest original length before retention', async (body) => {
    expect((await call(body)).status).toBe(400)
    expect(guardToolModelText).not.toHaveBeenCalled()
  })
  it('rejects decoded text over 8M characters despite a small declared Content-Length', async () => {
    const request = new Request('http://app.test/api/native-tools/guard-result', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
      body: JSON.stringify({ text: 'x'.repeat(8_000_001), originalTextChars: 8_000_001 })
    })
    expect((await POST({ request } as any)).status).toBe(413)
    expect(guardToolModelText).not.toHaveBeenCalled()
  })
  it('stops reading a JSON body beyond the byte budget even when Content-Length lies', async () => {
    const chunk = new Uint8Array(1_000_000).fill(32)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
        sent += 1
        if (sent === 60) controller.close()
      }
    })
    const request = new Request('http://app.test/api/native-tools/guard-result', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
      body, duplex: 'half'
    } as any)
    expect((await POST({ request } as any)).status).toBe(413)
    expect(sent).toBeLessThan(60)
    expect(guardToolModelText).not.toHaveBeenCalled()
  })
  it('rejects a declared over-budget body before reading its stream', async () => {
    const getReader = vi.fn()
    const request = { headers: new Headers({ 'Content-Length': '48004097' }), body: { getReader } } as unknown as Request
    expect((await POST({ request } as any)).status).toBe(413)
    expect(getReader).not.toHaveBeenCalled()
    expect(guardToolModelText).not.toHaveBeenCalled()
  })
  it.each(['session', 'service', 'portable-skill', 'n8n-callback'])('rejects %s authentication', async (lane) => {
    vi.mocked(resolveNativeToolUser).mockResolvedValue({ ...auth, auth: lane } as any)
    expect((await call({ text: 'x'.repeat(100_000) })).status).toBe(403)
    expect(guardToolModelText).not.toHaveBeenCalled()
  })
  it('rejects a credential without a vouched reply even when the caller supplies one', async () => {
    vi.mocked(resolveNativeToolUser).mockResolvedValue({ ...auth, messageId: undefined })
    expect((await call({ text: 'output', messageId: 'forged' })).status).toBe(403)
  })
})
