/**
 * SA-105 P3 — `/api/memory/recall-media`, the managed CLI lane's delivery-time
 * byte fetch (AMD-105-10, DL-105-09).
 *
 * The route is the whole CLI-side decision: the bridge sends a byte-free plan
 * plus which runtime it is serving, and gets back the finished plan and the
 * bytes. These tests pin the two lanes apart, the fail-loud posture on an
 * unknown runtime, and the ownership check every byte load goes through.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveUser: vi.fn(),
  loadManagedMemoryMedia: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveUser
}))
vi.mock('$lib/server/services/memory/memoryManage', () => ({
  loadManagedMemoryMedia: mocks.loadManagedMemoryMedia
}))

const { POST } = await import('./+server')

function request(body: unknown): Request {
  return new Request('http://localhost/api/memory/recall-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function call(body: unknown) {
  return POST({ request: request(body), locals: {} } as any)
}

const recallBody = (runtime: string) => ({
  userId: 'user-1',
  agentId: 'agent-1',
  runtime,
  recall: {
    success: true,
    target: 'sys.memory.recall',
    result: {
      recalled: [
        {
          id: 'mem-1',
          content: 'Maggie is my dog.',
          media: [
            { media_id: 'media-1', filename: 'maggie.png', mime_type: 'image/png', bytes: 1024 }
          ]
        }
      ]
    }
  }
})

describe('POST /api/memory/recall-media', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveUser.mockResolvedValue({ userId: 'user-1', auth: 'service' })
    mocks.loadManagedMemoryMedia.mockResolvedValue({ bytes: new Uint8Array([7, 7, 7]) })
  })

  it('delivers bytes in-turn for the Codex runtime and writes the in-turn note', async () => {
    const response = await call(recallBody('codex'))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.success).toBe(true)
    expect(payload.lane).toBe('tool_result')
    expect(payload.reason).toBe('codex_cli_mcp_image_content')
    expect(payload.images).toEqual([
      {
        mediaType: 'image/png',
        data: Buffer.from([7, 7, 7]).toString('base64'),
        filename: 'maggie.png'
      }
    ])

    const row = payload.recall.result.recalled[0]
    expect(row.media[0].delivery).toBe('in_turn')
    expect(row.media_note).toContain('available during THIS reply')
  })

  it('loads bytes only through the ownership-checked manage helper', async () => {
    await call(recallBody('codex'))

    expect(mocks.loadManagedMemoryMedia).toHaveBeenCalledWith(
      { userId: 'user-1', agentId: 'agent-1' },
      'mem-1',
      'media-1'
    )
  })

  it('uses the authenticated user, never the one the caller claims in the body', async () => {
    mocks.resolveUser.mockResolvedValue({ userId: 'real-user', auth: 'service' })

    await call({ ...recallBody('codex'), userId: 'someone-else' })

    expect(mocks.loadManagedMemoryMedia).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'real-user' }),
      'mem-1',
      'media-1'
    )
  })

  it('returns no images for the Claude runtime and says next_message honestly', async () => {
    const response = await call(recallBody('claude'))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.lane).toBe('none')
    expect(payload.reason).toBe('claude_cli_stores_mcp_images_as_text')
    expect(payload.images).toEqual([])
    expect(mocks.loadManagedMemoryMedia).not.toHaveBeenCalled()

    const row = payload.recall.result.recalled[0]
    expect(row.media[0]).toMatchObject({ delivery: 'next_message', reason: 'lane_none' })
    expect(row.media_note).toContain('REMEMBERED MEDIA with the next message')
  })

  it('degrades a missing image to next_message rather than failing the turn', async () => {
    mocks.loadManagedMemoryMedia.mockRejectedValue(new Error('deleted'))

    const payload = await (await call(recallBody('codex'))).json()

    expect(payload.images).toEqual([])
    expect(payload.recall.result.recalled[0].media[0]).toMatchObject({
      delivery: 'next_message',
      reason: 'source_unavailable'
    })
  })

  it('refuses an unknown runtime instead of guessing a lane', async () => {
    for (const runtime of ['gemini-cli', '', 'CODEX ']) {
      const response = await call(recallBody(runtime))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('runtime')
    }
    expect(mocks.loadManagedMemoryMedia).not.toHaveBeenCalled()
  })

  it('rejects a payload that is not a recall carrying media', async () => {
    const response = await call({
      userId: 'user-1',
      agentId: 'agent-1',
      runtime: 'codex',
      recall: { target: 'sys.artifact.update', result: {} }
    })

    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('sys.memory.recall')
  })

  it('requires an agentId and rejects an unauthenticated caller', async () => {
    const missingAgent = await call({ userId: 'user-1', runtime: 'codex', recall: {} })
    expect(missingAgent.status).toBe(400)

    mocks.resolveUser.mockResolvedValue(null)
    const unauthorized = await call(recallBody('codex'))
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ success: false, error: 'Unauthorized' })
  })
})
