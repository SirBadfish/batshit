import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTrustedRecipeArchiveReceipt,
  uploadConstructedRecipePackage
} from '../goonRecipePackageUpload.server'

const sha = (character: string) => character.repeat(64)
const packageBytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3])

function payload() {
  return {
    files: {
      package: {
        url: 'http://batshit-server.test/uploads/goon_custom_packages/live.bgoon',
        filename: 'live.bgoon', size: 300
      },
      model: {
        url: 'http://batshit-server.test/uploads/goon_custom_models/avatar.glb',
        filename: 'avatar.glb', size: 200
      },
      manifest: {
        url: 'http://batshit-server.test/uploads/goon_custom_manifests/avatar.json',
        filename: 'avatar.json', size: 40
      }
    },
    archiveExtraction: {
      contract: 'recipe-archive-extraction/v1',
      extractor: { id: 'batshit-server-recipe-archive', version: 1 },
      archive: {
        ref: '/uploads/goon_custom_packages/live.bgoon', sha256: sha('a'), bytes: 300
      },
      entryCount: 2,
      totalUncompressedBytes: 240,
      members: [
        {
          role: 'manifest', path: 'avatar.json', sha256: sha('b'), bytes: 40,
          extracted: {
            ref: '/uploads/goon_custom_manifests/avatar.json', sha256: sha('b'), bytes: 40
          }
        },
        {
          role: 'model', path: 'avatar.glb', sha256: sha('c'), bytes: 200,
          extracted: {
            ref: '/uploads/goon_custom_models/avatar.glb', sha256: sha('c'), bytes: 200
          }
        }
      ]
    }
  }
}

describe('server-owned Recipe package upload', () => {
  beforeEach(() => {
    vi.stubEnv('BATSHIT_TOKEN', 'service-token')
    vi.stubEnv('BATSHIT_SERVER_URL', 'http://batshit-server.test')
    vi.stubEnv('PUBLIC_BATSHIT_SERVER_URL', 'http://browser.test')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('uploads through the internal authenticated endpoint and returns portable refs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload()))
    const result = await uploadConstructedRecipePackage(packageBytes, 'live.bgoon')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://batshit-server.test/api/upload/goon-custom-package')
    expect(request?.headers).toEqual({ 'x-batshit-service-token': 'service-token' })
    expect(request?.method).toBe('POST')
    expect(request?.body).toBeInstanceOf(FormData)
    const uploaded = (request?.body as FormData).get('file') as File
    expect(uploaded.name).toBe('live.bgoon')
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(packageBytes)
    expect(result.live).toEqual({
      package: result.archiveReceipt.archive,
      model: result.archiveReceipt.members.find((member) => member.role === 'model')?.extracted,
      manifest: result.archiveReceipt.members.find((member) => member.role === 'manifest')?.extracted
    })
    expect(result.live.model.ref).toBe('/uploads/goon_custom_models/avatar.glb')
  })

  it('fails closed without internal service authentication', async () => {
    vi.stubEnv('BATSHIT_TOKEN', '')
    vi.stubEnv('MCP_GATEWAY_AUTH_TOKEN', '')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(uploadConstructedRecipePackage(packageBytes, 'live.bgoon'))
      .rejects.toThrow('BATSHIT_TOKEN is not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects untrusted extraction, mismatched file refs, and malformed file topology', async () => {
    const wrongExtractor = payload()
    wrongExtractor.archiveExtraction.extractor.id = 'other-extractor'
    await expect(createTrustedRecipeArchiveReceipt(
      wrongExtractor.archiveExtraction, wrongExtractor.files
    )).rejects.toThrow('trusted Recipe archive extraction')

    const wrongRef = payload()
    wrongRef.files.model.filename = 'another.glb'
    await expect(createTrustedRecipeArchiveReceipt(
      wrongRef.archiveExtraction, wrongRef.files
    )).rejects.toThrow('extraction refs do not match')

    const wrongUrl = payload()
    wrongUrl.files.model.url = 'http://batshit-server.test/uploads/goon_custom_models/another.glb'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(wrongUrl))
    await expect(uploadConstructedRecipePackage(packageBytes, 'live.bgoon'))
      .rejects.toThrow('Uploaded Live model file does not match')
  })

  it('retries a transport failure with exactly the same file and no cleanup call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('connection closed after upload'))
      .mockResolvedValueOnce(Response.json(payload()))

    await expect(uploadConstructedRecipePackage(packageBytes, 'live.bgoon'))
      .resolves.toHaveProperty('live.package.ref', '/uploads/goon_custom_packages/live.bgoon')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = (fetchMock.mock.calls[0]?.[1]?.body as FormData).get('file') as File
    const second = (fetchMock.mock.calls[1]?.[1]?.body as FormData).get('file') as File
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(
      new Uint8Array(await second.arrayBuffer())
    )
    expect(fetchMock.mock.calls.every(([url]) => url ===
      'http://batshit-server.test/api/upload/goon-custom-package')).toBe(true)
    expect(fetchMock.mock.calls.every(([, request]) => request?.method === 'POST')).toBe(true)
  })

  it('retries an uncertain successful response without deleting SHA-named assets', async () => {
    const incomplete = payload()
    incomplete.files.model.url = ''
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => Response.json(incomplete))
      .mockImplementationOnce(async () => Response.json(payload()))

    await expect(uploadConstructedRecipePackage(packageBytes, 'live.bgoon'))
      .resolves.toHaveProperty('live.model.ref', '/uploads/goon_custom_models/avatar.glb')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([, request]) => request?.method === 'POST')).toBe(true)
  })

  it('does not retry an ordinary 4xx validation refusal', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 400 }))
    await expect(uploadConstructedRecipePackage(packageBytes, 'live.bgoon'))
      .rejects.toThrow('rejected (400)')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('bounds response-body settlement on both attempts', async () => {
    vi.useFakeTimers()
    const pendingBody = () => ({
      ok: true,
      status: 200,
      json: () => new Promise<never>(() => {})
    }) as Response
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => pendingBody())

    const result = uploadConstructedRecipePackage(packageBytes, 'live.bgoon')
    const assertion = expect(result).rejects.toThrow('did not settle within 120 seconds')
    await vi.advanceTimersByTimeAsync(120_000)
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
  })
})
