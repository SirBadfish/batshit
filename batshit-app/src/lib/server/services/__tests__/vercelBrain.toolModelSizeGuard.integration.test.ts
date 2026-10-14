import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { VercelAIBrain } from '../vercelBrain'
import { fetchZipForModel } from '../fetchZipForModel'
import { adaptCoolToolsToZipSystem } from '$lib/server/coolToolZipAdapter'
import { compileForAI } from '$lib/services/messageCompiler'
import { createZipStateView } from '$lib/services/zipping'

useRedisTestServer()

beforeEach(() => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') vi.stubEnv('VITEST_FAKE_RETAINED_OUTPUT_EVAL', 'true')
})
afterEach(() => vi.unstubAllEnvs())

describe('API tool output through retention, Fetch Zip, card storage, and next-turn compile', () => {
  it('cuts only the model view of a 120k-character read while preserving its raw and card paths', async () => {
    const owner = {
      userId: 'api-cut-user',
      sessionId: `api-cut-session-${Date.now()}`,
      messageId: 'api-cut-reply',
      agentId: 'api-cut-agent',
      fetchZipAllowed: true
    }
    await redis.createSession({ id: owner.sessionId, user_id: owner.userId, agent_id: owner.agentId, title: 'Cut proof' } as any)

    const fullContent = `BEGIN-API-CARD\n${'x'.repeat(119_970)}\nEND-API-CARD`
    const rawResult = { filePath: 'src/huge.txt', content: fullContent, lineCount: 2 }
    const modelText = JSON.stringify(rawResult, null, 2)
    const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput({
      read_file: { execute: async () => rawResult }
    }, owner)
    const executeResult = await wrapped.read_file.execute({ filePath: 'src/huge.txt' })
    const modelOutput = await wrapped.read_file.toModelOutput({
      toolCallId: 'call-api-cut', input: { filePath: 'src/huge.txt' }, output: executeResult
    })
    expect(executeResult).toBe(rawResult)
    expect(executeResult.content).toBe(fullContent)
    expect(modelOutput.type).toBe('text')
    expect(modelOutput.value.length).toBeLessThanOrEqual(100_000)
    expect(modelOutput.value).toContain('Output cut here by Batshit')
    const rawZipId = modelOutput.value.match(/Call Fetch Zip with zipId ([^ ]+) and offset (\d+)/)?.[1]
    const offsetText = modelOutput.value.match(/Call Fetch Zip with zipId ([^ ]+) and offset (\d+)/)?.[2]
    expect(rawZipId).toBeTruthy()
    const offset = Number(offsetText)
    expect((await redis.getZip(rawZipId!))?.content).toBe(modelText)

    const nextPage = await fetchZipForModel(owner, { zipId: rawZipId!, offset, maxChars: 16_000 })
    expect(nextPage.found).toBe(true)
    expect(nextPage.content).toBe(modelText.slice(offset, offset + 16_000))
    expect(nextPage.nextOffset).toBe(offset + 16_000)

    // The SDK keeps the tool's execute output for the browser card; its model view is separate.
    const step = {
      toolName: 'read_file', toolInput: { filePath: 'src/huge.txt' }, toolResult: executeResult,
      toolCallId: 'call-api-cut', timestamp: new Date().toISOString()
    }
    const [card] = await adaptCoolToolsToZipSystem([step], owner.sessionId, owner.messageId, {
      buffer_size_read_file: 0, zip_threshold_read_file: 0
    } as any)
    expect(card?.zipId).toBeTruthy()
    expect(step.toolResult.content).toBe(fullContent)
    const cardZip = await redis.getZip(card.zipId!)
    expect(cardZip?.type).toBe('cool_tool')
    expect(cardZip?.metadata?.promptTokens).toBeGreaterThanOrEqual(25_000)
    const cardPayload = JSON.parse(cardZip.content)
    const cardSource = cardPayload.rawSidecar?.zipId
      ? JSON.parse((await redis.getZip(cardPayload.rawSidecar.zipId))?.content ?? '{}')
      : cardPayload
    expect(cardSource.toolResult.content).toBe(fullContent)
    const compiled = await compileForAI(card.reference, 0, 2, { id: owner.agentId }, {
      role: 'assistant', agent_id: owner.agentId, metadata: { zipIds: [card.zipId] }
    }, undefined, {
      zipResolver: (id) => redis.getZip(id),
      zipState: createZipStateView([]),
      agentMessagesFromEnd: 1
    })
    expect(compiled).toContain('too large to open: fetch it in parts')
    expect(compiled).not.toContain('BEGIN-API-CARD')
  })
})
