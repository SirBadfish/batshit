import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'

/**
 * Network guard for remote skill imports (G-0232).
 *
 * Skill imports are agent-reachable through `sys.skill.import`, which makes
 * the import fetch a server-side request with agent-chosen targets. This
 * module enforces the remote-source contract:
 *
 * - https only (no http, file, ftp, ssh, git protocols)
 * - no loopback / private / link-local / CGNAT / metadata addresses, checked
 *   on literal IPs AND on every DNS answer
 * - the same validation re-runs inside the socket `lookup` at connect time,
 *   so a DNS answer cannot change between the pre-check and the connection
 *   (DNS-rebinding defense)
 * - redirects are followed manually and every hop is re-validated
 * - responses are size-capped
 *
 * Failures throw `SkillImportNetworkError` with a clear reason — a blocked
 * target is a loud security rejection, never a silent skip.
 */

export class SkillImportNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillImportNetworkError'
  }
}

const MAX_REDIRECT_HOPS = 3
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 // SKILL.md documents; 2MB is generous

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (!octets) return true // unparseable = blocked, never fail open
  const [a, b] = octets

  if (a === 0) return true // 0.0.0.0/8 ("this network")
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && octets[2] === 0) return true // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

function normalizeIpv6(address: string): string {
  // Strip zone index (fe80::1%en0) and brackets
  return address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
}

function isBlockedIpv6(address: string): boolean {
  const normalized = normalizeIpv6(address)

  if (normalized === '::' || normalized === '::1') return true // unspecified + loopback

  // IPv4-mapped/compatible forms carry the v4 rules
  const v4Match = normalized.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/)
  if (v4Match) return isBlockedIpv4(v4Match[1])
  if (normalized.startsWith('::ffff:')) return true // mapped form we couldn't parse

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true // ULA fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true // link-local fe80::/10
  if (normalized.startsWith('ff')) return true // multicast
  if (normalized.startsWith('64:ff9b')) return true // NAT64 of v4 space
  return false
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return true // not an IP literal = blocked here; hostnames resolve first
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!normalized) return true
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized.endsWith('.local')) return true // mDNS LAN names
  if (normalized.endsWith('.internal')) return true // common cloud-internal zones
  return false
}

async function resolveAndAssertAddresses(hostname: string, label: string): Promise<void> {
  let answers: Array<{ address: string }>
  try {
    answers = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new SkillImportNetworkError(
      `${label}: could not resolve host "${hostname}". Check the URL and your network.`
    )
  }
  if (!answers.length) {
    throw new SkillImportNetworkError(`${label}: host "${hostname}" did not resolve to any address.`)
  }
  for (const answer of answers) {
    if (isBlockedAddress(answer.address)) {
      throw new SkillImportNetworkError(
        `${label}: host "${hostname}" resolves to a private/internal address (${answer.address}). Remote skill imports only allow public https sources.`
      )
    }
  }
}

/**
 * Validates a remote import URL: https-only, public host. Resolves DNS and
 * rejects if ANY answer lands in a blocked range. Returns the parsed URL.
 */
export async function assertSafeRemoteImportUrl(rawUrl: string, label = 'Skill import'): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new SkillImportNetworkError(`${label}: "${rawUrl}" is not a valid URL.`)
  }

  if (parsed.protocol !== 'https:') {
    throw new SkillImportNetworkError(
      `${label}: only https URLs can be imported (got "${parsed.protocol}//"). For ssh/private-repo sources, clone locally and use a local-folder import.`
    )
  }

  if (parsed.username || parsed.password) {
    throw new SkillImportNetworkError(`${label}: URLs with embedded credentials are not allowed.`)
  }

  const hostname = parsed.hostname
  if (isBlockedHostname(hostname)) {
    throw new SkillImportNetworkError(
      `${label}: host "${hostname}" is a local/internal name. Remote skill imports only allow public https sources.`
    )
  }

  if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
    if (isBlockedAddress(hostname.replace(/^\[|\]$/g, ''))) {
      throw new SkillImportNetworkError(
        `${label}: "${hostname}" is a private/internal address. Remote skill imports only allow public https sources.`
      )
    }
    return parsed
  }

  await resolveAndAssertAddresses(hostname, label)
  return parsed
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void

/**
 * Socket-level lookup that re-validates every DNS answer at connect time.
 * This closes the rebinding window between the pre-check and the connection.
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', undefined)
      return
    }
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses as string, family: 4 }]
    if (!list.length) {
      callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), '', undefined)
      return
    }
    const blocked = list.find((entry) => isBlockedAddress(entry.address))
    if (blocked) {
      callback(
        Object.assign(
          new Error(
            `Blocked private/internal address for ${hostname} (${blocked.address}) during skill import`
          ),
          { code: 'ECONNREFUSED' }
        ),
        '',
        undefined
      )
      return
    }
    if (options.all) {
      callback(null, list)
      return
    }
    callback(null, list[0].address, list[0].family)
  })
}

function performGuardedGet(
  url: URL,
  timeoutMs: number
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup as never,
        headers: { 'user-agent': 'batshit-skill-import' }
      },
      (response) => {
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > MAX_RESPONSE_BYTES) {
            request.destroy(
              new SkillImportNetworkError(
                `Skill import response exceeded the ${Math.floor(MAX_RESPONSE_BYTES / (1024 * 1024))}MB limit.`
              )
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
        response.on('error', reject)
      }
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new SkillImportNetworkError('Skill import request timed out.'))
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Guarded GET for remote skill markdown. Validates the URL and every redirect
 * hop; returns null for ordinary fetch misses (non-2xx, empty body) so the
 * caller's candidate loop can continue, and THROWS SkillImportNetworkError for
 * blocked targets so security rejections surface loudly.
 */
export async function guardedFetchText(
  rawUrl: string,
  timeoutMs: number
): Promise<{ text: string; contentType: string } | null> {
  let current = await assertSafeRemoteImportUrl(rawUrl)

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    let result: Awaited<ReturnType<typeof performGuardedGet>>
    try {
      result = await performGuardedGet(current, timeoutMs)
    } catch (error) {
      if (error instanceof SkillImportNetworkError) throw error
      const message = error instanceof Error ? error.message : ''
      if (message.includes('Blocked private/internal address')) {
        throw new SkillImportNetworkError(message)
      }
      return null
    }

    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      const location = result.headers.location
      const locationValue = Array.isArray(location) ? location[0] : location
      if (!locationValue) return null
      if (hop === MAX_REDIRECT_HOPS) {
        throw new SkillImportNetworkError('Skill import followed too many redirects.')
      }
      current = await assertSafeRemoteImportUrl(new URL(locationValue, current).toString())
      continue
    }

    if (result.statusCode < 200 || result.statusCode >= 300) return null
    if (!result.body.trim()) return null

    const contentTypeHeader = result.headers['content-type']
    return {
      text: result.body,
      contentType: Array.isArray(contentTypeHeader) ? contentTypeHeader[0] || '' : contentTypeHeader || ''
    }
  }

  return null
}
