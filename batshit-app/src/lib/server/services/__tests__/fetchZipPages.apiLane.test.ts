import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createZipFromContent } from '$lib/server/zipService'
import { TOOL_MODEL_TEXT_MAX_CHARS } from '$lib/utils/toolModelTextSizeGuard'
import { nativeToolService } from '../nativeTools'
import { VercelAIBrain } from '../vercelBrain'

// Count every cut the API wrapper asks for, while the real guard still runs.
const guardCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../toolModelResultGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../toolModelResultGuard')>()
  return {
    ...actual,
    guardToolModelText: vi.fn(async (...args: Parameters<typeof actual.guardToolModelText>) => {
      guardCalls.count += 1
      return actual.guardToolModelText(...args)
    })
  }
})

useRedisTestServer()

// The in-memory lane has no Lua; the fake stands in for the kept copy's atomic publish.
beforeEach(() => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') vi.stubEnv('VITEST_FAKE_RETAINED_OUTPUT_EVAL', 'true')
})
afterEach(() => vi.unstubAllEnvs())

/** Text that grows when escaped, with pairs, CJK, and control characters on every line. */
function escapeHeavySource(length: number): string {
  const units = [
    'plain line of text\n',
    'say "quoted" \\ back\n',
    '漢字かな混じり文\n',
    '😀🎉 pair\n',
    `${String.fromCharCode(1)}${String.fromCharCode(31)}\tcontrol\n`
  ]
  let text = ''
  for (let index = 0; text.length < length; index += 1) text += `${units[index % units.length]}${index}\n`
  return text.slice(0, length)
}

describe('BL-676: the API lane reads a large kept copy page by page', () => {
  it('sees every character once, in order, and the size guard never cuts a Fetch Zip page', async () => {
    const owner = {
      userId: 'bl676-user',
      sessionId: `bl676-chat-${Date.now()}`,
      messageId: 'bl676-reply',
      agentId: 'bl676-agent'
    }
    await redis.createSession({
      id: owner.sessionId, user_id: owner.userId, agent_id: owner.agentId, title: 'BL-676'
    } as any)
    const source = escapeHeavySource(400_000)
    // The shape the guard keeps: a hidden raw copy owned by this chat.
    const { zipId } = await createZipFromContent(source, 'tool_raw', owner.sessionId, 'earlier-reply', {
      userId: owner.userId, agentId: owner.agentId, retainedForSizeGuard: true
    }, { indexedRetention: true })

    const { tools, fetchZipAvailable } = await nativeToolService.buildMode3NativeTools({
      userId: owner.userId,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      messageId: owner.messageId,
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: true,
          dynamicMcpEnabled: false,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: true,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)
    expect(fetchZipAvailable).toBe(true)
    // The real API lane: the broker's own model text, then the wrapper's size guard.
    const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput(tools, {
      ...owner, fetchZipAllowed: true
    })
    const brokerUse = wrapped.native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    guardCalls.count = 0
    let offset = 0
    let seen = ''
    let pages = 0
    while (pages < 20) {
      const input = { ref: 'fabric:sys.zip.fetch', input: { zipId, offset, maxChars: 250_000 } }
      const output = await brokerUse.execute(input, { toolCallId: `bl676-${pages}`, messages: [] })
      const model = await brokerUse.toModelOutput({ toolCallId: `bl676-${pages}`, input, output })
      pages += 1
      expect(model.type).toBe('text')
      const text = String(model.value)
      expect(text.length).toBeLessThanOrEqual(TOOL_MODEL_TEXT_MAX_CHARS)
      expect(text).not.toContain('Output cut here by Batshit')
      expect(text).toContain(`offset: ${offset}`)
      const marker = '\n\ncontent:\n'
      expect(text.indexOf(marker)).toBeGreaterThan(0)
      const content = text.slice(text.indexOf(marker) + marker.length)
      expect(content.length).toBeGreaterThan(0)
      expect(content).toBe(source.slice(offset, offset + content.length))
      seen += content
      const next = text.match(/^next_offset: (\d+)$/m)
      if (!next) break
      expect(Number(next[1])).toBe(offset + content.length)
      offset = Number(next[1])
    }
    expect(guardCalls.count).toBe(0)
    expect(pages).toBeGreaterThan(4)
    expect(seen).toBe(source)
  }, 60_000)
})
