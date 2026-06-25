import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '../redis'
import { createArtifactRuntimeToken } from '../services/artifactRuntimeAuth'

useRedisTestServer()

async function createRuntimeRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
) {
  const token = await createArtifactRuntimeToken({
    userId: 'user_a',
    artifactId: 'art_clip'
  })
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'null',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
}

async function seedArtifact() {
  await redis.json.set('artifact:art_clip', '$', {
    id: 'art_clip',
    user_id: 'user_a',
    name: 'Clip Source Artifact',
    content: '<html></html>',
    mode: 'published'
  } as any)
}

describe('/api/artifacts/clip-sources', () => {
  it('lists image clips through artifact runtime auth without returning image bytes', async () => {
    await seedArtifact()
    await redis.set('clip:user_a:clip_image', {
      id: 'clip_image',
      user_id: 'user_a',
      filename: 'source.png',
      fileType: 'image',
      mimeType: 'image/png',
      displayUrl: 'http://localhost:5600/uploads/images/source.png',
      localUrl: 'http://localhost:5600/uploads/images/source.png',
      tunnelPath: '/uploads/images/source.png',
      storageMode: 'local',
      localBase64: 'iVBORw0KGgo=',
      fileSize: 1234,
      created_at: '2026-06-07T10:00:00.000Z',
      updated_at: '2026-06-07T10:00:00.000Z'
    } as any)
    await redis.set('clip:user_a:clip_text', {
      id: 'clip_text',
      user_id: 'user_a',
      filename: 'notes.txt',
      fileType: 'text',
      mimeType: 'text/plain',
      content: 'not an image',
      storageMode: 'local',
      created_at: '2026-06-07T10:01:00.000Z',
      updated_at: '2026-06-07T10:01:00.000Z'
    } as any)
    await redis.sAdd('user:user_a:clips', 'clip_image')
    await redis.sAdd('user:user_a:clips', 'clip_text')

    const { GET } = await import('../../../routes/api/artifacts/clip-sources/+server')
    const response = await GET({
      request: await createRuntimeRequest('GET', '/api/artifacts/clip-sources?artifactId=art_clip'),
      url: new URL('http://localhost/api/artifacts/clip-sources?artifactId=art_clip')
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0]).toMatchObject({
      id: 'clip_image',
      filename: 'source.png',
      mimeType: 'image/png',
      hasTunnelPath: true
    })
    expect(JSON.stringify(body)).not.toContain('iVBORw0KGgo=')
  })

  it('resolves a Clip Vault image to the configured tunnel URL when available', async () => {
    await seedArtifact()
    await redis.json.set('user:user_a:settings', '$', {
      id: 'settings_user_a',
      user_id: 'user_a',
      ui_settings: {
        upload_settings: {
          tunnel_provider: 'manual',
          tunnel_url: 'https://fresh-tunnel.example'
        }
      }
    } as any)
    await redis.set('clip:user_a:clip_render', {
      id: 'clip_render',
      user_id: 'user_a',
      filename: 'render-preview.jpg',
      fileType: 'image',
      mimeType: 'image/jpeg',
      displayUrl: 'http://localhost:5600/uploads/images/render-preview.jpg',
      localUrl: 'http://localhost:5600/uploads/images/render-preview.jpg',
      fullResolutionUrl: 'http://localhost:5600/uploads/images/render-original.png',
      storageMode: 'local',
      created_at: '2026-06-07T10:00:00.000Z',
      updated_at: '2026-06-07T10:00:00.000Z'
    } as any)
    await redis.sAdd('user:user_a:clips', 'clip_render')

    const { POST } = await import('../../../routes/api/artifacts/clip-sources/+server')
    const response = await POST({
      request: await createRuntimeRequest('POST', '/api/artifacts/clip-sources', {
        artifactId: 'art_clip',
        clipId: 'clip_render'
      }),
      url: new URL('http://localhost/api/artifacts/clip-sources')
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.source).toMatchObject({
      type: 'url',
      clipId: 'clip_render',
      url: 'https://fresh-tunnel.example/uploads/images/render-original.png'
    })
    expect(body.source.data).toBeUndefined()
  })

  it('falls back to bounded image data when no tunnel URL is available', async () => {
    await seedArtifact()
    await redis.json.set('user:user_a:settings', '$', {
      id: 'settings_user_a',
      user_id: 'user_a',
      ui_settings: {
        upload_settings: {
          tunnel_provider: 'none'
        }
      }
    } as any)
    await redis.set('clip:user_a:clip_local', {
      id: 'clip_local',
      user_id: 'user_a',
      filename: 'local.png',
      fileType: 'image',
      mimeType: 'image/png',
      localUrl: 'http://localhost:5600/uploads/images/local.png',
      displayUrl: 'http://localhost:5600/uploads/images/local.png',
      storageMode: 'local',
      created_at: '2026-06-07T10:00:00.000Z',
      updated_at: '2026-06-07T10:00:00.000Z'
    } as any)
    await redis.set('upload:images:local.png', {
      mimetype: 'image/png',
      base64: 'iVBORw0KGgo='
    })
    await redis.sAdd('user:user_a:clips', 'clip_local')

    const { POST } = await import('../../../routes/api/artifacts/clip-sources/+server')
    const response = await POST({
      request: await createRuntimeRequest('POST', '/api/artifacts/clip-sources', {
        artifactId: 'art_clip',
        clipId: 'clip_local'
      }),
      url: new URL('http://localhost/api/artifacts/clip-sources')
    } as any)
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.source).toMatchObject({
      type: 'data',
      clipId: 'clip_local',
      data: 'data:image/png;base64,iVBORw0KGgo='
    })
  })
})
