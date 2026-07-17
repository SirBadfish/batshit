import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '../redis'

const publishMock = vi.fn()
const fetchMock = vi.fn()

vi.mock('$lib/server/ssePublisher', () => ({
  publishSessionEvent: publishMock
}))

useRedisTestServer()

const buildRequest = (payload: Record<string, any>) =>
  new Request('http://localhost/api/artifacts/share', {
    method: 'POST',
    body: JSON.stringify(payload)
  })

describe('POST /api/artifacts/share', () => {
  beforeEach(async () => {
    publishMock.mockClear()
    fetchMock.mockReset()
    // batshit-server uploads are service-token-gated; the share route attaches it.
    vi.stubEnv('BATSHIT_TOKEN', 'artifacts-share-test-token')
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await redis.json.set('artifact:art_share', '$', {
      id: 'art_share',
      user_id: 'user_a',
      name: 'Sharer',
      content: '<div></div>',
      mode: 'published'
    } as any)

    await redis.json.set('session:sess_1', '$', {
      id: 'sess_1',
      user_id: 'user_a',
      agent_id: 'agent_1',
      created_at: new Date().toISOString()
    } as any)
    await redis.sAdd('user:user_a:sessions', 'sess_1')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('requires authentication', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    const response = await POST({
      request: buildRequest({ artifactId: 'art_share', content: 'hello' }),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
  })

  it('blocks access when user does not own unpublished artifact', async () => {
    await redis.json.set('artifact:private_art', '$', {
      id: 'private_art',
      user_id: 'owner_b',
      name: 'Private',
      mode: 'edit'
    } as any)

    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    await expect(async () => {
      await POST({
        request: buildRequest({
          artifactId: 'private_art',
          content: 'blocked',
          sessionId: 'sess_1'
        }),
        locals: { user: { id: 'user_a' } }
      } as any)
    }).rejects.toHaveProperty('status', 403)
  })

  it('persists clip/message and publishes SSE event', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    const event = {
      request: buildRequest({ artifactId: 'art_share', content: 'share me', sessionId: 'sess_1' }),
      locals: { user: { id: 'user_a' } },
      fetch: fetchMock
    } as any

    const response = await POST(event)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.clipId).toBeTruthy()
    expect(body.followupTriggered).toBe(true)
    expect(body.followupStatus).toBe('triggered')

    const clip = await redis.json.get(`clip:user_a:${body.clipId}`)
    expect(clip && (clip as any).content).toContain('share me')

    expect(body.messageId).toBeTruthy()
    const message = await redis.json.get(`message:sess_1:${body.messageId}`)
    expect(message).toBeTruthy()
    expect((message as any).role).toBe('user')
    expect((message as any).metadata?.source).toBe('artifact_share')
    expect((message as any).content).toContain(`{{batshit-clip:${body.clipId}`)

    expect(publishMock).toHaveBeenCalledTimes(2)
    expect(publishMock).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ type: 'user_message', message: expect.any(Object) })
    )
    expect(publishMock).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        type: 'clip_state_changed',
        clipId: body.clipId,
        source: 'artifact-share'
      })
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [followupUrl, followupInit] = fetchMock.mock.calls[0]
    expect(String(followupUrl)).toContain('/api/messages/send-routed')
    const followupPayload = JSON.parse(String((followupInit as RequestInit).body ?? '{}'))
    expect(followupPayload.agentId).toBe('agent_1')
    expect(followupPayload.sessionId).toBe('sess_1')
    expect(followupPayload.userId).toBe('user_a')
    expect(followupPayload.messages.at(-1)?.id).toBe(body.messageId)
    expect(followupPayload.messages.at(-1)?.role).toBe('user')
    expect(followupPayload.content).toContain('The user shared output from artifact "Sharer"')
    expect(followupPayload.content).toContain(`{{batshit-clip:${body.clipId}`)
  })

  it('redacts inline image data URLs from shared text payloads', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'

    const response = await POST({
      request: buildRequest({
        artifactId: 'art_share',
        content: `snapshot: ${imageDataUrl}`,
        sessionId: 'sess_1'
      }),
      locals: { user: { id: 'user_a' } },
      fetch: fetchMock
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)

    const clip = await redis.json.get(`clip:user_a:${body.clipId}`)
    expect((clip as any)?.content).toContain('[redacted image/png data URL]')
    expect((clip as any)?.content).not.toContain('data:image/')

    const message = await redis.json.get(`message:sess_1:${body.messageId}`)
    expect((message as any)?.content).not.toContain('data:image/')
  })

  it('shares images without preview filler and preserves full-resolution source metadata', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')
    const clipId = 'clip_1779416324513_abcd1234'
    const previewUrl = 'http://localhost:5600/uploads/images/preview.jpg'
    const originalUrl = 'http://localhost:5600/uploads/images/original.png'
    await redis.json.set('user:user_a:settings', '$', {
      id: 'settings_user_a',
      user_id: 'user_a',
      ui_settings: {
        upload_settings: {
          tunnel_url: 'https://shares.example.com',
          use_https: true,
          tunnel_provider: 'cloudflared_managed',
          cloudflared_auto_start: true,
          cloudflared_target_url: 'http://127.0.0.1:5600'
        }
      }
    } as any)
    const uploadFetch = vi.fn(async () => {
      if (uploadFetch.mock.calls.length === 1) {
        return new Response(
          JSON.stringify({
            file: {
              displayUrl: originalUrl,
              localUrl: originalUrl,
              url: originalUrl
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      await redis.set(`clip:user_a:${clipId}`, {
        id: clipId,
        user_id: 'user_a',
        filename: 'Sharer-share.png',
        fileType: 'image',
        mimeType: 'image/png',
        displayUrl: previewUrl,
        localUrl: previewUrl,
        externalUrl: null,
        storageMode: 'local',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      } as any)

      return new Response(
        JSON.stringify({
          file: {
            clipId,
            originalName: 'Sharer-share.png',
            displayUrl: previewUrl,
            localUrl: previewUrl,
            url: previewUrl
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', uploadFetch)

    const response = await POST({
      request: buildRequest({
        artifactId: 'art_share',
        content:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        format: 'image',
        sessionId: 'sess_1',
        initiator: 'agent'
      }),
      locals: { user: { id: 'user_a' } },
      fetch: fetchMock
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(uploadFetch).toHaveBeenCalledTimes(2)
    const originalUploadSettings = JSON.parse(
      String(((uploadFetch.mock.calls[0][1] as RequestInit).body as FormData).get('uploadSettings'))
    )
    const compressedUploadSettings = JSON.parse(
      String(((uploadFetch.mock.calls[1][1] as RequestInit).body as FormData).get('uploadSettings'))
    )
    expect(originalUploadSettings).toMatchObject({
      tunnel_url: 'https://shares.example.com',
      use_https: true,
      tunnel_provider: 'cloudflared_managed',
      cloudflared_auto_start: true,
      cloudflared_target_url: 'http://127.0.0.1:5600',
      skip_clip_persistence: true,
      artifact_source: 'artifact_share_original'
    })
    expect(compressedUploadSettings).toMatchObject({
      tunnel_url: 'https://shares.example.com',
      use_https: true,
      tunnel_provider: 'cloudflared_managed',
      cloudflared_auto_start: true,
      cloudflared_target_url: 'http://127.0.0.1:5600'
    })
    expect(compressedUploadSettings).not.toHaveProperty('skip_clip_persistence')
    expect(fetchMock).not.toHaveBeenCalled()

    // Stored clip records keep canonical relative /uploads/... paths; browser-facing
    // reads resolve them against the current batshit-server base (clip-lifecycle contract).
    const clip = await redis.get(`clip:user_a:${body.clipId}`)
    expect((clip as any)?.displayUrl).toBe('/uploads/images/preview.jpg')
    expect((clip as any)?.fullResolutionUrl).toBe('/uploads/images/original.png')

    const message = await redis.json.get(`message:sess_1:${body.messageId}`)
    const content = String((message as any)?.content || '')
    expect(content).toContain('**Sharer** shared data\n\n')
    expect(content).toContain(`{{batshit-clip:${clipId}:::Sharer-share.png}}`)
    expect(content).not.toContain('shared data:')
    expect(content).not.toContain('[Image]')
  })

  it('uses markdown data field when content payload is an object', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    const response = await POST({
      request: buildRequest({
        artifactId: 'art_share',
        content: {
          title: 'Duo-AI Web Search',
          data: '## Synthesized Answer\\n\\nThis should be readable markdown.'
        },
        format: 'markdown',
        sessionId: 'sess_1'
      }),
      locals: { user: { id: 'user_a' } },
      fetch: fetchMock
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    const clip = await redis.json.get(`clip:user_a:${body.clipId}`)
    expect((clip as any)?.content).toContain('## Synthesized Answer')
    expect((clip as any)?.content).not.toContain('[object Object]')
  })

  it('requires sessionId when includeInChat is true', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    await expect(async () => {
      await POST({
        request: buildRequest({ artifactId: 'art_share', content: 'missing session' }),
        locals: { user: { id: 'user_a' } }
      } as any)
    }).rejects.toHaveProperty('status', 400)
  })

  it('supports save-to-vault without creating a chat message', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    const response = await POST({
      request: buildRequest({
        artifactId: 'art_share',
        content: 'vault only',
        includeInChat: false
      }),
      locals: { user: { id: 'user_a' } }
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.messageId).toBeUndefined()

    const clip = await redis.json.get(`clip:user_a:${body.clipId}`)
    expect((clip as any)?.content).toBe('vault only')
    expect(publishMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips auto-followup for agent-initiated shares during an active agent turn', async () => {
    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    const response = await POST({
      request: buildRequest({
        artifactId: 'art_share',
        content: 'mirror this',
        sessionId: 'sess_1',
        initiator: 'agent'
      }),
      locals: { user: { id: 'user_a' } },
      fetch: fetchMock
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.messageId).toBeTruthy()
    const message = await redis.json.get(`message:sess_1:${body.messageId}`)
    expect((message as any)?.metadata?.shareInitiator).toBe('agent')
    expect((message as any)?.content).toContain(`{{batshit-clip:${body.clipId}`)
    expect(body.followupTriggered).toBe(false)
    expect(body.followupStatus).toBe('skipped_agent_initiated')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips auto-followup when the session has no agent id', async () => {
    await redis.json.set('session:sess_no_agent', '$', {
      id: 'sess_no_agent',
      user_id: 'user_a',
      created_at: new Date().toISOString()
    } as any)
    await redis.sAdd('user:user_a:sessions', 'sess_no_agent')

    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    const response = await POST({
      request: buildRequest({
        artifactId: 'art_share',
        content: 'no agent',
        sessionId: 'sess_no_agent'
      }),
      locals: { user: { id: 'user_a' } },
      fetch: fetchMock
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.followupTriggered).toBe(false)
    expect(body.followupStatus).toBe('skipped_no_agent')
    expect(body.followupError).toContain('No session agent')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces auto-followup send failures while keeping the shared message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('send-routed exploded', { status: 502 }))
    const { POST } = await import('../../../routes/api/artifacts/share/+server')

    const response = await POST({
      request: buildRequest({ artifactId: 'art_share', content: 'share me', sessionId: 'sess_1' }),
      locals: { user: { id: 'user_a' } },
      fetch: fetchMock
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.messageId).toBeTruthy()
    expect(body.followupTriggered).toBe(false)
    expect(body.followupStatus).toBe('failed')
    expect(body.followupError).toContain('send-routed exploded')

    const message = await redis.json.get(`message:sess_1:${body.messageId}`)
    expect(message).toBeTruthy()
  })
})
