import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lookupMock = vi.fn()
const requestMock = vi.fn()

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>()
  return {
    ...actual,
    default: {
      ...actual,
      lookup: (...args: unknown[]) => lookupMock(...args),
      promises: {
        ...actual.promises,
        lookup: (hostname: string, options: unknown) => new Promise((resolve, reject) => {
          lookupMock(hostname, options, (error: Error | null, answers: unknown) => error ? reject(error) : resolve(answers))
        })
      }
    }
  }
})

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, default: { ...actual, request: (...args: unknown[]) => requestMock(...args) } }
})

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>()
  return { ...actual, default: { ...actual, request: (...args: unknown[]) => requestMock(...args) } }
})

import { ArtifactShareImageFetchError, fetchPublicArtifactImage } from '../artifactShareImageFetch.server'

type Reply = { status: number; headers?: Record<string, string>; chunks?: Buffer[]; stall?: boolean }
let replies: Reply[]
let answers: string[]
let connectionAnswers: string[] | undefined

function addressRows(addresses: string[]) {
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

beforeEach(() => {
  vi.clearAllMocks()
  replies = []
  answers = ['8.8.8.8']
  connectionAnswers = undefined
  lookupMock.mockImplementation((_host, _options, callback) => {
    callback(null, addressRows(connectionAnswers ?? answers))
  })
  requestMock.mockImplementation((url: URL, options: any, onResponse: (response: Readable) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      options.lookup(url.hostname, { all: false }, (error: Error | null) => {
        if (error) {
          request.emit('error', error)
          return
        }
        const reply = replies.shift()
        if (!reply) {
          request.emit('error', new Error('unexpected request'))
          return
        }
        const response = (reply.stall ? new Readable({ read() {} }) : Readable.from(reply.chunks ?? [])) as Readable & {
          statusCode: number
          headers: Record<string, string>
        }
        response.statusCode = reply.status
        response.headers = reply.headers ?? {}
        onResponse(response)
      })
    }
    return request
  })
})

afterEach(() => vi.useRealTimers())

describe('fetchPublicArtifactImage', () => {
  it.each([
    'file:///etc/passwd', 'http://127.0.0.1/private', 'http://169.254.169.254/latest',
    'http://192.0.2.1/image', 'http://[::ffff:7f00:1]/image',
    'http://[::ffff:127.0.0.1]/image', 'http://[2001:db8::1]/image',
    'http://user:secret@example.com/image', 'http://localhost/image', 'http://printer.local/image'
  ])('refuses unsafe URL without a request: %s', async (url) => {
    await expect(fetchPublicArtifactImage(url)).rejects.toThrow(ArtifactShareImageFetchError)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('refuses a hostname if any preflight DNS answer is private, before a request', async () => {
    answers = ['8.8.8.8', '10.0.0.5']
    await expect(fetchPublicArtifactImage('https://images.example.org/pic')).rejects.toThrow('Unable to fetch shared image URL')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('refuses rebinding to a private address in the socket lookup', async () => {
    let calls = 0
    lookupMock.mockImplementation((_host, _options, callback) => {
      calls++
      callback(null, addressRows(calls === 1 ? ['8.8.8.8'] : ['127.0.0.1']))
    })
    replies = [{ status: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('image')] }]
    await expect(fetchPublicArtifactImage('https://images.example.org/pic')).rejects.toThrow('Unable to fetch shared image URL')
    expect(calls).toBe(2)
    expect(replies).toHaveLength(1) // Socket lookup refused before any response bytes.
  })

  it('refuses a redirect to a private literal without requesting it', async () => {
    replies = [{ status: 302, headers: { location: 'http://127.0.0.1/secret' } }]
    await expect(fetchPublicArtifactImage('https://images.example.org/pic')).rejects.toThrow('Unable to fetch shared image URL')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('revalidates redirect DNS and refuses a private answer before the next request', async () => {
    lookupMock.mockImplementation((host, _options, callback) => {
      callback(null, addressRows(host === 'internal.example.org' ? ['10.1.2.3'] : ['8.8.8.8']))
    })
    replies = [{ status: 302, headers: { location: 'https://internal.example.org/pic' } }]
    await expect(fetchPublicArtifactImage('https://images.example.org/pic')).rejects.toThrow('Unable to fetch shared image URL')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('returns public image bytes and normalized MIME', async () => {
    replies = [{ status: 200, headers: { 'content-type': 'image/png; charset=binary' }, chunks: [Buffer.from('pic')] }]
    const image = await fetchPublicArtifactImage('https://images.example.org/pic')
    expect(Buffer.from(image.bytes).toString()).toBe('pic')
    expect(image.contentType).toBe('image/png')
  })

  it('accepts a public IPv6 literal', async () => {
    connectionAnswers = ['2606:4700:4700::1111']
    replies = [{ status: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('v6')] }]
    const image = await fetchPublicArtifactImage('https://[2606:4700:4700::1111]/pic')
    expect(Buffer.from(image.bytes).toString()).toBe('v6')
  })

  it('does not reject public 192.0 addresses outside reserved /24 ranges', async () => {
    replies = [{ status: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('public')] }]
    const image = await fetchPublicArtifactImage('http://192.0.1.1/pic')
    expect(Buffer.from(image.bytes).toString()).toBe('public')
  })

  it('follows a public redirect and returns the image', async () => {
    replies = [
      { status: 302, headers: { location: 'https://cdn.example.org/pic' } },
      { status: 200, headers: { 'content-type': 'image/jpeg' }, chunks: [Buffer.from('redirected')] }
    ]
    const image = await fetchPublicArtifactImage('https://images.example.org/start')
    expect(Buffer.from(image.bytes).toString()).toBe('redirected')
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('gives the same generic refusal for an upstream error or non-image response', async () => {
    for (const reply of [
      { status: 503, headers: { 'content-type': 'image/png' } },
      { status: 200, headers: { 'content-type': 'text/html' } }
    ]) {
      replies = [reply]
      await expect(fetchPublicArtifactImage('https://images.example.org/pic')).rejects.toThrow('Unable to fetch shared image URL')
    }
  })

  it('refuses after the redirect limit without requesting another hop', async () => {
    replies = Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/next' } }))
    await expect(fetchPublicArtifactImage('https://images.example.org/start')).rejects.toThrow('Unable to fetch shared image URL')
    expect(requestMock).toHaveBeenCalledTimes(4)
  })

  it('demonstrates loopback was reachable by raw fetch but the guarded utility never contacts it', async () => {
    let hits = 0
    const server = createServer((_request, response) => {
      hits++
      response.setHeader('content-type', 'image/png')
      response.end('private')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const url = `http://127.0.0.1:${address.port}/private`
    try {
      const oldResponse = await fetch(url)
      expect(await oldResponse.text()).toBe('private')
      expect(hits).toBe(1)
      await expect(fetchPublicArtifactImage(url)).rejects.toThrow('Unable to fetch shared image URL')
      expect(hits).toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('caps streamed bytes even without Content-Length', async () => {
    replies = [{ status: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.alloc(10 * 1024 * 1024 + 1)] }]
    await expect(fetchPublicArtifactImage('https://images.example.org/pic')).rejects.toThrow('Unable to fetch shared image URL')
  })

  it('refuses an oversized Content-Length before reading response bytes', async () => {
    replies = [{
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) },
      chunks: [Buffer.from('small')]
    }]
    await expect(fetchPublicArtifactImage('https://images.example.org/pic')).rejects.toThrow('Unable to fetch shared image URL')
  })

  it('refuses a stalled DNS lookup at the total deadline', async () => {
    vi.useFakeTimers()
    lookupMock.mockImplementation(() => undefined)
    const pending = fetchPublicArtifactImage('https://images.example.org/pic')
    const refusal = expect(pending).rejects.toThrow('Unable to fetch shared image URL')
    await vi.advanceTimersByTimeAsync(10_001)
    await refusal
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('refuses a stalled response at the same total deadline', async () => {
    vi.useFakeTimers()
    replies = [{ status: 200, headers: { 'content-type': 'image/png' }, stall: true }]
    const pending = fetchPublicArtifactImage('https://images.example.org/pic')
    const refusal = expect(pending).rejects.toThrow('Unable to fetch shared image URL')
    await vi.advanceTimersByTimeAsync(10_001)
    await refusal
  })
})
