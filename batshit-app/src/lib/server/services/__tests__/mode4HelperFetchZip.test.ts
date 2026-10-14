import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HELPER = path.join(process.cwd(), 'scripts', 'mode4-controls-mcp.cjs')
let server: http.Server
let baseUrl: string
const received: Array<{ url: string; body: any }> = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      received.push({ url: req.url ?? '', body })
      if (req.url === '/api/native-tools/guard-result') {
        // Codex sends even a small final MCP text through the authenticated guard.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, text: body.text }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json',
        'x-batshit-tool-text-max-bytes': '8000',
        'x-batshit-tool-text-budget-source': 'codex-fallback',
        ...(req.url === '/api/controls/use' ? { 'x-batshit-tool-page-kind': 'fetch-zip' } : {}) })
      res.end(JSON.stringify({
        success: true,
        result: {
          found: true, zipId: 'tool_raw_1790000000000_abcd', type: 'tool_raw',
          content: 'page two', contentLength: 200, offset: 64,
          nextOffset: 128, contentTruncated: true,
          readMore: 'Call Fetch Zip with offset 128.'
        }
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function askHelper(method: string, params: Record<string, unknown>): Promise<any> {
  received.length = 0
  const child = spawn(
    process.execPath,
    [HELPER, '--agent=agent-1', '--user=user-1', `--url=${baseUrl}`, '--runtime=codex'],
    {
      env: { ...process.env, BATSHIT_AGENT_TOKEN: 'arc_testcredential.bsac_testsecret' },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const done = new Promise<any>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('mode4 helper did not answer in time'))
    }, 15000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        let message: any = null
        try { message = JSON.parse(line) } catch { continue }
        if (message?.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolve(message)
          return
        }
      }
    })
    child.on('error', reject)
  })
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }
  }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n')
  return done
}

describe('managed helper Fetch Zip paging', () => {
  it('offers an offset and forwards it, then returns the next typed page', async () => {
    const listed = await askHelper('tools/list', {})
    expect(listed?.result?.tools?.length).toBeGreaterThan(0)
    for (const entry of listed.result.tools) {
      expect(entry?._meta?.['anthropic/maxResultSizeChars']).toBe(100_000)
    }
    const tool = (listed?.result?.tools ?? []).find((entry: any) => entry.name === 'batshit_server_fetch_zip')
    expect(tool?.inputSchema?.properties?.offset).toMatchObject({ type: 'integer', minimum: 0 })
    expect(tool?.inputSchema?.properties?.maxChars).toMatchObject({
      type: 'integer', minimum: 64, maximum: 250000
    })

    const response = await askHelper('tools/call', {
      name: 'batshit_server_fetch_zip',
      arguments: { zipId: 'tool_raw_1790000000000_abcd', offset: 64, maxChars: 64 }
    })
    const call = received.find((entry) => entry.url === '/api/controls/use')
    expect(call?.body?.input).toMatchObject({
      zipId: 'tool_raw_1790000000000_abcd', offset: 64, maxChars: 64
    })
    expect(received.find((entry) => entry.url === '/api/native-tools/guard-result')?.body)
      .toMatchObject({ originalTextChars: expect.any(Number), toolName: 'batshit_server_fetch_zip' })
    const output = (response?.result?.content ?? []).map((part: any) => part.text ?? '').join('\n')
    expect(output).toContain('nextOffset')
    expect(output).toContain('128')
    expect(output).toContain('Call Fetch Zip with offset 128.')
  }, 30000)
})
