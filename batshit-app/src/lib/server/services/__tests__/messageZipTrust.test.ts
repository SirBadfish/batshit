import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMemoryRow } from '$lib/types/database'

const mockRedis = {
  getZips: vi.fn()
}

vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))

function buildMessage(overrides: Partial<ChatMemoryRow> = {}): ChatMemoryRow {
  return {
    id: 'message-1',
    session_id: 'session-1',
    user_id: 'user-1',
    role: 'assistant',
    content: '',
    created_at: '2026-05-24T00:00:00.000Z',
    ...overrides
  }
}

describe('enrichMessagesWithTrustedZipMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis.getZips.mockResolvedValue(new Map())
  })

  it('adds trusted zip metadata for existing zips in the same session', async () => {
    const zipId = 'cool_tool_1779584791784_nq20s'
    mockRedis.getZips.mockResolvedValue(
      new Map([
        [
          zipId,
          {
            metadata: {
              sessionId: 'session-1',
              toolName: 'batshit_server_dynamic_mcp_find'
            }
          }
        ]
      ])
    )

    const { enrichMessagesWithTrustedZipMetadata } = await import('../messageZipTrust')
    const [message] = await enrichMessagesWithTrustedZipMetadata(
      [
        buildMessage({
          content: `{{batshit-zip:${zipId}:::Dynamic Tool Search - 1 lines}}OK`
        })
      ],
      'user-1'
    )

    expect(message.metadata?.zipIds).toEqual([zipId])
    expect(message.metadata?.zipReferences).toEqual([
      { reference: `{{batshit-zip:${zipId}:::Dynamic Tool Search - 1 lines}}` }
    ])
  })

  it('does not trust concrete-looking zip ids from another session', async () => {
    const zipId = 'cool_tool_1779584791784_nq20s'
    mockRedis.getZips.mockResolvedValue(
      new Map([
        [
          zipId,
          {
            metadata: {
              sessionId: 'other-session'
            }
          }
        ]
      ])
    )

    const { enrichMessagesWithTrustedZipMetadata } = await import('../messageZipTrust')
    const [message] = await enrichMessagesWithTrustedZipMetadata(
      [
        buildMessage({
          content: `{{batshit-zip:${zipId}:::Dynamic Tool Search - 1 lines}}OK`
        })
      ],
      'user-1'
    )

    expect(message.metadata?.zipIds).toBeUndefined()
  })

  it('rejects user-owned zips when a different session id is present', async () => {
    const zipId = 'cool_tool_1779584791784_nq20s'
    mockRedis.getZips.mockResolvedValue(
      new Map([
        [
          zipId,
          {
            userId: 'user-1',
            metadata: {
              sessionId: 'other-session'
            }
          }
        ]
      ])
    )

    const { enrichMessagesWithTrustedZipMetadata } = await import('../messageZipTrust')
    const [message] = await enrichMessagesWithTrustedZipMetadata(
      [
        buildMessage({
          content: `{{batshit-zip:${zipId}:::Dynamic Tool Search - 1 lines}}OK`
        })
      ],
      'user-1'
    )

    expect(message.metadata?.zipIds).toBeUndefined()
  })

  it('allows legacy user-owned zips that have no session id', async () => {
    const zipId = 'cool_tool_1779584791784_nq20s'
    mockRedis.getZips.mockResolvedValue(
      new Map([
        [
          zipId,
          {
            userId: 'user-1',
            metadata: {}
          }
        ]
      ])
    )

    const { enrichMessagesWithTrustedZipMetadata } = await import('../messageZipTrust')
    const [message] = await enrichMessagesWithTrustedZipMetadata(
      [
        buildMessage({
          content: `{{batshit-zip:${zipId}:::Dynamic Tool Search - 1 lines}}OK`
        })
      ],
      'user-1'
    )

    expect(message.metadata?.zipIds).toEqual([zipId])
  })

  it('ignores non-concrete example zip syntax', async () => {
    const { enrichMessagesWithTrustedZipMetadata } = await import('../messageZipTrust')
    const [message] = await enrichMessagesWithTrustedZipMetadata(
      [
        buildMessage({
          content: 'Example only: {{batshit-zip:...}}'
        })
      ],
      'user-1'
    )

    expect(mockRedis.getZips).not.toHaveBeenCalled()
    expect(message.metadata).toBeUndefined()
  })
})
