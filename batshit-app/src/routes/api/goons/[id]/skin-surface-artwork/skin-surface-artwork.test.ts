import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createDefaultSkinAppearanceState, parseSkinAppearanceDefinition, setCustomSkinSurfaceUpload } from '$lib/goons/skinAppearance'

const mocks = vi.hoisted(() => ({ loadDefinition: vi.fn() }))
vi.mock('$lib/server/services/skinAppearance.server', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/server/services/skinAppearance.server')>(),
  loadGoonSkinAppearanceDefinition: mocks.loadDefinition
}))
import { POST } from './+server'

const backendRequire = createRequire(resolve(process.cwd(), '../batshit-server/server/package.json'))
const sharp = backendRequire('sharp')
const { prepareSkinSurfaceArtworkUpload } = backendRequire('./src/services/skinSurfaceArtworkValidator.js')

describe('Skin Surface upload target canvas', () => {
  useRedisTestServer()
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('uses the owned Goon canvas and keeps canonical upload ownership strict', async () => {
    const rawDefinition = JSON.parse(readFileSync(resolve(process.cwd(), 'static/goons/skin-appearance/v1/skin-appearance-v1.json'), 'utf8'))
    rawDefinition.canvas.width = 2048; rawDefinition.canvas.height = 2048
    rawDefinition.definitionSha256 = 'c'.repeat(64)
    const definition = parseSkinAppearanceDefinition(rawDefinition)
    mocks.loadDefinition.mockResolvedValue(definition)
    await redis.json.set('goon:goon', '$', { id: 'goon', user_id: 'user' })
    const png = await sharp({ create: { width: 4096, height: 4096, channels: 4,
      background: { r: 120, g: 90, b: 75, alpha: 1 } } }).png().toBuffer()
    const form = new FormData()
    form.append('file', new File([png], 'master.png', { type: 'image/png' }))
    form.append('map', 'baseColor'); form.append('definitionSha256', definition.definitionSha256)
    form.append('canvasWidth', '4096'); form.append('canvasHeight', '4096')
    form.append('provenance', JSON.stringify({ sourceKind: 'user-authored', author: 'Artist', license: 'User-owned', rightsConfirmed: true }))
    let ownedProof: any
    const forwarded = vi.fn(async (_url: string, options: RequestInit) => {
      const body = options.body as FormData
      expect(body.get('canvasWidth')).toBe('2048'); expect(body.get('canvasHeight')).toBe('2048')
      const prepared = await prepareSkinSurfaceArtworkUpload({ buffer: png, map: body.get('map'),
        definitionSha256: body.get('definitionSha256'), provenance: body.get('provenance'),
        targetCanvas: { width: Number(body.get('canvasWidth')), height: Number(body.get('canvasHeight')) } })
      ownedProof = { uploadType: 'goon_skin_artwork', mimetype: 'image/png', size: prepared.buffer.length,
        skinSurfaceArtwork: prepared.artwork }
      return new Response(JSON.stringify({ file: { url: '/uploads/goon_skin_artwork/master.png',
        filename: 'master.png', size: prepared.buffer.length }, artwork: prepared.artwork }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', forwarded); vi.stubEnv('BATSHIT_TOKEN', 'skin-canvas-test-token')
    vi.stubEnv('BATSHIT_SERVER_URL', 'http://batshit-server.test')
    const event = { params: { id: 'goon' }, locals: { user: { id: 'user' } }, request: { formData: async () => form } } as any
    const response = await POST(event)
    expect(response.status).toBe(200)
    const upload = (await response.json()).artwork
    expect(upload.canvas).toEqual({ width: 2048, height: 2048, colorSpace: 'srgb', flipY: false, encoding: 'rgba8' })
    const state = setCustomSkinSurfaceUpload(definition, createDefaultSkinAppearanceState(definition), 'baseColor', upload)
    const actual = await vi.importActual<typeof import('$lib/server/services/skinAppearance.server')>('$lib/server/services/skinAppearance.server')
    const reader = { json: { get: async (key: string) => key === 'upload:goon_custom_manifests:avatar.json'
      ? { textContent: JSON.stringify({ skinAppearance: rawDefinition }) } : key === 'upload:goon_skin_artwork:master.png' ? ownedProof : null } }
    const goon = { customAvatar: { manifest: { filename: 'avatar.json' } } } as any
    await expect(actual.validateGoonSkinAppearanceState(reader as any, goon, state)).resolves.toEqual(state)
    ownedProof.skinSurfaceArtwork.canvas.width = 4096
    await expect(actual.validateGoonSkinAppearanceState(reader as any, goon, state)).rejects.toThrow(/ownership record/)
    form.set('definitionSha256', 'd'.repeat(64))
    expect((await POST(event)).status).toBe(409)
    expect(forwarded).toHaveBeenCalledTimes(1)
  }, 30000)
})
