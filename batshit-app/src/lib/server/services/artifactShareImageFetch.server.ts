import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { IncomingMessage } from 'node:http'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // Matches the ordinary upload endpoint.
const MAX_REDIRECTS = 3
const TOTAL_TIMEOUT_MS = 10_000
const REFUSAL = 'Unable to fetch shared image URL'

export class ArtifactShareImageFetchError extends Error {
  constructor() {
    super(REFUSAL)
    this.name = 'ArtifactShareImageFetchError'
  }
}

function refused(): never {
  throw new ArtifactShareImageFetchError()
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c] = octets
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function isPublicAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family !== 6) return false
  // IPv4-mapped, translation, ULA, link-local and all other non-global IPv6
  // ranges are excluded by the global-unicast prefix requirement.
  const first = Number.parseInt(address.split(':')[0], 16)
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false
  if (first === 0x2002 || first === 0x3ffe || first === 0x3fff) return false // 6to4, deprecated and documentation
  if (first === 0x2001) {
    const second = Number.parseInt(address.split(':')[1] || '0', 16)
    if (second <= 0x01ff || second === 0x0db8) return false // protocol assignments and documentation
  }
  return true
}

function parsePublicUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return refused()
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return refused()
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const family = net.isIP(host)
  if (!host || host === 'localhost' || (!family && !host.includes('.')) || /\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) return refused()
  if (family && !isPublicAddress(host)) return refused()
  return url
}

type Address = { address: string; family: number }

async function assertPublicDns(host: string, signal: AbortSignal): Promise<void> {
  if (net.isIP(host)) return
  const answers = await abortable(dns.promises.lookup(host, { all: true, verbatim: true }), signal)
  if (!answers.length || answers.some((answer) => !isPublicAddress(answer.address))) refused()
}

function guardedLookup(host: string, options: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | Address[], family?: number) => void): void {
  dns.lookup(host, { ...options, all: true }, (error, result) => {
    const answers = Array.isArray(result) ? result : result ? [{ address: result as string, family: net.isIP(result as string) }] : []
    if (error || !answers.length || answers.some((answer) => !isPublicAddress(answer.address))) {
      callback(Object.assign(new Error(REFUSAL), { code: 'ECONNREFUSED' }), '')
      return
    }
    if (options.all) callback(null, answers)
    else callback(null, answers[0].address, answers[0].family)
  })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ArtifactShareImageFetchError())
    const onAbort = () => reject(new ArtifactShareImageFetchError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (reason) => { signal.removeEventListener('abort', onAbort); reject(reason) }
    )
  })
}

type HopResult = { redirect: string } | { bytes: Uint8Array; contentType: string }

function readHop(url: URL, signal: AbortSignal): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(url, {
      method: 'GET',
      agent: false,
      signal,
      lookup: guardedLookup as never,
      headers: { accept: 'image/*' }
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy()
        resolve({ redirect: response.headers.location })
        return
      }
      if (status < 200 || status >= 300) {
        response.destroy()
        reject(new ArtifactShareImageFetchError())
        return
      }
      const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!contentType.startsWith('image/')) {
        response.destroy()
        reject(new ArtifactShareImageFetchError())
        return
      }
      const declaredSize = Number(response.headers['content-length'])
      if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
        response.destroy()
        reject(new ArtifactShareImageFetchError())
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_IMAGE_BYTES) {
          response.destroy()
          reject(new ArtifactShareImageFetchError())
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks, size), contentType }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

/** Fetches a public image for artifact sharing without exposing target details on refusal. */
export async function fetchPublicArtifactImage(rawUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  try {
    let url = parsePublicUrl(rawUrl)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicDns(url.hostname.replace(/^\[|\]$/g, ''), controller.signal)
      const result = await abortable(readHop(url, controller.signal), controller.signal)
      if ('bytes' in result) return result
      if (hop === MAX_REDIRECTS) refused()
      url = parsePublicUrl(new URL(result.redirect, url).href)
    }
    return refused()
  } catch {
    return refused()
  } finally {
    clearTimeout(timer)
  }
}
