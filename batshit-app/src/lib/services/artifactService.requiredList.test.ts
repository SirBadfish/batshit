import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactService } from './artifactService'

describe('required Artifact list reads', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('exposes the route refusal for Access while preserving optional callers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Artifacts unavailable' }), { status: 503 })))
    const service = new ArtifactService()
    await expect(service.getArtifacts('probe', { required: true })).rejects.toThrow('Artifacts unavailable')
    await expect(service.getArtifacts('probe')).resolves.toEqual([])
  })

  it('distinguishes malformed successful replies from a confirmed empty list', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifacts: [] })))
      .mockResolvedValueOnce(new Response('[]')))
    const service = new ArtifactService()
    await expect(service.getArtifacts('probe', { required: true })).rejects.toThrow('The saved artifact list is unreadable.')
    await expect(service.getArtifacts('probe', { required: true })).resolves.toEqual([])
  })

  it('preserves a network failure for required readers', async () => {
    const failure = new TypeError('Network unavailable')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure))
    await expect(new ArtifactService().getArtifacts('probe', { required: true })).rejects.toBe(failure)
  })
})
