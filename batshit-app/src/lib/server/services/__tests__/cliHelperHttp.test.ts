import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * BL-318 review — the controls helper's HTTP client lets a call last as long as the helper waits.
 *
 * Node's built-in fetch (undici's default Agent) gives up on a response whose headers take more
 * than 300 s, and `/api/controls/use` answers only when the run ends, so a 10-minute Pinokio
 * artifact run was cut at 5:00 whatever the helper's wait said. `createHelperFetch` sets the
 * connection limits itself. Here the limits are lowered to fit a test: a stand-in server holds
 * its answer 1.5 s, past a 0.5 s limit and inside a 3 s one.
 */

const require = createRequire(import.meta.url)
const scripts = path.join(process.cwd(), 'scripts')
const { createHelperFetch } = require(path.join(scripts, 'lib', 'cli-helper-http.cjs')) as {
  createHelperFetch: (timeoutMs: number) => (url: string, init?: RequestInit) => Promise<Response>
}
const waits = require(path.join(scripts, 'lib', 'cli-helper-waits.cjs')) as {
  CLI_HELPER_LONGEST_WAIT_MS: number
  CLI_HELPER_HTTP_TIMEOUT_MS: number
}

const HOLD_MS = 1500
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, held: HOLD_MS }))
      }, HOLD_MS)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("BL-318 review: the helper's HTTP client", () => {
  it('waits for an answer held past a lower limit when its own limit is longer', async () => {
    const fetchFn = createHelperFetch(3000)
    const response = await fetchFn(`${baseUrl}/api/controls/use`, { method: 'POST', body: '{}' })
    expect(await response.json()).toEqual({ success: true, held: HOLD_MS })
  })

  it('is cut by its own limit, not by a fixed default: the limit is what decides', async () => {
    const fetchFn = createHelperFetch(500)
    const started = Date.now()
    const failure = await fetchFn(`${baseUrl}/api/controls/use`, { method: 'POST', body: '{}' }).catch(
      (error: any) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure?.cause?.code ?? failure?.cause?.name ?? '')).toMatch(/HEADERS_TIMEOUT|HeadersTimeout/i)
    expect(Date.now() - started).toBeLessThan(HOLD_MS)
  })

  it('the helper builds its fetch with limits past its longest wait, never the built-in fetch', async () => {
    const source = await readFile(path.join(scripts, 'mode4-controls-mcp.cjs'), 'utf8')
    expect(source).toContain('const fetchFn = createHelperFetch(CLI_HELPER_HTTP_TIMEOUT_MS)')
    expect(source).not.toMatch(/globalThis\.fetch/)
    expect(waits.CLI_HELPER_HTTP_TIMEOUT_MS).toBeGreaterThan(waits.CLI_HELPER_LONGEST_WAIT_MS)
    // Past undici's 300 s default, which is the limit this replaces.
    expect(waits.CLI_HELPER_HTTP_TIMEOUT_MS).toBeGreaterThan(300_000)
  })
})
