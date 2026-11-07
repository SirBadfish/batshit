import { describe, expect, it, vi } from 'vitest'

vi.mock('../redis', () => ({
  redis: {
    execute: vi.fn()
  }
}))

vi.mock('../redisStreamService', () => ({
  redisStreamService: {
    completeZipBlock: vi.fn(),
    cleanupSessionTempStorage: vi.fn(),
    getActiveZipBlocks: vi.fn()
  }
}))

import { createPermanentZip, createZipFromContent, generateZipDescription } from '../zipService'
import { redis } from '../redis'
import { redisStreamService } from '../redisStreamService'

/**
 * Review of BL-1798 (N1): a zip writer stamps the chat and the reply it writes for AFTER the
 * caller's metadata, so the record always names the chat whose set lists it: the chat delete
 * trusts that pair. Spread last, a caller's `sessionId` named another chat.
 */
describe('zipService stamps the chat it writes for (BL-1798)', () => {
  it('names the chat and reply it writes for over any caller metadata, and lists the zip in that chat', async () => {
    const records: any[] = []
    const listed: string[] = []
    vi.mocked(redis.execute).mockImplementation((async (operation: (client: any) => Promise<unknown>) =>
      operation({
        json: { set: vi.fn(async (_key: string, _path: string, value: unknown) => { records.push(value) }) },
        sAdd: vi.fn(async (key: string) => { listed.push(key) })
      })) as never)
    vi.mocked(redisStreamService.completeZipBlock).mockResolvedValue('block content')
    const caller = { sessionId: 'chat-b', messageId: 'msg-b', toolName: 'read', originalChunkCount: 9 }

    await createZipFromContent('tool output', 'cool_tool', 'chat-a', 'msg-a', caller)
    await createPermanentZip('chat-a', 'msg-a', 'code', 0, caller)

    expect(records.map((record) => [record.metadata.sessionId, record.metadata.messageId])).toEqual([
      ['chat-a', 'msg-a'],
      ['chat-a', 'msg-a']
    ])
    expect(listed).toEqual(['session:chat-a:zips', 'session:chat-a:zips'])
    // The rest of the caller's metadata is kept as it was, a chunk count it names included.
    expect(records.map((record) => record.metadata.toolName)).toEqual(['read', 'read'])
    expect(records[1].metadata.originalChunkCount).toBe(9)
  })
})

describe('zipService generateZipDescription', () => {
  it('builds compact target-first descriptions for cool_tool zips', () => {
    const description = generateZipDescription('{"type":"tool"}', 'cool_tool', {
      operationKind: 'read_file',
      projectPath: '/Users/example/batshit',
      zipDescriptionTarget: '/Users/example/batshit/docs/user-docs/index.md',
      zipDescriptionSize: '43 lines'
    })

    expect(description).toBe('read_file: docs/user-docs/index.md - 43 lines')
  })

  it('sanitizes, redacts, and truncates command-style description targets', () => {
    const description = generateZipDescription('{"type":"tool"}', 'cool_tool', {
      operationKind: 'bash',
      zipDescriptionTarget:
        'npm run check -- --token=sample-token-value SECRET_KEY=very-secret-value && echo {done}\n' +
        '&& printf "this command is deliberately long so the zip marker stays compact"',
      zipDescriptionStatus: 'exit 0',
      zipDescriptionSize: '214 lines'
    })

    expect(description).toContain('bash:')
    expect(description).toContain('exit 0')
    expect(description).toContain('214 lines')
    expect(description).toContain('--token=[redacted]')
    expect(description).toContain('SECRET_KEY=[redacted]')
    expect(description).not.toContain('sample-token-value')
    expect(description).not.toContain('very-secret-value')
    expect(description).not.toContain('\n')
    expect(description).not.toContain('{')
    expect(description).not.toContain('}')
    expect(description.length).toBeLessThanOrEqual(150)
  })
})
