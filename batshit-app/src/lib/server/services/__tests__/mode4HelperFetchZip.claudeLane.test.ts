import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createZipFromContent } from '$lib/server/zipService'
import { fetchZipForModel } from '../fetchZipForModel'

const HELPER = path.join(process.cwd(), 'scripts', 'mode4-controls-mcp.cjs')
const owner = { userId: 'bl676-user', sessionId: 'bl676-claude-chat', agentId: 'bl676-agent', messageId: 'bl676-reply' }
let server: http.Server
let baseUrl: string
const guardPosts: string[] = []

useRedisTestServer()

beforeAll(async () => {
  // The controls route's agent-lane body around the real Fetch Zip record. The Claude lane
  // sends no byte budget; only the page kind, as `/api/controls/use` does for sys.zip.fetch.
  server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : null
      if (req.url === '/api/native-tools/guard-result') {
        guardPosts.push(String(body?.text ?? ''))
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'a Fetch Zip page reached the size guard' }))
        return
      }
      const result = await fetchZipForModel(owner, body?.input ?? {})
      res.writeHead(200, { 'Content-Type': 'application/json', 'x-batshit-tool-page-kind': 'fetch-zip' })
      res.end(JSON.stringify({
        auth: 'agent', userId: owner.userId, actingAgentId: owner.agentId, success: true,
        controlId: 'sys.zip.fetch', dryRun: false, riskLevel: 'safe', status: 'published', result
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

async function callHelper(args: Record<string, unknown>): Promise<string> {
  const child = spawn(
    process.execPath,
    [HELPER, `--agent=${owner.agentId}`, `--user=${owner.userId}`, `--url=${baseUrl}`, '--runtime=claude'],
    { env: { ...process.env, BATSHIT_AGENT_TOKEN: 'arc_testcredential.bsac_testsecret' }, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const done = new Promise<any>((resolve, reject) => {
    let buffer = ''
    // Decode across chunks: a character split between two chunks must not become U+FFFD.
    child.stdout.setEncoding('utf8')
    const timer = setTimeout(() => { child.kill(); reject(new Error('helper did not answer in time')) }, 20_000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        let message: any = null
        try { message = JSON.parse(line) } catch { continue }
        if (message?.id === 2) { clearTimeout(timer); child.kill(); resolve(message); return }
      }
    })
    child.on('error', reject)
  })
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }
  }) + '\n')
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'batshit_server_fetch_zip', arguments: args }
  }) + '\n')
  const response = await done
  return (response?.result?.content ?? []).map((part: any) => part.text ?? '').join('\n')
}

describe('BL-676: the managed Claude lane reads a large kept copy page by page', () => {
  it('fits each Fetch Zip page under the guard and follows true offsets to the end', async () => {
    await redis.createSession({ id: owner.sessionId, user_id: owner.userId, agent_id: owner.agentId, title: 'BL-676' } as any)
    const source = 'say "quoted" \\ line 漢字 😀\n'.repeat(12_000)
    const { zipId: ZIP_ID } = await createZipFromContent(source, 'tool_raw', owner.sessionId, 'earlier-reply', {
      userId: owner.userId, agentId: owner.agentId, retainedForSizeGuard: true
    })

    let offset = 0
    let seen = ''
    let pages = 0
    while (pages < 20) {
      const text = await callHelper({ zipId: ZIP_ID, offset, maxChars: 250_000 })
      pages += 1
      expect(Math.ceil(text.length / 4)).toBeLessThan(25_000)
      const page = JSON.parse(text)
      expect(page).toMatchObject({ success: true, tool: 'fetch_zip', offset })
      expect(page.content).toBe(source.slice(offset, offset + page.content.length))
      seen += page.content
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBe(offset + page.content.length)
      offset = page.nextOffset
    }
    expect(guardPosts).toEqual([])
    expect(pages).toBeGreaterThan(3)
    expect(seen).toBe(source)
  }, 120_000)
})
