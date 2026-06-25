import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGoon, uploadAdvancedGoonPackage, uploadGuidedDufClothesVrm } from './goons'

describe('goons service create flow', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('submits custom goon creation with kind=custom', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('kind')).toBe('custom')
      expect((form.get('file') as File | null)?.name).toBe('kiriko.bgoon')

      return new Response(
        JSON.stringify({
          id: 'goon_custom_1',
          user_id: 'user_1',
          name: 'Kiriko Custom',
          kind: 'custom',
          files: { animations: [] },
          customAvatar: {},
          created_at: '2026-03-24T00:00:00.000Z',
          updated_at: '2026-03-24T00:00:00.000Z'
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['package'], 'kiriko.bgoon', { type: 'application/octet-stream' })
    const goon = await createGoon({ kind: 'custom', file })

    expect(goon.kind).toBe('custom')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('submits advanced blender goon creation with the guided source profile', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('kind')).toBe('vrm')
      expect(form.get('sourceProfile')).toBe('guided-custom-vrm')
      expect((form.get('file') as File | null)?.name).toBe('kiriko-guided.bgoon')

      return new Response(
        JSON.stringify({
          id: 'goon_guided_1',
          user_id: 'user_1',
          name: 'Kiriko Guided',
          kind: 'vrm',
          sourceProfile: 'guided-custom-vrm',
          files: { animations: [] },
          guidedAvatar: {},
          created_at: '2026-04-16T00:00:00.000Z',
          updated_at: '2026-04-16T00:00:00.000Z'
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['package'], 'kiriko-guided.bgoon', {
      type: 'application/octet-stream'
    })
    const goon = await createGoon({ sourceProfile: 'guided-custom-vrm', file })

    expect(goon.sourceProfile).toBe('guided-custom-vrm')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces json upload errors as plain text', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'File too large. 350 MB or smaller.' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch

    const file = new File(['package'], 'kiriko.bgoon', { type: 'application/octet-stream' })

    await expect(createGoon({ kind: 'custom', file })).rejects.toThrow(
      'File too large. 350 MB or smaller.'
    )
  })

  it('uploads guided DUF clothes vrms through the dedicated route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_guided_1/duf-clothes')
      const form = init?.body as FormData
      expect((form.get('file') as File | null)?.name).toBe('kiriko-duf.vrm')

      return new Response(
        JSON.stringify({
          file: {
            url: '/uploads/kiriko-duf.vrm',
            filename: 'kiriko-duf.vrm',
            mimetype: 'model/vrm'
          }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['vrm'], 'kiriko-duf.vrm', { type: 'model/vrm' })
    const uploaded = await uploadGuidedDufClothesVrm('goon_guided_1', file)

    expect(uploaded.url).toBe('/uploads/kiriko-duf.vrm')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uploads advanced blender package updates through the dedicated route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_guided_1/advanced-package')
      const form = init?.body as FormData
      expect((form.get('file') as File | null)?.name).toBe('kiriko-v2.bgoon')

      return new Response(
        JSON.stringify({
          files: {
            package: {
              url: '/uploads/kiriko-v2.bgoon',
              filename: 'kiriko-v2.bgoon',
              mimetype: 'application/zip'
            },
            vrm: {
              url: '/uploads/kiriko-v2_avatar.vrm',
              filename: 'kiriko-v2_avatar.vrm',
              mimetype: 'model/vrm'
            },
            manifest: {
              url: '/uploads/kiriko-v2_avatar.json',
              filename: 'kiriko-v2_avatar.json',
              mimetype: 'application/json'
            }
          },
          manifestData: {
            summary: { name: 'Kiriko V2', contractVersion: 1 },
            outfitPieces: [{ id: 'jacket', label: 'Jacket', runtimeNodeNames: ['Jacket'] }],
            outfitPresets: [{ id: 'all_original', name: 'All Original', piecesOn: ['jacket'] }]
          }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['package'], 'kiriko-v2.bgoon', {
      type: 'application/octet-stream'
    })
    const uploaded = await uploadAdvancedGoonPackage('goon_guided_1', file)

    expect(uploaded.package.url).toBe('/uploads/kiriko-v2.bgoon')
    expect(uploaded.vrm.url).toBe('/uploads/kiriko-v2_avatar.vrm')
    expect(uploaded.manifestSummary?.name).toBe('Kiriko V2')
    expect(uploaded.outfitPieces[0]?.id).toBe('jacket')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
