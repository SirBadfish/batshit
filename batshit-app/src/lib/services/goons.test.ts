import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createGoon,
  deleteGoonFacialArtwork,
  uploadAdvancedGoonPackage,
  uploadGoonFacialArtwork,
  uploadGoonLipArtwork,
  uploadGuidedDufClothesVrm
} from './goons'

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

  it('uploads exact facial-artwork metadata through the Goon-owned route', async () => {
    const definitionSha256 = 'a'.repeat(64)
    const guideSha256 = 'b'.repeat(64)
    const maskSha256 = 'd'.repeat(64)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_custom_1/facial-artwork')
      const form = init?.body as FormData
      expect(form.get('role')).toBe('brows')
      expect(form.get('definitionSha256')).toBe(definitionSha256)
      expect(form.get('templateId')).toBe('brow-canvas')
      expect(form.get('templateVersion')).toBe('2.0.0')
      expect(form.get('orientation')).toBe('anatomical-left')
      expect(form.get('guideSha256')).toBe(guideSha256)
      expect(form.get('maskSha256')).toBe(maskSha256)
      expect(JSON.parse(String(form.get('provenance')))).toEqual({
        sourceKind: 'user-authored',
        author: 'Fixture Artist',
        license: 'User-owned',
        rightsConfirmed: true
      })
      return new Response(
        JSON.stringify({
          artwork: {
            role: 'brows',
            url: '/uploads/goon_facial_artwork/brow-left.png',
            filename: 'brow-left.png',
            size: 123,
            mimeType: 'image/png',
            sha256: 'c'.repeat(64),
            template: {
              id: 'brow-canvas',
              version: '2.0.0',
              orientation: 'anatomical-left',
              guideSha256,
              maskSha256
            },
            provenance: {
              sourceKind: 'user-authored',
              author: 'Fixture Artist',
              license: 'User-owned',
              rightsConfirmed: true
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    global.fetch = fetchMock as typeof fetch

    const result = await uploadGoonFacialArtwork(
      'goon_custom_1',
      new File(['png'], 'brow.png', { type: 'image/png' }),
      {
        role: 'brows',
        definitionSha256,
        templateId: 'brow-canvas',
        templateVersion: '2.0.0',
        orientation: 'anatomical-left',
        guideSha256,
        maskSha256,
        provenance: {
          sourceKind: 'user-authored',
          author: 'Fixture Artist',
          license: 'User-owned',
          rightsConfirmed: true
        }
      }
    )
    expect(result).toMatchObject({ role: 'brows', filename: 'brow-left.png' })
  })

  it('treats referenced facial-artwork deletion as a safe shared-reference result', async () => {
    global.fetch = vi.fn(async () => new Response('', { status: 409 })) as typeof fetch
    await expect(deleteGoonFacialArtwork('goon_custom_1', 'shared.png')).resolves.toBe(false)
  })

  it('uploads Lip Artwork without exposing package template proof to the browser', async () => {
    const definitionSha256 = 'a'.repeat(64)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_custom_1/lip-artwork')
      const form = init?.body as FormData
      expect([...form.keys()].sort()).toEqual(['definitionSha256', 'file', 'provenance'])
      expect(form.get('definitionSha256')).toBe(definitionSha256)
      return new Response(
        JSON.stringify({
          artwork: {
            url: '/uploads/goon_facial_artwork/lips.png',
            filename: 'lips.png',
            size: 123,
            mimeType: 'image/png',
            sha256: 'b'.repeat(64)
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    global.fetch = fetchMock as typeof fetch

    await expect(
      uploadGoonLipArtwork(
        'goon_custom_1',
        new File(['png'], 'lips.png', { type: 'image/png' }),
        {
          definitionSha256,
          provenance: {
            sourceKind: 'user-authored',
            author: 'Fixture Artist',
            license: 'User-owned',
            rightsConfirmed: true
          }
        }
      )
    ).resolves.toMatchObject({ filename: 'lips.png' })
  })
})
