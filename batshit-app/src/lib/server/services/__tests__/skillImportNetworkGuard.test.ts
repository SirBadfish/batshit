import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookupAllMock = vi.fn()

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>()
  return {
    ...actual,
    default: {
      ...actual,
      lookup: (hostname: string, options: unknown, callback: unknown) =>
        (lookupAllMock as any)(hostname, options, callback),
      promises: {
        ...actual.promises,
        lookup: async (hostname: string) => {
          const result = await new Promise((resolve, reject) => {
            ;(lookupAllMock as any)(hostname, { all: true, verbatim: true }, (err: Error | null, addresses: unknown) => {
              if (err) reject(err)
              else resolve(addresses)
            })
          })
          return result
        }
      }
    }
  }
})

import {
  assertSafeRemoteImportUrl,
  guardedLookup,
  isBlockedAddress,
  SkillImportNetworkError
} from '../skillImportNetworkGuard'

function mockResolve(addresses: Array<{ address: string; family: number }>) {
  lookupAllMock.mockImplementation((_hostname, _options, callback) => {
    callback(null, addresses)
  })
}

beforeEach(() => {
  lookupAllMock.mockReset()
})

describe('isBlockedAddress', () => {
  const blockedV4 = [
    '0.0.0.0',
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '192.0.0.170',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255'
  ]
  for (const address of blockedV4) {
    it(`blocks ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(true)
    })
  }

  const allowedV4 = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '185.199.108.133']
  for (const address of allowedV4) {
    it(`allows ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false)
    })
  }

  const blockedV6 = [
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '64:ff9b::a00:1' // NAT64-prefixed private space
  ]
  for (const address of blockedV6) {
    it(`blocks ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(true)
    })
  }

  it('allows public IPv6', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
  })

  it('blocks unparseable input instead of failing open', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true)
    expect(isBlockedAddress('999.1.1.1')).toBe(true)
  })
})

describe('assertSafeRemoteImportUrl', () => {
  it('rejects non-https schemes', async () => {
    for (const url of [
      'http://example.com/skill',
      'file:///etc/passwd',
      'ftp://example.com/skill',
      'ssh://git@example.com/repo.git',
      'git://example.com/repo.git'
    ]) {
      await expect(assertSafeRemoteImportUrl(url)).rejects.toThrow(SkillImportNetworkError)
    }
  })

  it('rejects invalid URLs (incl. scp-style git@ sources)', async () => {
    await expect(assertSafeRemoteImportUrl('git@github.com:owner/repo.git')).rejects.toThrow(
      SkillImportNetworkError
    )
  })

  it('rejects local/internal hostnames without touching DNS', async () => {
    for (const url of [
      'https://localhost/skill',
      'https://foo.localhost/skill',
      'https://printer.local/skill',
      'https://metadata.internal/skill'
    ]) {
      await expect(assertSafeRemoteImportUrl(url)).rejects.toThrow(SkillImportNetworkError)
    }
    expect(lookupAllMock).not.toHaveBeenCalled()
  })

  it('rejects literal private/loopback/metadata IPs', async () => {
    for (const url of [
      'https://127.0.0.1:5600/api/v1/task/s',
      'https://10.0.0.8/skill',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]:6379/'
    ]) {
      await expect(assertSafeRemoteImportUrl(url)).rejects.toThrow(SkillImportNetworkError)
    }
  })

  it('rejects URLs with embedded credentials', async () => {
    await expect(assertSafeRemoteImportUrl('https://user:pass@example.com/skill')).rejects.toThrow(
      SkillImportNetworkError
    )
  })

  it('rejects hostnames whose DNS answers include a private address (rebind seed)', async () => {
    mockResolve([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ])
    await expect(assertSafeRemoteImportUrl('https://rebind.example.com/skill')).rejects.toThrow(
      /private\/internal address/
    )
  })

  it('rejects hostnames that do not resolve', async () => {
    lookupAllMock.mockImplementation((_hostname, _options, callback) => {
      callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), null)
    })
    await expect(assertSafeRemoteImportUrl('https://nxdomain.example.com/skill')).rejects.toThrow(
      /could not resolve/
    )
  })

  it('accepts a public https host', async () => {
    mockResolve([{ address: '185.199.108.133', family: 4 }])
    const parsed = await assertSafeRemoteImportUrl(
      'https://raw.githubusercontent.com/owner/repo/main/SKILL.md'
    )
    expect(parsed.hostname).toBe('raw.githubusercontent.com')
  })
})

describe('guardedLookup (connect-time rebinding defense)', () => {
  it('errors when any resolved address is blocked', async () => {
    mockResolve([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 }
    ])
    const result = await new Promise<{ err: Error | null }>((resolve) => {
      guardedLookup('rebind.example.com', {}, (err) => resolve({ err: err as Error | null }))
    })
    expect(result.err).toBeTruthy()
    expect(String(result.err)).toMatch(/Blocked private\/internal address/)
  })

  it('returns the first address for public hosts', async () => {
    mockResolve([{ address: '93.184.216.34', family: 4 }])
    const result = await new Promise<{ err: Error | null; address?: unknown; family?: unknown }>(
      (resolve) => {
        guardedLookup('example.com', {}, (err, address, family) =>
          resolve({ err: err as Error | null, address, family })
        )
      }
    )
    expect(result.err).toBeNull()
    expect(result.address).toBe('93.184.216.34')
    expect(result.family).toBe(4)
  })
})
